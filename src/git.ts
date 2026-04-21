/**
 * Node-only helpers for loading a git repository (URL or local working tree)
 * into a mirage VFS, and saving a VFS subtree back out as a git repo.
 *
 * This module is NOT imported from the main `@ambiently-work/vfs` entry point —
 * access it via `@ambiently-work/vfs/git`. Keeps the core browser-safe.
 *
 * Requires the `git` binary on `PATH` for clone / commit operations.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import {
	type LoadFromDiskOptions,
	loadFromDisk,
	type SaveToDiskOptions,
	saveToDisk,
} from "./disk.js";
import type { IFileSystem } from "./types.js";

const execFileP = promisify(execFile);

/**
 * Information about the git source loaded into the VFS. Returned by
 * {@link loadFromGit} so callers can attribute changes back to a commit.
 */
export interface GitMetadata {
	/** Original `source` argument passed in. */
	source: string;
	/** Resolved absolute path on disk to the working tree that was read. */
	workingTreePath: string;
	/** `true` if the repo was cloned to a temp directory just for this call. */
	cloned: boolean;
	/** Branch name (`HEAD` ref short name) at the time of load, if available. */
	branch?: string;
	/** Full commit SHA of `HEAD`, if available. */
	commit?: string;
	/** Subject line of the `HEAD` commit, if available. */
	commitMessage?: string;
	/** Author of the `HEAD` commit (`Name <email>` form), if available. */
	commitAuthor?: string;
	/** First `origin` remote URL, if configured. */
	remoteUrl?: string;
}

export interface LoadFromGitOptions extends Omit<LoadFromDiskOptions, "filter"> {
	/**
	 * Branch, tag, or commit SHA to check out. For URL clones, passed to
	 * `git clone --branch` (works for branches and tags); commits are
	 * checked out after cloning.
	 */
	ref?: string;
	/**
	 * Shallow-clone depth. Only applies when `source` is a URL. Defaults to
	 * `1` for fast clones; pass `Infinity` (or `0`) for a full history.
	 */
	depth?: number;
	/**
	 * Initialise/clone submodules. Defaults to `false`.
	 */
	submodules?: boolean;
	/**
	 * Include untracked-but-not-gitignored files in the working tree.
	 * Defaults to `true` so that loading a local checkout with uncommitted
	 * work-in-progress behaves how users expect. Ignored files are always
	 * skipped (use {@link LoadFromDiskOptions} directly if you want them).
	 */
	includeUntracked?: boolean;
	/**
	 * Extra filter applied on top of `git ls-files` results. Same signature
	 * as {@link LoadFromDiskOptions.filter}.
	 */
	filter?: (relativePath: string, isDirectory: boolean) => boolean;
	/**
	 * If `true`, keep the cloned temp directory after loading. The path is
	 * exposed via the returned {@link GitMetadata.workingTreePath}. Defaults
	 * to `false` — temp clones are removed after the VFS has been hydrated.
	 */
	keepClone?: boolean;
}

/**
 * Load a git repository into the VFS. `source` may be a remote URL
 * (https/ssh/git/scp-style) or a local path. Local paths use
 * `git ls-files` to enumerate tracked + (optionally) untracked files, so
 * `.gitignore` rules and `core.excludesfile` are respected automatically.
 *
 * ```ts
 * import { VirtualFileSystem } from "@ambiently-work/vfs";
 * import { loadFromGit } from "@ambiently-work/vfs/git";
 *
 * const vfs = new VirtualFileSystem();
 * const meta = await loadFromGit(vfs, "https://github.com/foo/bar", {
 *   ref: "v1.2.3",
 *   target: "/workspace",
 * });
 * console.log(meta.commit); // "deadbeef..."
 * ```
 */
export async function loadFromGit(
	vfs: IFileSystem,
	source: string,
	options?: LoadFromGitOptions,
): Promise<GitMetadata> {
	const target = options?.target ?? "/";
	const includeUntracked = options?.includeUntracked ?? true;
	const followSymlinks = options?.followSymlinks ?? false;
	const maxFileBytes = options?.maxFileBytes ?? 10 * 1024 * 1024;
	const userFilter = options?.filter;

	let workingTree: string;
	let cloned = false;

	if (looksLikeGitUrl(source)) {
		workingTree = await cloneRepo(source, {
			ref: options?.ref,
			depth: options?.depth,
			submodules: options?.submodules,
		});
		cloned = true;
	} else {
		workingTree = nodePath.resolve(source);
		const stat = await fs.promises.lstat(workingTree).catch(() => null);
		if (!stat?.isDirectory()) {
			throw new Error(`loadFromGit: source is not a directory: ${source}`);
		}
		if (options?.ref) {
			// Local checkout-of-a-ref is destructive; refuse rather than mutate
			// the user's working tree behind their back.
			throw new Error(
				"loadFromGit: `ref` is only supported when cloning a URL — " +
					"check out the ref yourself before pointing at a local path.",
			);
		}
	}

	try {
		const isRepo = await isGitRepo(workingTree);
		if (!isRepo) {
			// No `.git` — fall back to plain disk load, applying any user filter.
			await loadFromDisk(vfs, workingTree, {
				target,
				followSymlinks,
				maxFileBytes,
				filter: userFilter,
				gitignore: true,
			});
			return {
				source,
				workingTreePath: workingTree,
				cloned,
			};
		}

		const files = await listGitFiles(workingTree, includeUntracked);
		await hydrateFromList(vfs, workingTree, target, files, {
			followSymlinks,
			maxFileBytes,
			filter: userFilter,
		});

		const metadata = await readGitMetadata(workingTree);
		return {
			source,
			workingTreePath: workingTree,
			cloned,
			...metadata,
		};
	} finally {
		if (cloned && !options?.keepClone) {
			await fs.promises.rm(workingTree, { recursive: true, force: true });
		}
	}
}

export interface SaveAsGitRepoOptions extends SaveToDiskOptions {
	/**
	 * Initialise the target directory as a git repo if it isn't one already.
	 * Defaults to `true`.
	 */
	init?: boolean;
	/**
	 * Initial branch name when running `git init`. Defaults to `"main"`.
	 * Ignored if the directory is already a git repo.
	 */
	branch?: string;
	/**
	 * Stage all files and create a commit. Pass an object with `message` to
	 * enable; omit (or pass `false`) to skip committing.
	 */
	commit?:
		| false
		| {
				message: string;
				author?: { name: string; email: string };
		  };
	/**
	 * Add a remote (e.g. `origin`) after init. No-op if the repo already has
	 * a remote with that name.
	 */
	remote?: { name: string; url: string };
}

/**
 * Write the contents of a VFS subtree to disk and (by default) initialise it
 * as a git repository. Useful for handing an agent's scratch workspace back
 * to a real git workflow — clone → edit in VFS → commit & push.
 *
 * ```ts
 * await saveAsGitRepo(vfs, "/workspace", "/tmp/out", {
 *   commit: {
 *     message: "feat: agent edits",
 *     author: { name: "Agent", email: "agent@example.com" },
 *   },
 * });
 * ```
 */
export async function saveAsGitRepo(
	vfs: IFileSystem,
	vfsPath: string,
	targetPath: string,
	options?: SaveAsGitRepoOptions,
): Promise<void> {
	const init = options?.init ?? true;
	const branch = options?.branch ?? "main";

	await saveToDisk(vfs, vfsPath, targetPath, {
		clean: options?.clean,
		mkdirp: options?.mkdirp,
	});

	const absTarget = nodePath.resolve(targetPath);

	if (init && !(await isGitRepo(absTarget))) {
		await runGit(absTarget, ["init", "--initial-branch", branch]);
	}

	if (options?.remote && (await isGitRepo(absTarget))) {
		const existing = await runGitNullable(absTarget, ["remote"]);
		const remotes = existing?.split("\n").filter(Boolean) ?? [];
		if (!remotes.includes(options.remote.name)) {
			await runGit(absTarget, ["remote", "add", options.remote.name, options.remote.url]);
		}
	}

	if (options?.commit && (await isGitRepo(absTarget))) {
		await runGit(absTarget, ["add", "-A"]);
		const env: NodeJS.ProcessEnv = { ...process.env };
		if (options.commit.author) {
			env.GIT_AUTHOR_NAME = options.commit.author.name;
			env.GIT_AUTHOR_EMAIL = options.commit.author.email;
			env.GIT_COMMITTER_NAME = options.commit.author.name;
			env.GIT_COMMITTER_EMAIL = options.commit.author.email;
		}
		// `git commit` exits 1 with no changes — surface a clearer message.
		const status = await runGit(absTarget, ["status", "--porcelain"]);
		if (status.trim() === "") {
			return;
		}
		await runGit(absTarget, ["commit", "-m", options.commit.message], { env });
	}
}

/**
 * Probe a directory and read `HEAD` ref / commit / remote metadata.
 * Returns an empty object when the directory is not a git repo.
 */
export async function readGitMetadata(repoPath: string): Promise<Partial<GitMetadata>> {
	const abs = nodePath.resolve(repoPath);
	if (!(await isGitRepo(abs))) return {};

	const branch = await runGitNullable(abs, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const commit = await runGitNullable(abs, ["rev-parse", "HEAD"]);
	const subject = await runGitNullable(abs, ["log", "-1", "--pretty=%s"]);
	const author = await runGitNullable(abs, ["log", "-1", "--pretty=%an <%ae>"]);
	const remote = await runGitNullable(abs, ["config", "--get", "remote.origin.url"]);

	return {
		branch: branch?.trim() || undefined,
		commit: commit?.trim() || undefined,
		commitMessage: subject?.trim() || undefined,
		commitAuthor: author?.trim() || undefined,
		remoteUrl: remote?.trim() || undefined,
	};
}

/** Heuristic: does this string look like something we'd hand to `git clone`? */
export function looksLikeGitUrl(source: string): boolean {
	if (/^(https?|git|ssh|file):\/\//.test(source)) return true;
	// scp-style: user@host:path
	if (/^[\w.-]+@[\w.-]+:[\w./~-]+/.test(source)) return true;
	return false;
}

async function cloneRepo(
	url: string,
	options: { ref?: string; depth?: number; submodules?: boolean },
): Promise<string> {
	const tmp = await fs.promises.mkdtemp(nodePath.join(os.tmpdir(), "mirage-clone-"));
	const args = ["clone"];
	const depth = options.depth;
	if (depth !== undefined && depth !== Infinity && depth > 0) {
		args.push("--depth", String(depth));
	}
	if (options.submodules) args.push("--recurse-submodules");
	if (options.ref) {
		// Try --branch first; fall back to a post-clone checkout for commit SHAs.
		args.push("--branch", options.ref);
	}
	args.push(url, tmp);
	try {
		await runGit(process.cwd(), args);
	} catch (err) {
		if (options.ref) {
			// `--branch` fails on commit SHAs; retry without it then check out.
			await fs.promises.rm(tmp, { recursive: true, force: true });
			const tmp2 = await fs.promises.mkdtemp(nodePath.join(os.tmpdir(), "mirage-clone-"));
			const fallback = ["clone"];
			if (options.submodules) fallback.push("--recurse-submodules");
			fallback.push(url, tmp2);
			await runGit(process.cwd(), fallback);
			await runGit(tmp2, ["checkout", options.ref]);
			return tmp2;
		}
		await fs.promises.rm(tmp, { recursive: true, force: true });
		throw err;
	}
	return tmp;
}

async function isGitRepo(dir: string): Promise<boolean> {
	const result = await runGitNullable(dir, ["rev-parse", "--is-inside-work-tree"]);
	return result?.trim() === "true";
}

async function listGitFiles(repoPath: string, includeUntracked: boolean): Promise<string[]> {
	const args = ["ls-files", "-z"];
	if (includeUntracked) {
		args.push("--others", "--exclude-standard", "--cached");
	}
	const out = await runGit(repoPath, args);
	return out.split("\0").filter((p) => p !== "");
}

interface HydrateOptions {
	followSymlinks: boolean;
	maxFileBytes: number;
	filter?: (relativePath: string, isDirectory: boolean) => boolean;
}

async function hydrateFromList(
	vfs: IFileSystem,
	root: string,
	target: string,
	files: string[],
	options: HydrateOptions,
): Promise<void> {
	const normalisedTarget = normalizeTarget(target);
	ensureDir(vfs, normalisedTarget);

	for (const rel of files) {
		if (options.filter && !options.filter(rel, false)) continue;

		const absPath = nodePath.join(root, rel);
		const vfsPath = normalisedTarget === "/" ? `/${rel}` : `${normalisedTarget}/${rel}`;

		const stat = options.followSymlinks
			? await fs.promises.stat(absPath).catch(() => null)
			: await fs.promises.lstat(absPath).catch(() => null);
		if (!stat) continue; // file may have been deleted between ls-files and now

		// Make sure intermediate dirs exist
		const parent = vfsPath.substring(0, vfsPath.lastIndexOf("/")) || "/";
		if (parent !== "/") vfs.mkdir(parent, { recursive: true });

		if (stat.isSymbolicLink() && !options.followSymlinks) {
			const linkTarget = await fs.promises.readlink(absPath);
			vfs.symlink(linkTarget, vfsPath);
			continue;
		}

		if (stat.isDirectory()) {
			// `ls-files` won't list dirs by themselves except for submodules — skip
			// (sub-files will be created above).
			continue;
		}

		if (stat.isFile()) {
			if (stat.size > options.maxFileBytes) {
				throw new Error(
					`loadFromGit: ${rel} is ${stat.size} bytes (max ${options.maxFileBytes}). ` +
						`Tighten the filter or raise maxFileBytes.`,
				);
			}
			const content = await fs.promises.readFile(absPath, "utf8");
			vfs.writeFile(vfsPath, content);
			try {
				vfs.chmod(vfsPath, stat.mode & 0o777);
			} catch {
				// chmod is best-effort.
			}
		}
	}
}

async function runGit(
	cwd: string,
	args: string[],
	options?: { env?: NodeJS.ProcessEnv },
): Promise<string> {
	const { stdout } = await execFileP("git", args, {
		cwd,
		env: options?.env ?? process.env,
		maxBuffer: 64 * 1024 * 1024,
	});
	return stdout;
}

async function runGitNullable(cwd: string, args: string[]): Promise<string | null> {
	try {
		return await runGit(cwd, args);
	} catch {
		return null;
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
