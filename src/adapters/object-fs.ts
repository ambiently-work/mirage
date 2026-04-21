import { globMatch } from "../glob.js";
import type { IFileSystem, VfsStats } from "../types.js";

/**
 * A simple flat filesystem backed by a plain object/Map.
 * Useful for quickly creating filesystems from data structures,
 * KV stores, or HTTP responses.
 *
 * All paths are treated as flat keys (no directory hierarchy).
 * Directories are simulated by checking path prefixes.
 *
 * Usage:
 *   const fs = new ObjectFileSystem({
 *     "/config.json": '{"key": "value"}',
 *     "/data/users.csv": "name,age\nalice,30\n",
 *   });
 *   shell.mount("/api", fs);
 */
export class ObjectFileSystem implements IFileSystem {
	private files: Map<string, { content: string; mtime: number }>;
	private dirs: Set<string>;

	constructor(files?: Record<string, string>) {
		this.files = new Map();
		this.dirs = new Set(["/"]);
		if (files) {
			const now = Date.now();
			for (const [path, content] of Object.entries(files)) {
				const normalized = path.startsWith("/") ? path : `/${path}`;
				this.files.set(normalized, { content, mtime: now });
				this.trackDirs(normalized);
			}
		}
	}

	private trackDirs(filePath: string): void {
		let i = filePath.lastIndexOf("/");
		while (i > 0) {
			const dir = filePath.slice(0, i);
			if (this.dirs.has(dir)) break;
			this.dirs.add(dir);
			i = dir.lastIndexOf("/");
		}
	}

	private normalizePath(path: string): string {
		if (path === "" || path === ".") return "/";
		return path.startsWith("/") ? path : `/${path}`;
	}

	private isDir(path: string): boolean {
		const normalized = this.normalizePath(path);
		return this.dirs.has(normalized);
	}

	private makeStats(isFile: boolean, size: number, mtime: number): VfsStats {
		return {
			size,
			mode: isFile ? 0o644 : 0o755,
			uid: 0,
			gid: 0,
			atime: mtime,
			mtime,
			ctime: mtime,
			isFile: () => isFile,
			isDirectory: () => !isFile,
			isSymlink: () => false,
		};
	}

	readFile(path: string): string {
		const normalized = this.normalizePath(path);
		const entry = this.files.get(normalized);
		if (!entry) throw new Error(`ENOENT: no such file or directory: ${path}`);
		return entry.content;
	}

	readDir(path: string): string[] {
		const normalized = this.normalizePath(path);
		const prefix = normalized === "/" ? "/" : `${normalized}/`;
		const prefixLen = prefix.length;
		const entries = new Set<string>();

		for (const key of this.files.keys()) {
			if (key.startsWith(prefix)) {
				const slashIdx = key.indexOf("/", prefixLen);
				const firstSegment =
					slashIdx === -1 ? key.slice(prefixLen) : key.slice(prefixLen, slashIdx);
				if (firstSegment) entries.add(firstSegment);
			}
		}

		return [...entries].sort();
	}

	stat(path: string): VfsStats {
		const normalized = this.normalizePath(path);
		const entry = this.files.get(normalized);
		if (entry) {
			return this.makeStats(true, entry.content.length, entry.mtime);
		}
		if (this.isDir(normalized)) {
			return this.makeStats(false, 0, Date.now());
		}
		throw new Error(`ENOENT: no such file or directory: ${path}`);
	}

	lstat(path: string): VfsStats {
		return this.stat(path);
	}

	exists(path: string): boolean {
		const normalized = this.normalizePath(path);
		return this.files.has(normalized) || this.isDir(normalized);
	}

	writeFile(path: string, content: string): void {
		const normalized = this.normalizePath(path);
		this.files.set(normalized, { content, mtime: Date.now() });
		this.trackDirs(normalized);
	}

	appendFile(path: string, content: string): void {
		const normalized = this.normalizePath(path);
		const existing = this.files.get(normalized);
		if (existing) {
			existing.content += content;
			existing.mtime = Date.now();
		} else {
			this.files.set(normalized, { content, mtime: Date.now() });
		}
	}

	mkdir(path: string): void {
		const normalized = this.normalizePath(path);
		this.dirs.add(normalized);
		this.trackDirs(normalized);
	}

	rm(path: string, options?: { recursive?: boolean; force?: boolean }): void {
		const normalized = this.normalizePath(path);
		if (this.files.has(normalized)) {
			this.files.delete(normalized);
			return;
		}
		if (options?.recursive) {
			const prefix = `${normalized}/`;
			for (const key of [...this.files.keys()]) {
				if (key.startsWith(prefix)) {
					this.files.delete(key);
				}
			}
			return;
		}
		if (!options?.force) {
			throw new Error(`ENOENT: no such file or directory: ${path}`);
		}
	}

	cp(src: string, dest: string): void {
		const content = this.readFile(src);
		this.writeFile(dest, content);
	}

	mv(src: string, dest: string): void {
		const content = this.readFile(src);
		this.writeFile(dest, content);
		this.rm(src);
	}

	chmod(): void {
		// No-op for ObjectFileSystem
	}

	chown(): void {
		// No-op for ObjectFileSystem
	}

	symlink(): void {
		throw new Error("ENOSYS: symlinks not supported on ObjectFileSystem");
	}

	readlink(): string {
		throw new Error("EINVAL: not a symlink");
	}

	realpath(path: string): string {
		return this.normalizePath(path);
	}

	glob(pattern: string, options?: { cwd?: string }): string[] {
		const cwd = options?.cwd ?? "/";
		const absPattern = pattern.startsWith("/")
			? pattern
			: cwd === "/"
				? `/${pattern}`
				: `${cwd}/${pattern}`;
		const results: string[] = [];
		for (const key of this.files.keys()) {
			if (globMatch(absPattern, key)) {
				results.push(key);
			}
		}
		return results.sort();
	}

	/** Get all files as a plain object */
	toObject(): Record<string, string> {
		const result: Record<string, string> = {};
		for (const [path, entry] of this.files) {
			result[path] = entry.content;
		}
		return result;
	}
}
