import type { IFileSystem, MirageStats } from "../types.js";

/**
 * A read-only filesystem backed by HTTP requests.
 * Fetches files on demand from a base URL.
 *
 * Usage:
 *   const fs = new HttpFileSystem("https://api.example.com/files");
 *   shell.mount("/remote", fs);
 *   // "cat /remote/config.json" → GET https://api.example.com/files/config.json
 *
 * Supports an optional file listing endpoint for readDir/glob.
 * By default, readDir returns an empty array (HTTP doesn't have directories).
 */
export interface HttpFileSystemOptions {
	headers?: Record<string, string>;
	listEndpoint?: string;
	cache?: boolean;
}

export class HttpFileSystem implements IFileSystem {
	private baseUrl: string;
	private headers: Record<string, string>;
	private listEndpoint: string | null;
	private cacheEnabled: boolean;
	private fileCache = new Map<string, string>();
	private dirCache = new Map<string, string[]>();

	constructor(baseUrl: string, options?: HttpFileSystemOptions) {
		this.baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
		this.headers = options?.headers ?? {};
		this.listEndpoint = options?.listEndpoint ?? null;
		this.cacheEnabled = options?.cache ?? true;
	}

	private fetchSync(path: string): string {
		if (this.cacheEnabled) {
			const cached = this.fileCache.get(path);
			if (cached !== undefined) {
				return cached;
			}
		}

		throw new Error(
			`ENOENT: file not cached: ${path}. ` +
				`Call prefetch("${path}") first, or use AsyncHttpFileSystem.`,
		);
	}

	/**
	 * Pre-fetch a file so it's available synchronously.
	 */
	async prefetch(path: string): Promise<void> {
		const url = this.baseUrl + (path.startsWith("/") ? path : `/${path}`);
		const res = await fetch(url, { headers: this.headers });
		if (!res.ok) {
			throw new Error(`ENOENT: HTTP ${res.status} for ${path}`);
		}
		const content = await res.text();
		this.fileCache.set(path, content);
	}

	async prefetchAll(paths: string[]): Promise<void> {
		await Promise.all(paths.map((p) => this.prefetch(p)));
	}

	async prefetchDir(path: string): Promise<string[]> {
		if (!this.listEndpoint) return [];
		const url = this.listEndpoint + (path.startsWith("/") ? path : `/${path}`);
		const res = await fetch(url, { headers: this.headers });
		if (!res.ok) return [];
		const entries = (await res.json()) as string[];
		this.dirCache.set(path, entries);
		return entries;
	}

	/**
	 * Seed the cache directly (useful for testing or pre-populating).
	 */
	seed(files: Record<string, string>): void {
		for (const [path, content] of Object.entries(files)) {
			const normalized = path.startsWith("/") ? path : `/${path}`;
			this.fileCache.set(normalized, content);
		}
	}

	clearCache(): void {
		this.fileCache.clear();
		this.dirCache.clear();
	}

	readFile(path: string): string {
		return this.fetchSync(path);
	}

	readDir(path: string): string[] {
		return this.dirCache.get(path) ?? [];
	}

	stat(path: string): MirageStats {
		const content = this.fetchSync(path);
		return {
			size: content.length,
			mode: 0o444,
			uid: 0,
			gid: 0,
			atime: Date.now(),
			mtime: Date.now(),
			ctime: Date.now(),
			isFile: () => true,
			isDirectory: () => false,
			isSymlink: () => false,
		};
	}

	lstat(path: string): MirageStats {
		return this.stat(path);
	}

	exists(path: string): boolean {
		return this.fileCache.has(path) || this.dirCache.has(path);
	}

	writeFile(): void {
		throw new Error("EROFS: read-only HTTP filesystem");
	}

	appendFile(): void {
		throw new Error("EROFS: read-only HTTP filesystem");
	}

	mkdir(): void {
		throw new Error("EROFS: read-only HTTP filesystem");
	}

	rm(): void {
		throw new Error("EROFS: read-only HTTP filesystem");
	}

	cp(): void {
		throw new Error("EROFS: read-only HTTP filesystem");
	}

	mv(): void {
		throw new Error("EROFS: read-only HTTP filesystem");
	}

	chmod(): void {
		throw new Error("EROFS: read-only HTTP filesystem");
	}

	chown(): void {
		throw new Error("EROFS: read-only HTTP filesystem");
	}

	symlink(): void {
		throw new Error("EROFS: read-only HTTP filesystem");
	}

	readlink(): string {
		throw new Error("EINVAL: not a symlink");
	}

	realpath(path: string): string {
		return path;
	}

	glob(_pattern: string): string[] {
		return [...this.fileCache.keys()].sort();
	}
}
