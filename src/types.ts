export interface MirageStats {
	size: number;
	mode: number;
	uid: number;
	gid: number;
	atime: number;
	mtime: number;
	ctime: number;
	/**
	 * Monotonic write counter for the underlying file node. Increments on every
	 * `writeFile` / `writeFileBytes`. Adapters that don't track this (e.g.
	 * `HttpFileSystem`) report 0. Lets stat-keyed caches detect modifications
	 * within the same wall-clock second (where `mtime` would collide).
	 */
	rev: number;
	isFile(): boolean;
	isDirectory(): boolean;
	isSymlink(): boolean;
}

export interface IFileSystem {
	readFile(path: string): string;
	/**
	 * Read raw bytes. Required for binary content (git objects, images, etc.) —
	 * round-tripping binary through `readFile` / `writeFile` is lossy because
	 * those use UTF-8 encoding.
	 */
	readFileBytes(path: string): Uint8Array;
	readDir(path: string): string[];
	stat(path: string): MirageStats;
	lstat(path: string): MirageStats;
	exists(path: string): boolean;
	writeFile(path: string, content: string): void;
	/** Write raw bytes. See {@link readFileBytes}. */
	writeFileBytes(path: string, content: Uint8Array): void;
	appendFile(path: string, content: string): void;
	mkdir(path: string, options?: { recursive?: boolean }): void;
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): void;
	cp(src: string, dest: string, options?: { recursive?: boolean }): void;
	mv(src: string, dest: string): void;
	chmod(path: string, mode: number): void;
	chown(path: string, uid: number, gid: number): void;
	symlink(target: string, path: string): void;
	readlink(path: string): string;
	realpath(path: string): string;
	glob(pattern: string, options?: { cwd?: string }): string[];
}
