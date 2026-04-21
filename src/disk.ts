/**
 * Node-only helpers for loading a real directory into a mirage, and
 * writing a mirage (or part of it) back out to disk.
 *
 * This module is NOT imported from the main `@ambiently-work/mirage` entry
 * point — access it via `@ambiently-work/mirage/disk`. Keeps the core
 * package browser-safe (no `node:fs` in the import graph).
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";
import { GitIgnore } from "./gitignore.js";
import type { IFileSystem } from "./types.js";

export interface LoadFromDiskOptions {
	/**
	 * Mount point inside the mirage to place files under. Defaults to `/`.
	 * If the target directory does not exist in the mirage, it is created.
	 */
	target?: string;
	/**
	 * Predicate to filter which paths are loaded. Receives the path relative
	 * to the source directory (e.g., `"src/index.ts"`) and should return
	 * `true` to include it. Defaults to a sensible excluder that skips
	 * `node_modules`, `.git`, `dist`, `.DS_Store`, and friends.
	 */
	filter?: (relativePath: string, isDirectory: boolean) => boolean;
	/**
	 * If true, follow symlinks when loading. Defaults to false — symlinks
	 * are recorded as symlinks.
	 */
	followSymlinks?: boolean;
	/**
	 * Treat files larger than this many bytes as errors (rather than loading
	 * potentially large binaries as UTF-8, which may corrupt them). Defaults
	 * to 10 MiB. Set to `Infinity` to disable.
	 */
	maxFileBytes?: number;
	/**
	 * Apply `.gitignore` rules while walking. `true` reads `.gitignore` files
	 * from the source tree (root + nested). An array of patterns adds extra
	 * rules on top. Combines with {@link filter} — both must accept a path
	 * for it to be loaded.
	 *
	 * Note: the default filter still excludes `.git`, `node_modules`, etc.
	 * Pass an explicit `filter` if you want to include them.
	 */
	gitignore?: boolean | string[];
}

const DEFAULT_EXCLUDES = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	".turbo",
	".cache",
	".DS_Store",
	"target",
	".venv",
	"__pycache__",
]);

function defaultFilter(relativePath: string): boolean {
	const segments = relativePath.split("/");
	return !segments.some((s) => DEFAULT_EXCLUDES.has(s));
}

/**
 * Walk a real directory and hydrate the mirage with its contents.
 *
 * ```ts
 * import { VirtualFileSystem } from "@ambiently-work/mirage";
 * import { loadFromDisk } from "@ambiently-work/mirage/disk";
 *
 * const mirage = new VirtualFileSystem();
 * await loadFromDisk(mirage, "/path/to/repo", { target: "/workspace" });
 * ```
 */
export async function loadFromDisk(
	mirage: IFileSystem,
	sourcePath: string,
	options?: LoadFromDiskOptions,
): Promise<void> {
	const target = normalizeTarget(options?.target ?? "/");
	const filter = options?.filter ?? defaultFilter;
	const followSymlinks = options?.followSymlinks ?? false;
	const maxFileBytes = options?.maxFileBytes ?? 10 * 1024 * 1024;

	const absSource = nodePath.resolve(sourcePath);
	const stats = await fs.promises.lstat(absSource);
	if (!stats.isDirectory()) {
		throw new Error(`loadFromDisk: source is not a directory: ${sourcePath}`);
	}

	const ignore = await buildIgnore(absSource, options?.gitignore);

	ensureDir(mirage, target);

	await walkDir(absSource, "", mirage, target, filter, followSymlinks, maxFileBytes, ignore);
}

async function walkDir(
	sourceRoot: string,
	relative: string,
	mirage: IFileSystem,
	target: string,
	filter: (relativePath: string, isDirectory: boolean) => boolean,
	followSymlinks: boolean,
	maxFileBytes: number,
	ignore: GitIgnore | null,
): Promise<void> {
	const absDir = relative === "" ? sourceRoot : nodePath.join(sourceRoot, relative);

	if (ignore) {
		try {
			const localIgnore = await fs.promises.readFile(nodePath.join(absDir, ".gitignore"), "utf8");
			ignore.add(localIgnore, { base: relative });
		} catch {
			// no .gitignore here — that's fine
		}
	}

	const entries = await fs.promises.readdir(absDir, { withFileTypes: true });

	for (const entry of entries) {
		const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
		const miragePath = target === "/" ? `/${childRelative}` : `${target}/${childRelative}`;

		if (entry.isSymbolicLink() && !followSymlinks) {
			if (!filter(childRelative, false)) continue;
			if (ignore?.ignores(childRelative, false)) continue;
			const linkTarget = await fs.promises.readlink(nodePath.join(absDir, entry.name));
			mirage.symlink(linkTarget, miragePath);
			continue;
		}

		const absPath = nodePath.join(absDir, entry.name);
		const stats = followSymlinks
			? await fs.promises.stat(absPath)
			: await fs.promises.lstat(absPath);

		if (stats.isDirectory()) {
			if (!filter(childRelative, true)) continue;
			if (ignore?.ignores(childRelative, true)) continue;
			mirage.mkdir(miragePath, { recursive: true });
			await walkDir(
				sourceRoot,
				childRelative,
				mirage,
				target,
				filter,
				followSymlinks,
				maxFileBytes,
				ignore,
			);
			continue;
		}

		if (stats.isFile()) {
			if (!filter(childRelative, false)) continue;
			if (ignore?.ignores(childRelative, false)) continue;
			if (stats.size > maxFileBytes) {
				throw new Error(
					`loadFromDisk: ${childRelative} is ${stats.size} bytes (max ${maxFileBytes}). ` +
						`Tighten the filter, raise maxFileBytes, or exclude binary assets.`,
				);
			}
			const content = await fs.promises.readFile(absPath, "utf8");
			mirage.writeFile(miragePath, content);
			try {
				mirage.chmod(miragePath, stats.mode & 0o777);
			} catch {
				// Adapter may not support chmod — that's fine.
			}
		}
	}
}

async function buildIgnore(
	sourceRoot: string,
	option: LoadFromDiskOptions["gitignore"],
): Promise<GitIgnore | null> {
	if (!option) return null;
	const ignore = new GitIgnore();
	if (option === true || Array.isArray(option)) {
		try {
			const root = await fs.promises.readFile(nodePath.join(sourceRoot, ".gitignore"), "utf8");
			ignore.add(root);
		} catch {
			// No root .gitignore — still fine, nested ones may exist.
		}
		if (Array.isArray(option)) ignore.add(option);
	}
	return ignore;
}

export interface SaveToDiskOptions {
	/**
	 * If true, the target directory is wiped before writing (recursive rm
	 * then mkdir). Defaults to false — existing files are overwritten but
	 * siblings are left alone.
	 */
	clean?: boolean;
	/**
	 * Create parent directories of `targetPath` if they don't exist.
	 * Defaults to true.
	 */
	mkdirp?: boolean;
}

/**
 * Write the contents of a mirage subtree to a real directory on disk.
 *
 * ```ts
 * await saveToDisk(mirage, "/workspace", "/tmp/snapshot");
 * ```
 */
export async function saveToDisk(
	mirage: IFileSystem,
	sourcePath: string,
	targetPath: string,
	options?: SaveToDiskOptions,
): Promise<void> {
	const clean = options?.clean ?? false;
	const mkdirp = options?.mkdirp ?? true;

	const absTarget = nodePath.resolve(targetPath);
	if (clean) {
		await fs.promises.rm(absTarget, { recursive: true, force: true });
	}
	if (mkdirp) {
		await fs.promises.mkdir(absTarget, { recursive: true });
	}

	const src = normalizeTarget(sourcePath);
	if (!mirage.exists(src)) {
		throw new Error(`saveToDisk: mirage path does not exist: ${src}`);
	}
	const srcStat = mirage.stat(src);
	if (!srcStat.isDirectory()) {
		throw new Error(`saveToDisk: mirage path is not a directory: ${src}`);
	}

	await writeMirageDir(mirage, src, absTarget);
}

async function writeMirageDir(
	mirage: IFileSystem,
	mirageDir: string,
	absDir: string,
): Promise<void> {
	await fs.promises.mkdir(absDir, { recursive: true });
	const entries = mirage.readDir(mirageDir);

	for (const name of entries) {
		const childMirage = mirageDir === "/" ? `/${name}` : `${mirageDir}/${name}`;
		const childAbs = nodePath.join(absDir, name);
		const stat = mirage.lstat(childMirage);

		if (stat.isDirectory()) {
			await writeMirageDir(mirage, childMirage, childAbs);
			continue;
		}

		if (stat.isSymlink()) {
			const target = mirage.readlink(childMirage);
			try {
				await fs.promises.symlink(target, childAbs);
			} catch (err) {
				if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) {
					throw err;
				}
			}
			continue;
		}

		if (stat.isFile()) {
			const content = mirage.readFile(childMirage);
			await fs.promises.writeFile(childAbs, content, "utf8");
			try {
				await fs.promises.chmod(childAbs, stat.mode & 0o777);
			} catch {
				// Best-effort — ignore permission errors on chmod.
			}
		}
	}
}

function ensureDir(mirage: IFileSystem, path: string): void {
	if (path === "/" || path === "") return;
	if (!mirage.exists(path)) {
		mirage.mkdir(path, { recursive: true });
		return;
	}
	const stat = mirage.stat(path);
	if (!stat.isDirectory()) {
		throw new Error(`target exists but is not a directory: ${path}`);
	}
}

function normalizeTarget(path: string): string {
	if (path === "" || path === ".") return "/";
	if (!path.startsWith("/")) return `/${path}`;
	if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
	return path;
}
