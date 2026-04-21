/**
 * Node-only helpers for loading a real directory into a mirage VFS, and
 * writing a VFS (or part of it) back out to disk.
 *
 * This module is NOT imported from the main `@ambiently-work/vfs` entry
 * point — access it via `@ambiently-work/vfs/disk`. Keeps the core
 * package browser-safe (no `node:fs` in the import graph).
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { IFileSystem } from "./types.js";

export interface LoadFromDiskOptions {
	/**
	 * Mount point inside the VFS to place files under. Defaults to `/`.
	 * If the target directory does not exist in the VFS, it is created.
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
 * Walk a real directory and hydrate the VFS with its contents.
 *
 * ```ts
 * import { VirtualFileSystem } from "@ambiently-work/vfs";
 * import { loadFromDisk } from "@ambiently-work/vfs/disk";
 *
 * const vfs = new VirtualFileSystem();
 * await loadFromDisk(vfs, "/path/to/repo", { target: "/workspace" });
 * ```
 */
export async function loadFromDisk(
	vfs: IFileSystem,
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

	ensureDir(vfs, target);

	await walkDir(absSource, "", vfs, target, filter, followSymlinks, maxFileBytes);
}

async function walkDir(
	sourceRoot: string,
	relative: string,
	vfs: IFileSystem,
	target: string,
	filter: (relativePath: string, isDirectory: boolean) => boolean,
	followSymlinks: boolean,
	maxFileBytes: number,
): Promise<void> {
	const absDir = relative === "" ? sourceRoot : nodePath.join(sourceRoot, relative);
	const entries = await fs.promises.readdir(absDir, { withFileTypes: true });

	for (const entry of entries) {
		const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
		const vfsPath = target === "/" ? `/${childRelative}` : `${target}/${childRelative}`;

		if (entry.isSymbolicLink() && !followSymlinks) {
			if (!filter(childRelative, false)) continue;
			const linkTarget = await fs.promises.readlink(nodePath.join(absDir, entry.name));
			vfs.symlink(linkTarget, vfsPath);
			continue;
		}

		const absPath = nodePath.join(absDir, entry.name);
		const stats = followSymlinks
			? await fs.promises.stat(absPath)
			: await fs.promises.lstat(absPath);

		if (stats.isDirectory()) {
			if (!filter(childRelative, true)) continue;
			vfs.mkdir(vfsPath, { recursive: true });
			await walkDir(sourceRoot, childRelative, vfs, target, filter, followSymlinks, maxFileBytes);
			continue;
		}

		if (stats.isFile()) {
			if (!filter(childRelative, false)) continue;
			if (stats.size > maxFileBytes) {
				throw new Error(
					`loadFromDisk: ${childRelative} is ${stats.size} bytes (max ${maxFileBytes}). ` +
						`Tighten the filter, raise maxFileBytes, or exclude binary assets.`,
				);
			}
			const content = await fs.promises.readFile(absPath, "utf8");
			vfs.writeFile(vfsPath, content);
			try {
				vfs.chmod(vfsPath, stats.mode & 0o777);
			} catch {
				// Adapter may not support chmod — that's fine.
			}
		}
	}
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
 * Write the contents of a VFS subtree to a real directory on disk.
 *
 * ```ts
 * await saveToDisk(vfs, "/workspace", "/tmp/snapshot");
 * ```
 */
export async function saveToDisk(
	vfs: IFileSystem,
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
	if (!vfs.exists(src)) {
		throw new Error(`saveToDisk: VFS path does not exist: ${src}`);
	}
	const srcStat = vfs.stat(src);
	if (!srcStat.isDirectory()) {
		throw new Error(`saveToDisk: VFS path is not a directory: ${src}`);
	}

	await writeVfsDir(vfs, src, absTarget);
}

async function writeVfsDir(vfs: IFileSystem, vfsDir: string, absDir: string): Promise<void> {
	await fs.promises.mkdir(absDir, { recursive: true });
	const entries = vfs.readDir(vfsDir);

	for (const name of entries) {
		const childVfs = vfsDir === "/" ? `/${name}` : `${vfsDir}/${name}`;
		const childAbs = nodePath.join(absDir, name);
		const stat = vfs.lstat(childVfs);

		if (stat.isDirectory()) {
			await writeVfsDir(vfs, childVfs, childAbs);
			continue;
		}

		if (stat.isSymlink()) {
			const target = vfs.readlink(childVfs);
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
			const content = vfs.readFile(childVfs);
			await fs.promises.writeFile(childAbs, content, "utf8");
			try {
				await fs.promises.chmod(childAbs, stat.mode & 0o777);
			} catch {
				// Best-effort — ignore permission errors on chmod.
			}
		}
	}
}

function ensureDir(vfs: IFileSystem, path: string): void {
	if (path === "/" || path === "") return;
	if (!vfs.exists(path)) {
		vfs.mkdir(path, { recursive: true });
		return;
	}
	const stat = vfs.stat(path);
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
