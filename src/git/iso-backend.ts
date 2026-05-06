/**
 * `GitBackend` implementation backed by isomorphic-git.
 *
 * Pure JavaScript, runs in browsers, workerd, Bun, and Node. No `git` binary
 * needed. Handles clone/init/add/commit/log/status/branch/checkout/diff
 * directly against the mirage-backed working tree.
 */

import git from "isomorphic-git";
// `isomorphic-git/http/web` exports a pure-fetch HTTP transport.
import http from "isomorphic-git/http/web";
import { makeIsoGitFs } from "./fs-adapter.js";
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
	InitOptions,
	LogOptions,
	PullOptions,
	PushOptions,
	StatusRow,
} from "./types.js";

export interface IsoGitBackendOptions {
	/**
	 * HTTP transport for clone/push/pull. Defaults to `isomorphic-git/http/web`
	 * which uses `fetch()` and works in browsers, workerd, and Bun. For Node
	 * with a CORS-restricted environment, swap in `isomorphic-git/http/node`.
	 */
	http?: typeof http;
	/** Override the iso-git module (testing/dependency injection). */
	git?: typeof git;
}

export class IsoGitBackend implements GitBackend {
	readonly name = "iso-git" as const;
	private readonly http: typeof http;
	private readonly git: typeof git;

	constructor(options?: IsoGitBackendOptions) {
		this.http = options?.http ?? http;
		this.git = options?.git ?? git;
	}

	async init(ctx: BackendContext, opts?: InitOptions): Promise<void> {
		await this.git.init({
			...this.fsArgs(ctx),
			defaultBranch: opts?.defaultBranch ?? "main",
		});
	}

	async clone(ctx: BackendContext, opts: CloneOptions): Promise<void> {
		await this.git.clone({
			...this.fsArgs(ctx),
			http: this.http,
			url: opts.url,
			ref: opts.ref,
			depth: opts.depth ?? 1,
			singleBranch: opts.singleBranch ?? true,
			corsProxy: opts.corsProxy,
			onAuth: opts.onAuth as never,
			headers: opts.headers,
		});
	}

	async status(ctx: BackendContext): Promise<StatusRow[]> {
		const matrix = await this.git.statusMatrix(this.fsArgs(ctx));
		// Drop unchanged rows so the result is "what's interesting".
		return matrix.filter((row) => !(row[1] === 1 && row[2] === 1 && row[3] === 1)) as StatusRow[];
	}

	async add(ctx: BackendContext, opts: AddOptions): Promise<void> {
		await this.git.add({
			...this.fsArgs(ctx),
			filepath: opts.filepaths,
			force: opts.force,
		});
	}

	async commit(ctx: BackendContext, opts: CommitOptions): Promise<string> {
		return this.git.commit({
			...this.fsArgs(ctx),
			message: opts.message,
			author: opts.author,
			committer: opts.committer,
			amend: opts.amend,
		});
	}

	async log(ctx: BackendContext, opts?: LogOptions): Promise<CommitInfo[]> {
		const entries = await this.git.log({
			...this.fsArgs(ctx),
			ref: opts?.ref,
			filepath: opts?.filepath,
			depth: opts?.depth,
			since: opts?.since,
		});
		return entries.map((e) => ({
			oid: e.oid,
			tree: e.commit.tree,
			parents: e.commit.parent,
			author: e.commit.author,
			committer: e.commit.committer,
			message: e.commit.message,
		}));
	}

	async branch(ctx: BackendContext, opts: BranchOptions): Promise<void> {
		await this.git.branch({
			...this.fsArgs(ctx),
			ref: opts.ref,
			checkout: opts.checkout,
			force: opts.force,
		});
	}

	async listBranches(ctx: BackendContext): Promise<string[]> {
		return this.git.listBranches(this.fsArgs(ctx));
	}

	async currentBranch(ctx: BackendContext): Promise<string | undefined> {
		const ref = await this.git.currentBranch({ ...this.fsArgs(ctx), fullname: false });
		return ref ?? undefined;
	}

	async checkout(ctx: BackendContext, opts: CheckoutOptions): Promise<void> {
		await this.git.checkout({
			...this.fsArgs(ctx),
			ref: opts.ref,
			filepaths: opts.filepaths,
			noCheckout: opts.noCheckout,
			force: opts.force,
		});
	}

	async resolveRef(ctx: BackendContext, ref: string): Promise<string> {
		return this.git.resolveRef({ ...this.fsArgs(ctx), ref });
	}

	async readBlob(ctx: BackendContext, oid: string, filepath?: string): Promise<Uint8Array> {
		const result = await this.git.readBlob({ ...this.fsArgs(ctx), oid, filepath });
		return result.blob;
	}

	async diff(ctx: BackendContext, opts?: DiffOptions): Promise<DiffEntry[]> {
		const a = opts?.a ?? "HEAD";
		const trees: ReturnType<typeof this.git.TREE>[] = [this.git.TREE({ ref: a })];
		if (opts?.b) {
			trees.push(this.git.TREE({ ref: opts.b }));
		} else {
			trees.push(this.git.WORKDIR());
		}

		const out: DiffEntry[] = [];
		await this.git.walk({
			...this.fsArgs(ctx),
			trees,
			// Iso-git's walker only descends when `map` returns a non-null value.
			// We push diffs into `out` as a side effect and return the filepath
			// so the walker keeps going.
			map: async (filepath, entries) => {
				if (filepath === ".") return filepath;
				// `.git/` isn't auto-excluded from WORKDIR. Skip it.
				if (filepath === ".git" || filepath.startsWith(".git/")) return null;
				const aEntry = entries?.[0] ?? null;
				const bEntry = entries?.[1] ?? null;
				const aType = aEntry ? await aEntry.type() : null;
				const bType = bEntry ? await bEntry.type() : null;
				if (aType === "tree" || bType === "tree") return filepath;
				if (aType !== "blob" && bType !== "blob") return null;
				const aOid = aEntry ? await aEntry.oid() : null;
				const bOid = bEntry ? await bEntry.oid() : null;
				if (aOid === bOid) return null;
				out.push({
					path: filepath,
					added: !aEntry && !!bEntry,
					removed: !!aEntry && !bEntry,
					aOid: aOid ?? null,
					bOid: bOid ?? null,
				});
				return filepath;
			},
		});
		return out;
	}

	async push(ctx: BackendContext, opts: PushOptions): Promise<void> {
		await this.git.push({
			...this.fsArgs(ctx),
			http: this.http,
			url: opts.url,
			remote: opts.remote,
			ref: opts.ref,
			remoteRef: opts.remoteRef,
			force: opts.force,
			corsProxy: opts.corsProxy,
			onAuth: opts.onAuth as never,
			headers: opts.headers,
		});
	}

	async pull(ctx: BackendContext, opts: PullOptions): Promise<void> {
		await this.git.pull({
			...this.fsArgs(ctx),
			http: this.http,
			url: opts.url,
			remote: opts.remote,
			ref: opts.ref,
			remoteRef: opts.remoteRef,
			fastForwardOnly: opts.fastForwardOnly,
			corsProxy: opts.corsProxy,
			onAuth: opts.onAuth as never,
			headers: opts.headers,
			author: opts.author,
		});
	}

	async listRemotes(ctx: BackendContext): Promise<{ remote: string; url: string }[]> {
		return this.git.listRemotes(this.fsArgs(ctx));
	}

	async addRemote(ctx: BackendContext, remote: string, url: string): Promise<void> {
		await this.git.addRemote({ ...this.fsArgs(ctx), remote, url });
	}

	private fsArgs(ctx: BackendContext): {
		fs: ReturnType<typeof makeIsoGitFs>;
		dir: string;
		gitdir?: string;
	} {
		const fs = makeIsoGitFs(ctx.fs, ctx.gitdir, ctx.dir);
		const args: { fs: typeof fs; dir: string; gitdir?: string } = { fs, dir: ctx.dir };
		if (typeof ctx.gitdir === "string") {
			args.gitdir = ctx.gitdir;
		} else {
			// Sidecar mode: route everything under `${dir}/.git` to the sidecar.
			// Iso-git itself still asks for paths via `${dir}/.git/...`, the
			// adapter rewrites them to live in the sidecar FS.
			args.gitdir = `${ctx.dir.replace(/\/$/, "")}/.git`;
		}
		return args;
	}
}
