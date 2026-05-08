import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { globMatch } from "../../glob.js";

export interface FilesystemToolsOptions {
	rootDir: string;
	allowlist?: string[];
}

function allowedPath(rootDir: string, allowlist: string[], candidate: string): string {
	const abs = resolve(rootDir, candidate);
	if (!abs.startsWith(rootDir)) throw new Error("Path escapes configured root");
	if (allowlist.length === 0) return abs;
	if (allowlist.some((prefix) => abs.startsWith(resolve(rootDir, prefix)))) return abs;
	throw new Error("Path is outside allowlist");
}

async function walkFiles(rootDir: string, baseDir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(baseDir, { withFileTypes: true })) {
		const full = resolve(baseDir, entry.name);
		if (entry.isDirectory()) out.push(...(await walkFiles(rootDir, full)));
		if (entry.isFile()) out.push(relative(rootDir, full));
	}
	return out;
}

export class FilesystemBuiltins {
	private readonly rootDir: string;
	private readonly allowlist: string[];

	constructor(options: FilesystemToolsOptions) {
		this.rootDir = resolve(options.rootDir);
		this.allowlist = options.allowlist ?? [];
	}

	async readFile(path: string): Promise<string> {
		const safe = allowedPath(this.rootDir, this.allowlist, path);
		return readFile(safe, "utf8");
	}
	async writeFile(path: string, content: string): Promise<void> {
		const safe = allowedPath(this.rootDir, this.allowlist, path);
		await mkdir(dirname(safe), { recursive: true });
		await writeFile(safe, content, "utf8");
	}
	async listDir(path = "."): Promise<string[]> {
		const safe = allowedPath(this.rootDir, this.allowlist, path);
		return (await readdir(safe)).sort();
	}
	async glob(pattern: string): Promise<string[]> {
		const matches: string[] = [];
		for (const file of await walkFiles(this.rootDir, this.rootDir)) {
			const safe = allowedPath(this.rootDir, this.allowlist, file);
			if ((await stat(safe)).isFile() && globMatch(pattern, file)) matches.push(file);
		}
		return matches.sort();
	}
}
