import { globMatch } from "./glob.js";
import type { MirageNode, NodeMeta } from "./node.js";
import { createDirectory, createFile, createSymlink } from "./node.js";
import { basename, dirname, isAbsolute, join, normalize, resolve, split } from "./path.js";
import type { IFileSystem, MirageStats } from "./types.js";

const MAX_SYMLINK_HOPS = 40;

function makeStats(node: MirageNode): MirageStats {
	const meta = node.meta;
	const size = node.kind === "file" ? node.content.length : 0;
	return {
		size,
		mode: meta.mode,
		uid: meta.uid,
		gid: meta.gid,
		atime: meta.atime,
		mtime: meta.mtime,
		ctime: meta.ctime,
		isFile: () => node.kind === "file",
		isDirectory: () => node.kind === "directory",
		isSymlink: () => node.kind === "symlink",
	};
}

function enoent(path: string): Error {
	return new Error(`ENOENT: no such file or directory: ${path}`);
}

function eexist(path: string): Error {
	return new Error(`EEXIST: file already exists: ${path}`);
}

function enotdir(path: string): Error {
	return new Error(`ENOTDIR: not a directory: ${path}`);
}

function eisdir(path: string): Error {
	return new Error(`EISDIR: illegal operation on a directory: ${path}`);
}

function eacces(path: string): Error {
	return new Error(`EACCES: permission denied: ${path}`);
}

function eloop(path: string): Error {
	return new Error(`ELOOP: too many levels of symbolic links: ${path}`);
}

function enotempty(path: string): Error {
	return new Error(`ENOTEMPTY: directory not empty: ${path}`);
}

export interface VirtualFileSystemOptions {
	files?: Record<string, string>;
	cwd?: string;
	uid?: number;
	gid?: number;
	/**
	 * Skip creating the default POSIX directory tree (/tmp, /root, /home, /usr/bin, /bin, /dev, /var).
	 * Useful when you are about to `restore()` a snapshot or `loadFromDisk` over a blank FS.
	 */
	bare?: boolean;
}

const DEFAULT_DIRS = ["/tmp", "/root", "/home", "/usr/bin", "/bin", "/dev", "/var"];

export class VirtualFileSystem implements IFileSystem {
	private root: MirageNode;
	private _cwd: string;
	private _uid: number;
	private _gid: number;
	private mounts = new Map<string, IFileSystem>();

	constructor(options?: VirtualFileSystemOptions) {
		this.root = createDirectory(0o755);
		this._cwd = options?.cwd ?? "/";
		this._uid = options?.uid ?? 0;
		this._gid = options?.gid ?? 0;

		if (!options?.bare) {
			for (const dir of DEFAULT_DIRS) {
				this.mkdirRecursive(dir);
			}
		}

		if (options?.files) {
			for (const [path, content] of Object.entries(options.files)) {
				const absPath = this.resolvePath(path);
				const dir = dirname(absPath);
				this.mkdirRecursive(dir);
				this.writeFile(absPath, content);
			}
		}
	}

	/** Get direct access to the internal root node. Used by snapshot/restore. */
	getRoot(): MirageNode {
		return this.root;
	}

	/** Replace the internal root node. Used by restore(). */
	setRoot(root: MirageNode): void {
		if (root.kind !== "directory") {
			throw new Error("root node must be a directory");
		}
		this.root = root;
	}

	get cwd(): string {
		return this._cwd;
	}

	set cwd(path: string) {
		const absPath = this.resolvePath(path);
		const node = this.resolveNode(absPath);
		if (!node || node.kind !== "directory") {
			throw enotdir(absPath);
		}
		this._cwd = absPath;
	}

	private resolvePath(path: string): string {
		return resolve(this._cwd, path);
	}

	/**
	 * Walk to a node by its absolute path, following symlinks.
	 */
	private resolveNode(absPath: string, followSymlinks = true): MirageNode | null {
		return this.walkPath(absPath, followSymlinks, 0);
	}

	private walkPath(absPath: string, followSymlinks: boolean, hops: number): MirageNode | null {
		if (hops > MAX_SYMLINK_HOPS) {
			throw eloop(absPath);
		}

		const normalized = normalize(absPath);
		if (normalized === "/") return this.root;

		const parts = split(normalized).filter((p) => p !== "/");
		let current: MirageNode = this.root;

		for (let i = 0; i < parts.length; i++) {
			if (current.kind !== "directory") return null;

			const part = parts[i];
			if (part === undefined) return null;
			const child = current.children.get(part);
			if (!child) return null;

			if (child.kind === "symlink" && (followSymlinks || i < parts.length - 1)) {
				const targetBase = dirname(`/${parts.slice(0, i + 1).join("/")}`);
				const resolvedTarget = resolve(targetBase, child.target);
				const resolvedNode = this.walkPath(resolvedTarget, true, hops + 1);
				if (!resolvedNode) return null;

				if (i === parts.length - 1) return resolvedNode;

				const remaining = parts.slice(i + 1);
				const newPath = `${resolvedTarget}/${remaining.join("/")}`;
				return this.walkPath(normalize(newPath), followSymlinks, hops + 1);
			}

			current = child;
		}

		return current;
	}

	/**
	 * Walk to the parent directory and return [parentNode, childName].
	 */
	private resolveParent(absPath: string): [MirageNode & { kind: "directory" }, string] {
		const dir = dirname(absPath);
		const name = basename(absPath);
		const parent = this.resolveNode(dir);
		if (!parent) throw enoent(dir);
		if (parent.kind !== "directory") throw enotdir(dir);
		return [parent as MirageNode & { kind: "directory" }, name];
	}

	private checkRead(node: MirageNode, path: string): void {
		const perm = this.getEffectivePermBits(node);
		if (!(perm & 4)) throw eacces(path);
	}

	private checkWrite(node: MirageNode, path: string): void {
		const perm = this.getEffectivePermBits(node);
		if (!(perm & 2)) throw eacces(path);
	}

	private getEffectivePermBits(node: MirageNode): number {
		const mode = node.meta.mode;
		if (this._uid === node.meta.uid) {
			return (mode >> 6) & 7;
		}
		if (this._gid === node.meta.gid) {
			return (mode >> 3) & 7;
		}
		return mode & 7;
	}

	private mkdirRecursive(absPath: string): void {
		if (absPath === "/") return;

		const parts = split(absPath).filter((p) => p !== "/");
		let current = this.root as MirageNode;

		for (const part of parts) {
			if (current.kind !== "directory") {
				throw enotdir(absPath);
			}
			let child = current.children.get(part);
			if (!child) {
				child = createDirectory(0o755);
				current.children.set(part, child);
			} else if (child.kind === "symlink") {
				const resolved = this.resolveNode(`/${parts.slice(0, parts.indexOf(part) + 1).join("/")}`);
				if (!resolved || resolved.kind !== "directory") {
					throw enotdir(absPath);
				}
				current = resolved;
				continue;
			} else if (child.kind !== "directory") {
				throw enotdir(absPath);
			}
			current = child;
		}
	}

	private touchMeta(meta: NodeMeta): void {
		meta.mtime = Date.now();
		meta.ctime = Date.now();
	}

	readFile(path: string): string {
		const absPath = this.resolvePath(path);
		const mounted = this.getMountedFs(absPath);
		if (mounted) return mounted[0].readFile(mounted[1]);
		const node = this.resolveNode(absPath);
		if (!node) throw enoent(absPath);
		if (node.kind === "directory") throw eisdir(absPath);
		if (node.kind !== "file") throw enoent(absPath);
		this.checkRead(node, absPath);
		node.meta.atime = Date.now();
		return node.content;
	}

	readDir(path: string): string[] {
		const absPath = this.resolvePath(path);
		const mounted = this.getMountedFs(absPath);
		if (mounted) return mounted[0].readDir(mounted[1]);
		const node = this.resolveNode(absPath);
		if (!node) throw enoent(absPath);
		if (node.kind !== "directory") throw enotdir(absPath);
		this.checkRead(node, absPath);
		node.meta.atime = Date.now();
		return Array.from(node.children.keys()).sort();
	}

	stat(path: string): MirageStats {
		const absPath = this.resolvePath(path);
		const mounted = this.getMountedFs(absPath);
		if (mounted) return mounted[0].stat(mounted[1]);
		const node = this.resolveNode(absPath, true);
		if (!node) throw enoent(absPath);
		return makeStats(node);
	}

	lstat(path: string): MirageStats {
		const absPath = this.resolvePath(path);
		const mounted = this.getMountedFs(absPath);
		if (mounted) return mounted[0].lstat(mounted[1]);
		const node = this.resolveNode(absPath, false);
		if (!node) throw enoent(absPath);
		return makeStats(node);
	}

	exists(path: string): boolean {
		const absPath = this.resolvePath(path);
		const mounted = this.getMountedFs(absPath);
		if (mounted) return mounted[0].exists(mounted[1]);
		try {
			return this.resolveNode(absPath) !== null;
		} catch {
			return false;
		}
	}

	writeFile(path: string, content: string): void {
		const absPath = this.resolvePath(path);
		const mounted = this.getMountedFs(absPath);
		if (mounted) {
			mounted[0].writeFile(mounted[1], content);
			return;
		}
		const [parent, name] = this.resolveParent(absPath);
		this.checkWrite(parent, dirname(absPath));

		const existing = parent.children.get(name);
		if (existing) {
			const resolved = this.resolveNode(absPath);
			if (resolved && resolved.kind === "directory") throw eisdir(absPath);
			if (resolved && resolved.kind === "file") {
				this.checkWrite(resolved, absPath);
				resolved.content = content;
				this.touchMeta(resolved.meta);
				return;
			}
		}

		const file = createFile(content);
		file.meta.uid = this._uid;
		file.meta.gid = this._gid;
		parent.children.set(name, file);
		this.touchMeta(parent.meta);
	}

	appendFile(path: string, content: string): void {
		const absPath = this.resolvePath(path);
		const mounted = this.getMountedFs(absPath);
		if (mounted) {
			mounted[0].appendFile(mounted[1], content);
			return;
		}
		try {
			const existing = this.readFile(absPath);
			this.writeFile(absPath, existing + content);
		} catch (err) {
			if (err instanceof Error && err.message.startsWith("ENOENT")) {
				this.writeFile(absPath, content);
			} else {
				throw err;
			}
		}
	}

	mkdir(path: string, options?: { recursive?: boolean }): void {
		const absPath = this.resolvePath(path);
		const mounted = this.getMountedFs(absPath);
		if (mounted) {
			mounted[0].mkdir(mounted[1], options);
			return;
		}

		if (options?.recursive) {
			this.mkdirRecursive(absPath);
			return;
		}

		const [parent, name] = this.resolveParent(absPath);
		this.checkWrite(parent, dirname(absPath));

		if (parent.children.has(name)) {
			throw eexist(absPath);
		}

		const dir = createDirectory(0o755);
		dir.meta.uid = this._uid;
		dir.meta.gid = this._gid;
		parent.children.set(name, dir);
		this.touchMeta(parent.meta);
	}

	rm(path: string, options?: { recursive?: boolean; force?: boolean }): void {
		const absPath = this.resolvePath(path);
		const mounted = this.getMountedFs(absPath);
		if (mounted) {
			mounted[0].rm(mounted[1], options);
			return;
		}

		if (absPath === "/") {
			if (options?.recursive) {
				if (this.root.kind === "directory") {
					this.root.children.clear();
				}
				return;
			}
			throw new Error("EPERM: cannot remove root directory: /");
		}

		const [parent, name] = this.resolveParent(absPath);
		const child = parent.children.get(name);

		if (!child) {
			if (options?.force) return;
			throw enoent(absPath);
		}

		if (child.kind === "directory" && !options?.recursive) {
			if (child.children.size > 0) {
				throw enotempty(absPath);
			}
		}

		if (child.kind === "directory" && !options?.recursive) {
			throw eisdir(absPath);
		}

		this.checkWrite(parent, dirname(absPath));
		parent.children.delete(name);
		this.touchMeta(parent.meta);
	}

	cp(src: string, dest: string, options?: { recursive?: boolean }): void {
		const absSrc = this.resolvePath(src);
		const absDest = this.resolvePath(dest);
		const mountedSrc = this.getMountedFs(absSrc);
		const mountedDest = this.getMountedFs(absDest);
		if (mountedSrc && mountedDest && mountedSrc[0] === mountedDest[0]) {
			mountedSrc[0].cp(mountedSrc[1], mountedDest[1], options);
			return;
		}
		const content = this.readFile(absSrc);
		const destStat = (() => {
			try {
				return this.stat(absDest);
			} catch {
				return null;
			}
		})();
		if (destStat?.isDirectory()) {
			this.writeFile(join(absDest, basename(absSrc)), content);
		} else {
			this.writeFile(absDest, content);
		}
	}

	mv(src: string, dest: string): void {
		const absSrc = this.resolvePath(src);
		const absDest = this.resolvePath(dest);
		const mountedSrc = this.getMountedFs(absSrc);
		const mountedDest = this.getMountedFs(absDest);
		if (mountedSrc && mountedDest && mountedSrc[0] === mountedDest[0]) {
			mountedSrc[0].mv(mountedSrc[1], mountedDest[1]);
			return;
		}
		if (mountedSrc || mountedDest) {
			this.cp(src, dest);
			this.rm(src);
			return;
		}

		const [srcParent, srcName] = this.resolveParent(absSrc);
		const srcChild = srcParent.children.get(srcName);
		if (!srcChild) throw enoent(absSrc);

		const destNode = this.resolveNode(absDest);
		let finalDest = absDest;
		if (destNode && destNode.kind === "directory") {
			finalDest = join(absDest, srcName);
		}

		const [destParent, destName] = this.resolveParent(finalDest);
		this.checkWrite(srcParent, dirname(absSrc));
		this.checkWrite(destParent, dirname(finalDest));

		srcParent.children.delete(srcName);
		destParent.children.set(destName, srcChild);
		this.touchMeta(srcParent.meta);
		this.touchMeta(destParent.meta);
		this.touchMeta(srcChild.meta);
	}

	chmod(path: string, mode: number): void {
		const absPath = this.resolvePath(path);
		const mounted = this.getMountedFs(absPath);
		if (mounted) {
			mounted[0].chmod(mounted[1], mode);
			return;
		}
		const node = this.resolveNode(absPath);
		if (!node) throw enoent(absPath);
		node.meta.mode = mode;
		node.meta.ctime = Date.now();
	}

	chown(path: string, uid: number, gid: number): void {
		const absPath = this.resolvePath(path);
		const mounted = this.getMountedFs(absPath);
		if (mounted) {
			mounted[0].chown(mounted[1], uid, gid);
			return;
		}
		const node = this.resolveNode(absPath);
		if (!node) throw enoent(absPath);
		node.meta.uid = uid;
		node.meta.gid = gid;
		node.meta.ctime = Date.now();
	}

	symlink(target: string, path: string): void {
		const absPath = this.resolvePath(path);
		const mounted = this.getMountedFs(absPath);
		if (mounted) {
			mounted[0].symlink(target, mounted[1]);
			return;
		}
		const [parent, name] = this.resolveParent(absPath);
		this.checkWrite(parent, dirname(absPath));

		if (parent.children.has(name)) {
			throw eexist(absPath);
		}

		const link = createSymlink(target);
		link.meta.uid = this._uid;
		link.meta.gid = this._gid;
		parent.children.set(name, link);
		this.touchMeta(parent.meta);
	}

	readlink(path: string): string {
		const absPath = this.resolvePath(path);
		const mounted = this.getMountedFs(absPath);
		if (mounted) return mounted[0].readlink(mounted[1]);
		const node = this.resolveNode(absPath, false);
		if (!node) throw enoent(absPath);
		if (node.kind !== "symlink") {
			throw new Error(`EINVAL: not a symlink: ${absPath}`);
		}
		return node.target;
	}

	realpath(path: string): string {
		const absPath = this.resolvePath(path);
		const mounted = this.getMountedFs(absPath);
		if (mounted) return mounted[0].realpath(mounted[1]);
		return this.resolveRealPath(absPath, 0);
	}

	private resolveRealPath(absPath: string, hops: number): string {
		if (hops > MAX_SYMLINK_HOPS) throw eloop(absPath);
		if (absPath === "/") return "/";

		const parts = split(absPath).filter((p) => p !== "/");
		let resolved = "/";

		for (const part of parts) {
			const current = resolve(resolved, part);
			const node = this.resolveNode(current, false);
			if (!node) throw enoent(absPath);

			if (node.kind === "symlink") {
				const target = isAbsolute(node.target) ? node.target : resolve(resolved, node.target);
				resolved = this.resolveRealPath(normalize(target), hops + 1);
			} else {
				resolved = current;
			}
		}

		return resolved;
	}

	glob(pattern: string, options?: { cwd?: string }): string[] {
		const cwd = options?.cwd ?? this._cwd;
		const absPattern = isAbsolute(pattern) ? pattern : join(cwd, pattern);

		const mounted = this.getMountedFs(absPattern);
		if (mounted) {
			const mountPoint = absPattern.slice(0, absPattern.length - mounted[1].length) || "/";
			const results = mounted[0].glob(mounted[1], { cwd: "/" });
			return results.map((p) => normalize(mountPoint + p)).sort();
		}

		const results: string[] = [];
		this.collectAllPaths("/", results);

		for (const [mountPoint, fs] of this.mounts) {
			try {
				const mountedPaths = fs.glob("/**/*", { cwd: "/" });
				for (const p of mountedPaths) {
					results.push(normalize(mountPoint + p));
				}
			} catch {
				// Mount may not support glob — skip
			}
		}

		return results.filter((p) => globMatch(absPattern, p)).sort();
	}

	private collectAllPaths(dir: string, results: string[]): void {
		const node = this.resolveNode(dir);
		if (!node || node.kind !== "directory") return;

		for (const [name] of node.children) {
			const fullPath = dir === "/" ? `/${name}` : `${dir}/${name}`;
			results.push(fullPath);

			const child = this.resolveNode(fullPath, false);
			if (child && child.kind === "directory") {
				this.collectAllPaths(fullPath, results);
			} else if (child && child.kind === "symlink") {
				const resolved = this.resolveNode(fullPath, true);
				if (resolved && resolved.kind === "directory") {
					this.collectAllPaths(fullPath, results);
				}
			}
		}
	}

	mount(mountPoint: string, fs: IFileSystem): void {
		const normalized = normalize(mountPoint);
		this.mounts.set(normalized, fs);
		this.mkdirRecursive(normalized);
	}

	unmount(mountPoint: string): void {
		this.mounts.delete(normalize(mountPoint));
	}

	listMounts(): Map<string, IFileSystem> {
		return new Map(this.mounts);
	}

	/**
	 * Check if an absolute path falls under a mounted filesystem.
	 */
	private getMountedFs(absPath: string): [IFileSystem, string] | null {
		if (this.mounts.size === 0) return null;

		let bestMount = "";
		let bestFs: IFileSystem | null = null;

		for (const [mountPoint, fs] of this.mounts) {
			if (absPath === mountPoint || absPath.startsWith(`${mountPoint}/`)) {
				if (mountPoint.length > bestMount.length) {
					bestMount = mountPoint;
					bestFs = fs;
				}
			}
		}

		if (!bestFs) return null;

		let relativePath = absPath.slice(bestMount.length);
		if (relativePath === "") relativePath = "/";
		else if (!relativePath.startsWith("/")) relativePath = `/${relativePath}`;

		return [bestFs, relativePath];
	}

	/**
	 * Dump all files as a flat `Record<string, string>`. Does not preserve
	 * directory nodes, symlinks, or file modes.
	 *
	 * For a full-fidelity snapshot (directories, symlinks, modes, ownership),
	 * use the top-level `snapshot(fs)` helper from `@ambiently-work/mirage`.
	 */
	snapshot(): Record<string, string> {
		const result: Record<string, string> = {};
		this.snapshotNode("/", this.root, result);
		return result;
	}

	private snapshotNode(path: string, node: MirageNode, result: Record<string, string>): void {
		if (node.kind === "file") {
			result[path] = node.content;
		} else if (node.kind === "directory") {
			for (const [name, child] of node.children) {
				const childPath = path === "/" ? `/${name}` : `${path}/${name}`;
				this.snapshotNode(childPath, child, result);
			}
		}
	}
}
