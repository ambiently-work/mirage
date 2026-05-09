/**
 * `GitBackend` implementation backed by `wasm-git` (libgit2 compiled to WASM).
 *
 * Strategy: wasm-git ships the libgit2 CLI in a single ~3 MiB WASM module
 * with its own emscripten MEMFS. There's no FS injection point, so each
 * operation does a "sync-in / run / sync-out" cycle:
 *
 *   1. Mirror the mirage `dir` + `.git` tree into MEMFS at a sandbox path.
 *   2. `chdir` and call `lg2(args)`.
 *   3. Parse stdout (where relevant).
 *   4. Mirror the affected MEMFS subtree back to the mirage.
 *
 * That cycle adds latency. For interactive `status` calls on a hot path,
 * prefer `IsoGitBackend`. This backend is here for libgit2-only behavior
 * (e.g. specific merge strategies, future signing) and as a swappable
 * second engine that proves the backend interface is real.
 *
 * Currently implemented: init / add / commit / log / status / branch /
 * listBranches / currentBranch / checkout / resolveRef / diff committed
 * trees / listRemotes / addRemote / readBlob.
 *
 * Not yet implemented (throws): clone, push, pull. Clone/push/pull
 * need wasm-git's HTTP transport hooked up against a CORS-friendly server
 * which is out of scope for v1. Diff compares loose git objects directly
 * because the current wasm-git CLI build does not expose raw diff-tree output.
 */

import { decodeUtf8, encodeUtf8 } from "../node.js";
import type { IFileSystem } from "../types.js";
import {
	parseCommitTree,
	parseTreeEntries,
	readBlobFromObjectStore,
	readGitObject,
} from "./objects.js";
import type {
	AddOptions,
	BackendContext,
	BranchOptions,
	CheckoutOptions,
	CloneOptions,
	CommitInfo,
	CommitOptions,
	DiffEntry,
	DiffOptions,
	GitBackend,
	GitIdentity,
	InitOptions,
	LogOptions,
	PullOptions,
	PushOptions,
	StatusRow,
} from "./types.js";

interface EmFs {
	mkdir(path: string): void;
	writeFile(path: string, data: Uint8Array | string): void;
	readFile(path: string, opts?: { encoding?: "utf8" | "binary" }): Uint8Array | string;
	readdir(path: string): string[];
	stat(path: string): { mode: number; size: number; mtime: { getTime(): number } };
	unlink(path: string): void;
	rmdir(path: string): void;
	chdir(path: string): void;
	symlink(target: string, path: string): void;
	readlink(path: string): string;
	analyzePath(path: string): { exists: boolean; object?: { mode: number } };
}

interface Lg2Module {
	FS: EmFs;
	callMain(args: string[]): number;
	callWithOutput?(args: string[]): string;
	print?: (msg: string) => void;
	printErr?: (msg: string) => void;
}

type Lg2Loader = (overrides?: Record<string, unknown>) => Promise<Lg2Module>;

const SANDBOX = "/mirage-work";

export interface LibGit2BackendOptions {
	/**
	 * Override the wasm-git module loader. Defaults to dynamically importing
	 * `wasm-git/lg2_async.js`. Supply your own to swap to `lg2.js` (sync,
	 * needs a worker) or `lg2_opfs.js` (OPFS-backed) builds.
	 */
	loader?: Lg2Loader;
}

export class LibGit2Backend implements GitBackend {
	readonly name = "libgit2-wasm" as const;
	private modulePromise?: Promise<Lg2Module>;
	private readonly loader: Lg2Loader;

	constructor(options?: LibGit2BackendOptions) {
		this.loader = options?.loader ?? defaultLoader;
	}

	async init(ctx: BackendContext, opts?: InitOptions): Promise<void> {
		const branch = opts?.defaultBranch ?? "main";
		await this.run(
			ctx,
			async (lg) => {
				expectExit(lg, ["init", "."]);
				// libgit2's `init` example doesn't take `--initial-branch`, so we
				// rewrite HEAD ourselves to honour the requested default.
				lg.FS.writeFile(".git/HEAD", `ref: refs/heads/${branch}\n`);
			},
			{ skipSyncIn: true },
		);
	}

	async clone(_ctx: BackendContext, _opts: CloneOptions): Promise<void> {
		throw new Error("LibGit2Backend.clone is not implemented in v1 — use IsoGitBackend for clone");
	}

	async status(ctx: BackendContext): Promise<StatusRow[]> {
		return this.run(ctx, async (lg) => {
			const out = captureOutput(lg, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
			return parsePorcelainV2(out);
		});
	}

	async add(ctx: BackendContext, opts: AddOptions): Promise<void> {
		await this.run(ctx, async (lg) => {
			const args = ["add"];
			if (opts.force) args.push("--force");
			args.push(...opts.filepaths);
			expectExit(lg, args);
		});
	}

	async commit(ctx: BackendContext, opts: CommitOptions): Promise<string> {
		return this.run(ctx, async (lg) => {
			const author = opts.author;
			if (!author) throw new Error("commit: author required");
			writeGitconfig(lg, author);
			const args = ["commit", "-m", opts.message];
			if (opts.amend) args.push("--amend");
			expectExit(lg, args);
			return captureOutput(lg, ["rev-parse", "HEAD"]).trim();
		});
	}

	async log(ctx: BackendContext, opts?: LogOptions): Promise<CommitInfo[]> {
		return this.run(ctx, async (lg) => {
			const args = [
				"log",
				"--pretty=format:%H%x00%T%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%B%x1e",
			];
			if (opts?.depth !== undefined) args.push(`-n${opts.depth}`);
			if (opts?.ref) args.push(opts.ref);
			if (opts?.filepath) args.push("--", opts.filepath);
			const out = captureOutput(lg, args);
			return parseLogOutput(out);
		});
	}

	async branch(ctx: BackendContext, opts: BranchOptions): Promise<void> {
		await this.run(ctx, async (lg) => {
			if (opts.checkout) {
				expectExit(lg, opts.force ? ["checkout", "-B", opts.ref] : ["checkout", "-b", opts.ref]);
			} else {
				expectExit(lg, opts.force ? ["branch", "-f", opts.ref] : ["branch", opts.ref]);
			}
		});
	}

	async listBranches(ctx: BackendContext): Promise<string[]> {
		return this.run(ctx, async (lg) => {
			const out = captureOutput(lg, ["branch", "--list", "--format=%(refname:short)"]);
			return out
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean);
		});
	}

	async currentBranch(ctx: BackendContext): Promise<string | undefined> {
		return this.run(ctx, async (lg) => {
			const out = captureOutput(lg, ["symbolic-ref", "--short", "HEAD"]).trim();
			return out || undefined;
		});
	}

	async checkout(ctx: BackendContext, opts: CheckoutOptions): Promise<void> {
		await this.run(ctx, async (lg) => {
			const args = ["checkout"];
			if (opts.force) args.push("--force");
			args.push(opts.ref);
			if (opts.filepaths?.length) args.push("--", ...opts.filepaths);
			expectExit(lg, args);
		});
	}

	async resolveRef(ctx: BackendContext, ref: string): Promise<string> {
		return this.run(ctx, async (lg) => {
			return captureOutput(lg, ["rev-parse", ref]).trim();
		});
	}

	async readBlob(ctx: BackendContext, oid: string, filepath?: string): Promise<Uint8Array> {
		const gitFs = typeof ctx.gitdir === "string" ? ctx.fs : ctx.gitdir;
		const gitdir = typeof ctx.gitdir === "string" ? ctx.gitdir : "/";
		return readBlobFromObjectStore(gitFs, gitdir, oid, filepath);
	}

	async diff(ctx: BackendContext, opts?: DiffOptions): Promise<DiffEntry[]> {
		if (!opts?.b) {
			const aOid = await this.resolveRefOrEmpty(ctx, opts?.a ?? "HEAD");
			return diffTreeToWorkingTree(ctx, aOid);
		}
		const a = opts.a ?? "HEAD";
		const aOid = await this.resolveRef(ctx, a);
		const bOid = await this.resolveRef(ctx, opts.b);
		return diffLooseCommittedTrees(ctx, aOid, bOid);
	}

	private async resolveRefOrEmpty(ctx: BackendContext, ref: string): Promise<string | null> {
		if (ref === "HEAD") return resolveHeadOid(ctx);
		return this.resolveRef(ctx, ref);
	}

	async push(_ctx: BackendContext, _opts: PushOptions): Promise<void> {
		throw new Error("LibGit2Backend.push is not implemented in v1 — use IsoGitBackend.push");
	}

	async pull(_ctx: BackendContext, _opts: PullOptions): Promise<void> {
		throw new Error("LibGit2Backend.pull is not implemented in v1 — use IsoGitBackend.pull");
	}

	async listRemotes(ctx: BackendContext): Promise<{ remote: string; url: string }[]> {
		// libgit2's `remote` example only supports `remote add`. Parse
		// `.git/config` directly from the mirage instead.
		const cfgFs = typeof ctx.gitdir === "string" ? ctx.fs : ctx.gitdir;
		const cfgPath = typeof ctx.gitdir === "string" ? `${ctx.gitdir}/config` : "/config";
		if (!cfgFs.exists(cfgPath)) return [];
		const text = decodeUtf8(cfgFs.readFileBytes(cfgPath));
		return parseRemotesFromConfig(text);
	}

	async addRemote(ctx: BackendContext, remote: string, url: string): Promise<void> {
		await this.run(ctx, async (lg) => {
			expectExit(lg, ["remote", "add", remote, url]);
		});
	}

	private async getModule(): Promise<Lg2Module> {
		if (!this.modulePromise) {
			this.modulePromise = this.loader();
		}
		return this.modulePromise;
	}

	private async run<T>(
		ctx: BackendContext,
		fn: (lg: Lg2Module) => Promise<T> | T,
		options?: { skipSyncIn?: boolean },
	): Promise<T> {
		const lg = await this.getModule();
		resetSandbox(lg);
		if (!options?.skipSyncIn) syncIntoSandbox(lg, ctx);
		lg.FS.chdir(SANDBOX);
		try {
			const result = await fn(lg);
			syncOutOfSandbox(lg, ctx);
			return result;
		} catch (err) {
			// Even on failure, try to sync state back so partial mutations are visible.
			try {
				syncOutOfSandbox(lg, ctx);
			} catch {}
			throw err;
		}
	}
}

const defaultLoader: Lg2Loader = async (overrides) => {
	// Dynamic import keeps wasm-git out of the module graph until the user
	// actually instantiates a LibGit2Backend.
	const mod = (await import("wasm-git/lg2_async.js")) as unknown as {
		default: (m?: Record<string, unknown>) => Promise<Lg2Module>;
	};
	return mod.default(overrides);
};

function resetSandbox(lg: Lg2Module): void {
	// Step out of cwd before nuking the sandbox — emscripten FS refuses to
	// rmdir() the current working directory (returns EBUSY).
	try {
		lg.FS.chdir("/");
	} catch {
		// no-op
	}
	const exists = lg.FS.analyzePath(SANDBOX).exists;
	if (exists) rmrf(lg.FS, SANDBOX);
	lg.FS.mkdir(SANDBOX);
}

function rmrf(fs: EmFs, path: string): void {
	const info = fs.analyzePath(path);
	if (!info.exists) return;
	const mode = info.object?.mode ?? 0;
	const isDir = (mode & 0o170000) === 0o040000;
	if (isDir) {
		for (const name of fs.readdir(path)) {
			if (name === "." || name === "..") continue;
			rmrf(fs, joinPath(path, name));
		}
		fs.rmdir(path);
	} else {
		fs.unlink(path);
	}
}

function syncIntoSandbox(lg: Lg2Module, ctx: BackendContext): void {
	const sidecar = typeof ctx.gitdir !== "string";
	// Working tree (skip `.git` entirely when running in sidecar mode — the
	// gitdir lives in a separate FS and gets copied below).
	syncDirIn(lg, ctx.fs, ctx.dir, SANDBOX, sidecar ? new Set([".git"]) : undefined);
	if (sidecar) {
		const gitTarget = joinPath(SANDBOX, ".git");
		if (!lg.FS.analyzePath(gitTarget).exists) lg.FS.mkdir(gitTarget);
		syncDirIn(lg, ctx.gitdir as IFileSystem, "/", gitTarget);
	}
}

function syncOutOfSandbox(lg: Lg2Module, ctx: BackendContext): void {
	const sidecar = typeof ctx.gitdir !== "string";
	syncDirOut(lg, SANDBOX, ctx.fs, ctx.dir, sidecar ? new Set([".git"]) : undefined);
	if (sidecar) {
		const gitSource = joinPath(SANDBOX, ".git");
		if (lg.FS.analyzePath(gitSource).exists) {
			syncDirOut(lg, gitSource, ctx.gitdir as IFileSystem, "/");
		}
	}
}

function syncDirIn(
	lg: Lg2Module,
	fs: IFileSystem,
	fsPath: string,
	emPath: string,
	skip?: Set<string>,
): void {
	if (!fs.exists(fsPath)) return;
	const stat = fs.stat(fsPath);
	if (!stat.isDirectory()) return;

	for (const name of fs.readDir(fsPath)) {
		if (skip?.has(name)) continue;
		const childFs = fsPath === "/" ? `/${name}` : `${fsPath}/${name}`;
		const childEm = joinPath(emPath, name);
		const childStat = fs.lstat(childFs);
		if (childStat.isDirectory()) {
			if (!lg.FS.analyzePath(childEm).exists) lg.FS.mkdir(childEm);
			syncDirIn(lg, fs, childFs, childEm);
		} else if (childStat.isSymlink()) {
			lg.FS.symlink(fs.readlink(childFs), childEm);
		} else if (childStat.isFile()) {
			lg.FS.writeFile(childEm, fs.readFileBytes(childFs));
		}
	}
}

function syncDirOut(
	lg: Lg2Module,
	emPath: string,
	fs: IFileSystem,
	fsPath: string,
	skip?: Set<string>,
): void {
	const info = lg.FS.analyzePath(emPath);
	if (!info.exists) return;

	if (!fs.exists(fsPath)) fs.mkdir(fsPath, { recursive: true });
	else if (!fs.stat(fsPath).isDirectory()) {
		fs.rm(fsPath, { recursive: true, force: true });
		fs.mkdir(fsPath, { recursive: true });
	}

	const emEntries = new Set(lg.FS.readdir(emPath).filter((n: string) => n !== "." && n !== ".."));

	// Add/update everything in MEMFS (except skipped names).
	for (const name of emEntries) {
		if (skip?.has(name)) continue;
		const childEm = joinPath(emPath, name);
		const childFs = fsPath === "/" ? `/${name}` : `${fsPath}/${name}`;
		const childInfo = lg.FS.analyzePath(childEm);
		if (!childInfo.exists) continue;
		const mode = childInfo.object?.mode ?? 0;
		const isDir = (mode & 0o170000) === 0o040000;
		const isLink = (mode & 0o170000) === 0o120000;
		if (isLink) {
			const target = lg.FS.readlink(childEm);
			if (fs.exists(childFs)) fs.rm(childFs, { force: true });
			fs.symlink(target, childFs);
		} else if (isDir) {
			syncDirOut(lg, childEm, fs, childFs);
		} else {
			const data = lg.FS.readFile(childEm) as Uint8Array;
			fs.writeFileBytes(childFs, data);
		}
	}

	// Drop entries in mirage that are no longer in MEMFS (but never delete a
	// skipped name — we deliberately stayed off it on the sync-in side too).
	for (const name of fs.readDir(fsPath)) {
		if (skip?.has(name)) continue;
		if (emEntries.has(name)) continue;
		const childFs = fsPath === "/" ? `/${name}` : `${fsPath}/${name}`;
		fs.rm(childFs, { recursive: true, force: true });
	}
}

function writeGitconfig(lg: Lg2Module, author: GitIdentity): void {
	const home = "/home/web_user";
	tryMkdir(lg, "/home");
	tryMkdir(lg, home);
	const config = `[user]\n  name = ${author.name}\n  email = ${author.email}\n[init]\n  defaultBranch = main\n`;
	lg.FS.writeFile(`${home}/.gitconfig`, config);
}

function tryMkdir(lg: Lg2Module, path: string): void {
	if (lg.FS.analyzePath(path).exists) return;
	try {
		lg.FS.mkdir(path);
	} catch {
		// EEXIST race or readonly volume — ignore.
	}
}

function captureOutput(lg: Lg2Module, args: string[]): string {
	if (lg.callWithOutput) {
		try {
			return lg.callWithOutput(args);
		} catch (err) {
			throw new Error(`libgit2 ${args.join(" ")}: ${(err as Error).message ?? err}`);
		}
	}
	// Fallback: install hooks ourselves.
	const out: string[] = [];
	const err: string[] = [];
	const origPrint = lg.print;
	const origPrintErr = lg.printErr;
	lg.print = (msg) => {
		out.push(msg);
	};
	lg.printErr = (msg) => {
		err.push(msg);
	};
	try {
		const code = lg.callMain(args);
		if (code !== 0) {
			const detail = err.length ? `: ${err.join("\n")}` : "";
			throw new Error(`libgit2 ${args[0]} exited ${code}${detail}`);
		}
		return out.join("\n");
	} finally {
		lg.print = origPrint;
		lg.printErr = origPrintErr;
	}
}

function expectExit(lg: Lg2Module, args: string[]): void {
	const code = lg.callMain(args);
	if (code !== 0) {
		throw new Error(`libgit2 ${args[0]} exited ${code}`);
	}
}

function joinPath(a: string, b: string): string {
	if (a.endsWith("/")) return a + b;
	return `${a}/${b}`;
}

function parseRemotesFromConfig(config: string): { remote: string; url: string }[] {
	const out: { remote: string; url: string }[] = [];
	let current: string | undefined;
	for (const rawLine of config.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		const sectionMatch = line.match(/^\[remote\s+"([^"]+)"\]$/);
		if (sectionMatch) {
			current = sectionMatch[1] as string;
			continue;
		}
		if (line.startsWith("[")) {
			current = undefined;
			continue;
		}
		if (!current) continue;
		const kv = line.match(/^url\s*=\s*(.+)$/);
		if (kv) out.push({ remote: current, url: kv[1] as string });
	}
	return out;
}

function resolveHeadOid(ctx: BackendContext): string | null {
	const gitFs = typeof ctx.gitdir === "string" ? ctx.fs : ctx.gitdir;
	const gitdir = typeof ctx.gitdir === "string" ? ctx.gitdir : "/";
	const headPath = joinPath(gitdir, "HEAD");
	if (!gitFs.exists(headPath)) return null;
	const head = gitFs.readFile(headPath).trim();
	const refMatch = /^ref:\s*(.+)$/.exec(head);
	if (!refMatch) return /^[0-9a-f]{40}$/i.test(head) ? head.toLowerCase() : null;
	const refPath = joinPath(gitdir, refMatch[1] as string);
	return gitFs.exists(refPath) ? gitFs.readFile(refPath).trim().toLowerCase() : null;
}

async function diffLooseCommittedTrees(
	ctx: BackendContext,
	aOid: string,
	bOid: string,
): Promise<DiffEntry[]> {
	const gitFs = typeof ctx.gitdir === "string" ? ctx.fs : ctx.gitdir;
	const gitdir = typeof ctx.gitdir === "string" ? ctx.gitdir : "/";
	const aTree = await resolveTreeOid(gitFs, gitdir, aOid);
	const bTree = await resolveTreeOid(gitFs, gitdir, bOid);
	const [aEntries, bEntries] = await Promise.all([
		flattenTree(gitFs, gitdir, aTree),
		flattenTree(gitFs, gitdir, bTree),
	]);
	return diffFlattenedEntries(aEntries, bEntries);
}

async function diffTreeToWorkingTree(
	ctx: BackendContext,
	aOid: string | null,
): Promise<DiffEntry[]> {
	const gitFs = typeof ctx.gitdir === "string" ? ctx.fs : ctx.gitdir;
	const gitdir = typeof ctx.gitdir === "string" ? ctx.gitdir : "/";
	const aEntries = aOid
		? await flattenTree(gitFs, gitdir, await resolveTreeOid(gitFs, gitdir, aOid))
		: new Map<string, { oid: string }>();
	const bEntries = await flattenWorkingTree(ctx.fs, ctx.dir);
	return diffFlattenedEntries(aEntries, bEntries);
}

function diffFlattenedEntries(
	aEntries: Map<string, { oid: string }>,
	bEntries: Map<string, { oid: string }>,
): DiffEntry[] {
	const paths = new Set([...aEntries.keys(), ...bEntries.keys()]);
	return Array.from(paths)
		.sort()
		.flatMap((path) => {
			const aEntry = aEntries.get(path);
			const bEntry = bEntries.get(path);
			if (aEntry?.oid === bEntry?.oid) return [];
			return [
				{
					path,
					added: !aEntry && !!bEntry,
					removed: !!aEntry && !bEntry,
					aOid: aEntry?.oid ?? null,
					bOid: bEntry?.oid ?? null,
				},
			];
		});
}

async function resolveTreeOid(fs: IFileSystem, gitdir: string, oid: string): Promise<string> {
	const object = await readGitObject(fs, gitdir, oid);
	if (object.type === "commit") return parseCommitTree(object.body);
	if (object.type === "tree") return oid;
	throw new Error(`Git object ${oid} is a ${object.type}, not a commit or tree`);
}

async function flattenTree(
	fs: IFileSystem,
	gitdir: string,
	treeOid: string,
	prefix = "",
): Promise<Map<string, { oid: string }>> {
	const object = await readGitObject(fs, gitdir, treeOid);
	if (object.type !== "tree")
		throw new Error(`Git object ${treeOid} is a ${object.type}, not a tree`);
	const out = new Map<string, { oid: string }>();
	for (const entry of parseTreeEntries(object.body)) {
		const path = prefix ? `${prefix}/${entry.path}` : entry.path;
		if (entry.mode === "40000" || entry.mode === "040000") {
			for (const [childPath, childEntry] of await flattenTree(fs, gitdir, entry.oid, path)) {
				out.set(childPath, childEntry);
			}
		} else {
			out.set(path, { oid: entry.oid });
		}
	}
	return out;
}

async function flattenWorkingTree(
	fs: IFileSystem,
	root: string,
	dir: string = root,
	prefix = "",
): Promise<Map<string, { oid: string }>> {
	const out = new Map<string, { oid: string }>();
	for (const name of fs.readDir(dir)) {
		if (!prefix && name === ".git") continue;
		const path = joinPath(dir, name);
		const rel = prefix ? `${prefix}/${name}` : name;
		const stat = fs.lstat(path);
		if (stat.isDirectory()) {
			for (const [childPath, childEntry] of await flattenWorkingTree(fs, root, path, rel)) {
				out.set(childPath, childEntry);
			}
			continue;
		}
		if (stat.isFile()) {
			out.set(rel, { oid: await hashGitBlob(fs.readFileBytes(path)) });
			continue;
		}
		if (stat.isSymlink()) {
			out.set(rel, { oid: await hashGitBlob(encodeUtf8(fs.readlink(path))) });
		}
	}
	return out;
}

async function hashGitBlob(body: Uint8Array): Promise<string> {
	const header = encodeUtf8(`blob ${body.byteLength}\0`);
	const payload = new Uint8Array(header.byteLength + body.byteLength);
	payload.set(header);
	payload.set(body, header.byteLength);
	const digest = await crypto.subtle.digest("SHA-1", payload);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseRawDiffTreeOutput(out: string): DiffEntry[] {
	if (!out) return [];
	return out.includes("\0") ? parseNulRawDiffTreeOutput(out) : parseLineRawDiffTreeOutput(out);
}

function parseNulRawDiffTreeOutput(out: string): DiffEntry[] {
	const entries: DiffEntry[] = [];
	const fields = out.split("\0");
	for (let i = 0; i < fields.length; ) {
		const header = fields[i++]?.trim();
		if (!header) continue;
		const parsed = parseRawDiffHeader(header);
		if (!parsed) continue;
		const firstPath = fields[i++] ?? "";
		const secondPath = parsed.needsTwoPaths ? (fields[i++] ?? "") : undefined;
		entries.push(rawDiffEntry(parsed, secondPath ?? firstPath));
	}
	return entries;
}

function parseLineRawDiffTreeOutput(out: string): DiffEntry[] {
	const entries: DiffEntry[] = [];
	for (const rawLine of out.split("\n")) {
		const line = rawLine.trimEnd();
		if (!line) continue;
		const tab = line.indexOf("\t");
		if (tab === -1) continue;
		const parsed = parseRawDiffHeader(line.slice(0, tab));
		if (!parsed) continue;
		const paths = line.slice(tab + 1).split("\t");
		entries.push(
			rawDiffEntry(parsed, parsed.needsTwoPaths ? (paths[1] ?? paths[0] ?? "") : (paths[0] ?? "")),
		);
	}
	return entries;
}

function parseRawDiffHeader(
	header: string,
):
	| { status: string; aOid: string | null; bOid: string | null; needsTwoPaths: boolean }
	| undefined {
	const match = header.match(/^:\d{6} \d{6} ([0-9a-fA-F]+) ([0-9a-fA-F]+) ([A-Z][0-9]*)$/);
	if (!match) return undefined;
	const [, rawAOid, rawBOid, status] = match as [string, string, string, string];
	return {
		status,
		aOid: zeroOidToNull(rawAOid),
		bOid: zeroOidToNull(rawBOid),
		needsTwoPaths: status.startsWith("R") || status.startsWith("C"),
	};
}

function rawDiffEntry(
	parsed: { status: string; aOid: string | null; bOid: string | null },
	path: string,
): DiffEntry {
	const kind = parsed.status[0];
	return {
		path,
		added: kind === "A",
		removed: kind === "D",
		aOid: parsed.aOid,
		bOid: parsed.bOid,
	};
}

function zeroOidToNull(oid: string): string | null {
	return /^0+$/.test(oid) ? null : oid.toLowerCase();
}

function parsePorcelainV2(out: string): StatusRow[] {
	const rows: StatusRow[] = [];
	const records = out.split("\0").filter(Boolean);
	for (const rec of records) {
		// Skip header lines (start with '#').
		if (rec.startsWith("#")) continue;
		// Format prefixes: "1 XY" (changed), "2 XY" (renamed), "u XY" (unmerged), "? path" (untracked), "! path" (ignored)
		if (rec.startsWith("? ")) {
			const path = rec.slice(2);
			rows.push([path, 0, 2, 0]);
			continue;
		}
		if (rec.startsWith("! ")) continue;
		if (rec.startsWith("1 ") || rec.startsWith("2 ")) {
			const parts = rec.split(" ");
			const xy = parts[1] ?? "..";
			const path = parts.slice(8).join(" ");
			const X = xy[0];
			const Y = xy[1];
			const head: 0 | 1 = X === "A" ? 0 : 1;
			const stage: 0 | 1 | 2 | 3 = X === "." ? 1 : X === "A" ? 2 : Y === "." ? 1 : 3;
			const workdir: 0 | 1 | 2 = Y === "." ? 1 : Y === "D" ? 0 : 2;
			rows.push([path, head, workdir, stage]);
		}
	}
	return rows;
}

function parseLogOutput(out: string): CommitInfo[] {
	const records = out.split("").filter((r) => r.trim().length > 0);
	const commits: CommitInfo[] = [];
	for (const rec of records) {
		const fields = rec.split("\0");
		if (fields.length < 10) continue;
		const [oid, tree, parents, an, ae, at, cn, ce, ct, ...messageParts] = fields as [
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			...string[],
		];
		const msg = messageParts.join("\0").replace(/^\n+/, "").replace(/\n+$/, "");
		commits.push({
			oid: oid.trim(),
			tree,
			parents: parents.trim() ? parents.trim().split(" ") : [],
			author: {
				name: an,
				email: ae,
				timestamp: Number(at),
				timezoneOffset: 0,
			},
			committer: {
				name: cn,
				email: ce,
				timestamp: Number(ct),
				timezoneOffset: 0,
			},
			message: msg,
		});
	}
	return commits;
}
