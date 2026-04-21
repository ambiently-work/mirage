import type { IFileSystem, VfsStats } from "../types.js";

/**
 * Wraps any IFileSystem and makes it read-only.
 * All write operations throw EROFS errors.
 */
export class ReadOnlyFileSystem implements IFileSystem {
	constructor(private inner: IFileSystem) {}

	readFile(path: string): string {
		return this.inner.readFile(path);
	}

	readDir(path: string): string[] {
		return this.inner.readDir(path);
	}

	stat(path: string): VfsStats {
		return this.inner.stat(path);
	}

	lstat(path: string): VfsStats {
		return this.inner.lstat(path);
	}

	exists(path: string): boolean {
		return this.inner.exists(path);
	}

	readlink(path: string): string {
		return this.inner.readlink(path);
	}

	realpath(path: string): string {
		return this.inner.realpath(path);
	}

	glob(pattern: string, options?: { cwd?: string }): string[] {
		return this.inner.glob(pattern, options);
	}

	writeFile(): void {
		throw new Error("EROFS: read-only file system");
	}

	appendFile(): void {
		throw new Error("EROFS: read-only file system");
	}

	mkdir(): void {
		throw new Error("EROFS: read-only file system");
	}

	rm(): void {
		throw new Error("EROFS: read-only file system");
	}

	cp(): void {
		throw new Error("EROFS: read-only file system");
	}

	mv(): void {
		throw new Error("EROFS: read-only file system");
	}

	chmod(): void {
		throw new Error("EROFS: read-only file system");
	}

	chown(): void {
		throw new Error("EROFS: read-only file system");
	}

	symlink(): void {
		throw new Error("EROFS: read-only file system");
	}
}
