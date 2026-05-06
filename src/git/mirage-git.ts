/**
 * High-level git facade. Holds the working-tree fs, the gitdir location, an
 * author identity, and a backend; dispatches operations.
 *
 * Two backends are bundled (`IsoGitBackend`, `LibGit2Backend`); pass either
 * (or any other `GitBackend` implementation).
 */

import type { IFileSystem } from "../types.js";
import type {
	AddOptions,
	BackendContext,
	BranchOptions,
	CheckoutOptions,
	CloneOptions,
	CommitInfo,
	CommitOptions,
	DiffEntry,
	DiffOptions,
	GitBackend,
	GitIdentity,
	InitOptions,
	LogOptions,
	PullOptions,
	PushOptions,
	StatusRow,
} from "./types.js";

export interface MirageGitOptions {
	/** Working-tree filesystem. */
	fs: IFileSystem;
	/** Working-tree directory inside `fs` (defaults to `/`). */
	dir?: string;
	/**
	 * Where the `.git/` directory lives.
	 * - String: a path inside `fs`. Defaults to `${dir}/.git` (in-tree).
	 * - IFileSystem: a sidecar filesystem; nothing about `.git/` ever appears
	 *   in the working-tree mirage. Use this when you want `snapshot(fs)` of
	 *   the working tree to be lean.
	 */
	gitdir?: string | IFileSystem;
	/** Backend engine. Required — pass an `IsoGitBackend` or `LibGit2Backend`. */
	backend: GitBackend;
	/** Default identity for commits when not overridden per-call. */
	defaultAuthor?: GitIdentity;
}

export class MirageGit {
	readonly backend: GitBackend;
	readonly fs: IFileSystem;
	readonly dir: string;
	readonly gitdir: string | IFileSystem;
	defaultAuthor?: GitIdentity;

	constructor(opts: MirageGitOptions) {
		this.fs = opts.fs;
		this.dir = opts.dir ?? "/";
		this.gitdir = opts.gitdir ?? `${trimTrailingSlash(this.dir)}/.git`;
		this.backend = opts.backend;
		this.defaultAuthor = opts.defaultAuthor;
	}

	private ctx(): BackendContext {
		return { fs: this.fs, dir: this.dir, gitdir: this.gitdir };
	}

	init(opts?: InitOptions): Promise<void> {
		return this.backend.init(this.ctx(), opts);
	}

	clone(opts: CloneOptions): Promise<void> {
		return this.backend.clone(this.ctx(), opts);
	}

	status(): Promise<StatusRow[]> {
		return this.backend.status(this.ctx());
	}

	add(filepathsOrOpts: string | string[] | AddOptions): Promise<void> {
		const opts: AddOptions =
			typeof filepathsOrOpts === "string"
				? { filepaths: [filepathsOrOpts] }
				: Array.isArray(filepathsOrOpts)
					? { filepaths: filepathsOrOpts }
					: filepathsOrOpts;
		return this.backend.add(this.ctx(), opts);
	}

	async commit(opts: CommitOptions): Promise<string> {
		const author = opts.author ?? this.defaultAuthor;
		if (!author) {
			throw new Error("commit: no author provided and no defaultAuthor configured");
		}
		return this.backend.commit(this.ctx(), { ...opts, author });
	}

	log(opts?: LogOptions): Promise<CommitInfo[]> {
		return this.backend.log(this.ctx(), opts);
	}

	branch(opts: BranchOptions): Promise<void> {
		return this.backend.branch(this.ctx(), opts);
	}

	listBranches(): Promise<string[]> {
		return this.backend.listBranches(this.ctx());
	}

	currentBranch(): Promise<string | undefined> {
		return this.backend.currentBranch(this.ctx());
	}

	checkout(opts: CheckoutOptions): Promise<void> {
		return this.backend.checkout(this.ctx(), opts);
	}

	resolveRef(ref: string): Promise<string> {
		return this.backend.resolveRef(this.ctx(), ref);
	}

	readBlob(oid: string, filepath?: string): Promise<Uint8Array> {
		return this.backend.readBlob(this.ctx(), oid, filepath);
	}

	diff(opts?: DiffOptions): Promise<DiffEntry[]> {
		return this.backend.diff(this.ctx(), opts);
	}

	push(opts: PushOptions): Promise<void> {
		if (!this.backend.push) {
			throw new Error(`backend ${this.backend.name} does not support push`);
		}
		return this.backend.push(this.ctx(), opts);
	}

	pull(opts: PullOptions): Promise<void> {
		if (!this.backend.pull) {
			throw new Error(`backend ${this.backend.name} does not support pull`);
		}
		return this.backend.pull(this.ctx(), opts);
	}

	listRemotes(): Promise<{ remote: string; url: string }[]> {
		return this.backend.listRemotes(this.ctx());
	}

	addRemote(remote: string, url: string): Promise<void> {
		return this.backend.addRemote(this.ctx(), remote, url);
	}
}

function trimTrailingSlash(s: string): string {
	return s.length > 1 && s.endsWith("/") ? s.slice(0, -1) : s;
}
