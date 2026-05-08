import { globMatch } from "../glob.js";
import { decodeUtf8, encodeUtf8 } from "../node.js";
import type { IFileSystem, MirageStats } from "../types.js";

interface ObjectFileEntry {
	content: Uint8Array;
	ino: number;
	mtime: number;
	rev: number;
	nlink: number;
}

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
	private files: Map<string, ObjectFileEntry>;
	private dirs: Set<string>;
	private nextInode = 1;

	constructor(files?: Record<string, string | Uint8Array>) {
		this.files = new Map();
		this.dirs = new Set(["/"]);
		if (files) {
			const now = Date.now();
			for (const [path, content] of Object.entries(files)) {
				const normalized = path.startsWith("/") ? path : `/${path}`;
				const bytes = typeof content === "string" ? encodeUtf8(content) : content;
				this.files.set(normalized, {
					content: bytes,
					ino: this.nextInode++,
					mtime: now,
					rev: 0,
					nlink: 1,
				});
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

	private makeStats(
		isFile: boolean,
		size: number,
		mtime: number,
		rev = 0,
		ino = 0,
		nlink = 1,
	): MirageStats {
		return {
			size,
			ino,
			mode: isFile ? 0o644 : 0o755,
			uid: 0,
			gid: 0,
			atime: mtime,
			mtime,
			ctime: mtime,
			rev,
			nlink,
			nlinks: nlink,
			isFile: () => isFile,
			isDirectory: () => !isFile,
			isSymlink: () => false,
		};
	}

	readFile(path: string): string {
		return decodeUtf8(this.readFileBytes(path));
	}

	readFileBytes(path: string): Uint8Array {
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

	stat(path: string): MirageStats {
		const normalized = this.normalizePath(path);
		const entry = this.files.get(normalized);
		if (entry) {
			return this.makeStats(
				true,
				entry.content.length,
				entry.mtime,
				entry.rev,
				entry.ino,
				entry.nlink,
			);
		}
		if (this.isDir(normalized)) {
			return this.makeStats(false, 0, Date.now());
		}
		throw new Error(`ENOENT: no such file or directory: ${path}`);
	}

	lstat(path: string): MirageStats {
		return this.stat(path);
	}

	exists(path: string): boolean {
		const normalized = this.normalizePath(path);
		return this.files.has(normalized) || this.isDir(normalized);
	}

	writeFile(path: string, content: string): void {
		this.writeFileBytes(path, encodeUtf8(content));
	}

	writeFileBytes(path: string, content: Uint8Array): void {
		const normalized = this.normalizePath(path);
		const prev = this.files.get(normalized);
		if (prev) {
			prev.content = content;
			prev.mtime = Date.now();
			prev.rev += 1;
		} else {
			this.files.set(normalized, {
				content,
				ino: this.nextInode++,
				mtime: Date.now(),
				rev: 1,
				nlink: 1,
			});
		}
		this.trackDirs(normalized);
	}

	appendFile(path: string, content: string): void {
		const normalized = this.normalizePath(path);
		const existing = this.files.get(normalized);
		if (existing) {
			const tail = encodeUtf8(content);
			const merged = new Uint8Array(existing.content.length + tail.length);
			merged.set(existing.content, 0);
			merged.set(tail, existing.content.length);
			existing.content = merged;
			existing.mtime = Date.now();
			existing.rev += 1;
		} else {
			this.files.set(normalized, {
				content: encodeUtf8(content),
				ino: this.nextInode++,
				mtime: Date.now(),
				rev: 1,
				nlink: 1,
			});
		}
	}

	mkdir(path: string): void {
		const normalized = this.normalizePath(path);
		this.dirs.add(normalized);
		this.trackDirs(normalized);
	}

	rm(path: string, options?: { recursive?: boolean; force?: boolean }): void {
		const normalized = this.normalizePath(path);
		const entry = this.files.get(normalized);
		if (entry) {
			entry.nlink = Math.max(entry.nlink - 1, 0);
			entry.mtime = Date.now();
			this.files.delete(normalized);
			return;
		}
		if (options?.recursive) {
			const prefix = `${normalized}/`;
			for (const key of [...this.files.keys()]) {
				if (key.startsWith(prefix)) {
					const entry = this.files.get(key);
					if (entry) entry.nlink = Math.max(entry.nlink - 1, 0);
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
		const content = this.readFileBytes(src);
		this.writeFileBytes(dest, content);
	}

	mv(src: string, dest: string): void {
		const normalizedSrc = this.normalizePath(src);
		const normalizedDest = this.normalizePath(dest);
		const entry = this.files.get(normalizedSrc);
		if (!entry) throw new Error(`ENOENT: no such file or directory: ${src}`);
		const previousDest = this.files.get(normalizedDest);
		if (previousDest) previousDest.nlink = Math.max(previousDest.nlink - 1, 0);
		this.files.set(normalizedDest, entry);
		this.files.delete(normalizedSrc);
		this.trackDirs(normalizedDest);
	}

	link(src: string, dest: string): void {
		const normalizedSrc = this.normalizePath(src);
		const normalizedDest = this.normalizePath(dest);
		const entry = this.files.get(normalizedSrc);
		if (!entry) throw new Error(`ENOENT: no such file or directory: ${src}`);
		if (this.files.has(normalizedDest) || this.isDir(normalizedDest)) {
			throw new Error(`EEXIST: file already exists: ${dest}`);
		}
		entry.nlink += 1;
		entry.mtime = Date.now();
		this.files.set(normalizedDest, entry);
		this.trackDirs(normalizedDest);
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

	listMounts(): [] {
		return [];
	}

	/** Get all files as a plain object (file contents UTF-8 decoded). */
	toObject(): Record<string, string> {
		const result: Record<string, string> = {};
		for (const [path, entry] of this.files) {
			result[path] = decodeUtf8(entry.content);
		}
		return result;
	}

	/** Get all files as a Uint8Array map (lossless, binary-safe). */
	toBytes(): Record<string, Uint8Array> {
		const result: Record<string, Uint8Array> = {};
		for (const [path, entry] of this.files) {
			result[path] = entry.content;
		}
		return result;
	}
}
