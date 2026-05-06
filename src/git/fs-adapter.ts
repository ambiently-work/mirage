/**
 * Bridges Mirage's `IFileSystem` to the `node:fs/promises`-shaped API that
 * isomorphic-git consumes. Also handles "sidecar" `.git/` mode: when `gitdir`
 * is a separate `IFileSystem`, requests under the gitdir prefix are
 * transparently rewritten and dispatched to the sidecar.
 */

import { decodeUtf8, encodeUtf8 } from "../node.js";
import type { IFileSystem } from "../types.js";

interface FsStat {
	type: "file" | "dir" | "symlink";
	mode: number;
	size: number;
	ino: number;
	mtimeMs: number;
	ctimeMs: number;
	uid: number;
	gid: number;
	dev: number;
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

interface ReadFileOptions {
	encoding?: "utf8";
}

interface MkdirOptions {
	mode?: number;
	recursive?: boolean;
}

interface RouteSpec {
	prefix: string;
	fs: IFileSystem;
	rewrite: (path: string) => string;
}

function buildRoutes(
	workingFs: IFileSystem,
	gitdir: string | IFileSystem,
	dir: string,
): RouteSpec[] {
	if (typeof gitdir === "string") {
		// In-tree: gitdir is just a path inside workingFs. No routing needed.
		return [{ prefix: "", fs: workingFs, rewrite: (p) => p }];
	}
	// Sidecar: gitdir is a separate FS. Anything under `${dir}/.git/...` is
	// rewritten to a path inside the sidecar.
	const gitMount = `${dir.replace(/\/$/, "")}/.git`;
	return [
		{
			prefix: gitMount,
			fs: gitdir,
			rewrite: (p) => {
				const rest = p.slice(gitMount.length) || "/";
				return rest.startsWith("/") ? rest : `/${rest}`;
			},
		},
		{ prefix: "", fs: workingFs, rewrite: (p) => p },
	];
}

function pickRoute(routes: RouteSpec[], path: string): { fs: IFileSystem; path: string } {
	for (const r of routes) {
		if (r.prefix === "") {
			return { fs: r.fs, path: r.rewrite(path) };
		}
		if (path === r.prefix || path.startsWith(`${r.prefix}/`)) {
			return { fs: r.fs, path: r.rewrite(path) };
		}
	}
	throw new Error(`no route for ${path}`);
}

/**
 * Iso-git fs adapter — `mirageFs.promises` looks like `node:fs.promises` to
 * isomorphic-git. The shape comes from iso-git's `PromiseFsClient`.
 */
export interface PromiseFsClientShape {
	promises: {
		readFile(path: string, opts?: ReadFileOptions | string): Promise<Uint8Array | string>;
		writeFile(path: string, data: Uint8Array | string, opts?: { mode?: number }): Promise<void>;
		unlink(path: string): Promise<void>;
		readdir(path: string): Promise<string[]>;
		mkdir(path: string, opts?: MkdirOptions): Promise<void>;
		rmdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
		stat(path: string): Promise<FsStat>;
		lstat(path: string): Promise<FsStat>;
		readlink(path: string): Promise<string>;
		symlink(target: string, path: string): Promise<void>;
		chmod(path: string, mode: number): Promise<void>;
	};
}

/**
 * Build the iso-git fs adapter for a given working tree + gitdir.
 *
 * `dir` is the working-tree path inside `workingFs`. Used only when `gitdir`
 * is a sidecar `IFileSystem` to know which prefix to rewrite.
 */
export function makeIsoGitFs(
	workingFs: IFileSystem,
	gitdir: string | IFileSystem,
	dir: string,
): PromiseFsClientShape {
	const routes = buildRoutes(workingFs, gitdir, dir);
	const route = (p: string) => pickRoute(routes, p);

	return {
		promises: {
			async readFile(path, opts) {
				const { fs, path: routed } = route(path);
				const encoding =
					typeof opts === "string" ? opts : opts && "encoding" in opts ? opts.encoding : undefined;
				const bytes = fs.readFileBytes(routed);
				if (encoding === "utf8") return decodeUtf8(bytes);
				return bytes;
			},
			async writeFile(path, data, opts) {
				const { fs, path: routed } = route(path);
				const bytes = typeof data === "string" ? encodeUtf8(data) : data;
				ensureDirSync(fs, parentPath(routed));
				fs.writeFileBytes(routed, bytes);
				if (opts?.mode !== undefined) {
					try {
						fs.chmod(routed, opts.mode);
					} catch {
						// chmod is best-effort across adapters
					}
				}
			},
			async unlink(path) {
				const { fs, path: routed } = route(path);
				try {
					fs.rm(routed, { force: false });
				} catch (err) {
					throw asPosixError(err, "ENOENT", path);
				}
			},
			async readdir(path) {
				const { fs, path: routed } = route(path);
				try {
					return fs.readDir(routed);
				} catch (err) {
					throw asPosixError(err, "ENOENT", path);
				}
			},
			async mkdir(path, opts) {
				const { fs, path: routed } = route(path);
				try {
					fs.mkdir(routed, { recursive: opts?.recursive });
				} catch (err) {
					if (opts?.recursive && err instanceof Error && err.message.startsWith("EEXIST")) {
						return;
					}
					throw err;
				}
			},
			async rmdir(path, opts) {
				const { fs, path: routed } = route(path);
				fs.rm(routed, { recursive: opts?.recursive });
			},
			async stat(path) {
				const { fs, path: routed } = route(path);
				try {
					return adaptStat(fs.stat(routed), routed);
				} catch (err) {
					throw asPosixError(err, "ENOENT", path);
				}
			},
			async lstat(path) {
				const { fs, path: routed } = route(path);
				try {
					return adaptStat(fs.lstat(routed), routed);
				} catch (err) {
					throw asPosixError(err, "ENOENT", path);
				}
			},
			async readlink(path) {
				const { fs, path: routed } = route(path);
				return fs.readlink(routed);
			},
			async symlink(target, path) {
				const { fs, path: routed } = route(path);
				ensureDirSync(fs, parentPath(routed));
				fs.symlink(target, routed);
			},
			async chmod(path, mode) {
				const { fs, path: routed } = route(path);
				try {
					fs.chmod(routed, mode);
				} catch {
					// best-effort
				}
			},
		},
	};
}

function parentPath(path: string): string {
	const idx = path.lastIndexOf("/");
	if (idx <= 0) return "/";
	return path.slice(0, idx);
}

function ensureDirSync(fs: IFileSystem, path: string): void {
	if (path === "/" || path === "") return;
	if (fs.exists(path)) return;
	fs.mkdir(path, { recursive: true });
}

function adaptStat(
	s: {
		size: number;
		mode: number;
		mtime: number;
		ctime: number;
		uid: number;
		gid: number;
		rev: number;
		isFile(): boolean;
		isDirectory(): boolean;
		isSymlink(): boolean;
	},
	routedPath: string,
): FsStat {
	const type: FsStat["type"] = s.isDirectory() ? "dir" : s.isSymlink() ? "symlink" : "file";
	// Iso-git keys its workdir-vs-index stat cache by ino. With a real fs ino
	// is stable across writes; here mirage is in-memory so we synthesize one
	// from `path-hash ^ rev`. The rev component bumps on every write, so two
	// modifications in the same wall-clock second still produce different inos
	// and iso-git correctly invalidates the cache and rehashes the file.
	const ino = simpleHash(routedPath) ^ (s.rev | 0);
	return {
		type,
		mode: s.mode,
		size: s.size,
		ino,
		mtimeMs: s.mtime,
		ctimeMs: s.ctime,
		uid: s.uid,
		gid: s.gid,
		dev: 0,
		isFile: s.isFile.bind(s),
		isDirectory: s.isDirectory.bind(s),
		isSymbolicLink: s.isSymlink.bind(s),
	};
}

function simpleHash(s: string): number {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return Math.abs(h);
}

function asPosixError(err: unknown, code: string, path: string): Error {
	// iso-git keys on `err.code === 'ENOENT'`. Mirage throws errors whose
	// message starts with `ENOENT:` but doesn't set `.code` — patch it.
	if (err instanceof Error) {
		const codeMatch = err.message.match(/^([A-Z]+):/);
		const inferred = codeMatch?.[1] ?? code;
		if (!("code" in err) || (err as { code?: string }).code === undefined) {
			(err as Error & { code: string }).code = inferred;
		}
		return err;
	}
	const out = new Error(`${code}: ${path}`) as Error & { code: string };
	out.code = code;
	return out;
}
