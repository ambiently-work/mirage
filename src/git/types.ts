/**
 * Public types for the in-process git layer. Shared by both the
 * `IsoGitBackend` (isomorphic-git) and `LibGit2Backend` (wasm-git) backends so
 * callers can swap engines without touching their code.
 */

import type { IFileSystem } from "../types.js";

/** A `Name <email>` identity. Used for author/committer fields. */
export interface GitIdentity {
	name: string;
	email: string;
	/** Unix seconds since epoch. Defaults to "now" when omitted. */
	timestamp?: number;
	/** Minutes east of UTC (e.g. -300 for EST). Defaults to local. */
	timezoneOffset?: number;
}

export interface CommitInfo {
	oid: string;
	tree: string;
	parents: string[];
	author: GitIdentity & { timestamp: number; timezoneOffset: number };
	committer: GitIdentity & { timestamp: number; timezoneOffset: number };
	message: string;
}

/**
 * One row of the working-tree-vs-index-vs-HEAD status matrix.
 *
 * - `head`     — file present at HEAD (1) or absent (0).
 * - `workdir`  — 0=absent, 1=identical to HEAD, 2=different.
 * - `stage`    — 0=absent in index, 1=identical to HEAD, 2=identical to workdir, 3=different from both.
 *
 * This is iso-git's matrix format — well-defined and used for both engines so
 * the meaning of "modified" / "staged" is identical regardless of backend.
 */
export type StatusRow = [filepath: string, head: 0 | 1, workdir: 0 | 1 | 2, stage: 0 | 1 | 2 | 3];

export interface DiffEntry {
	path: string;
	/** Set to true if the file was added in `b` and not in `a`. */
	added: boolean;
	/** Set to true if the file was removed in `b`. */
	removed: boolean;
	/** Object id of the blob in `a`, or null if absent. */
	aOid: string | null;
	/** Object id of the blob in `b`, or null if absent. */
	bOid: string | null;
}

export interface CloneOptions {
	url: string;
	/** Branch, tag, or commit SHA. Defaults to the remote's HEAD. */
	ref?: string;
	/** Shallow-clone depth. Defaults to 1; pass `Infinity` for full history. */
	depth?: number;
	/** Single-branch clone. Defaults to true (paired with `depth`). */
	singleBranch?: boolean;
	/** CORS proxy URL for browser clones across origins. */
	corsProxy?: string;
	/** HTTP basic auth callback. Receives the URL each retry. */
	onAuth?: (url: string) => { username?: string; password?: string } | undefined;
	/** Extra HTTP headers (auth tokens, etc.). */
	headers?: Record<string, string>;
}

export interface InitOptions {
	defaultBranch?: string;
}

export interface AddOptions {
	/** File or directory paths to stage, relative to `dir`. */
	filepaths: string[];
	/** Stage even if the path is gitignored. */
	force?: boolean;
}

export interface CommitOptions {
	message: string;
	author?: GitIdentity;
	committer?: GitIdentity;
	/** Replace HEAD instead of creating a new commit. */
	amend?: boolean;
}

export interface LogOptions {
	/** Branch / tag / commit SHA. Defaults to HEAD. */
	ref?: string;
	/** Restrict to history touching this path. */
	filepath?: string;
	depth?: number;
	since?: Date;
}

export interface BranchOptions {
	ref: string;
	/** Move HEAD to the new branch. */
	checkout?: boolean;
	/** Force update even if the ref already exists. */
	force?: boolean;
}

export interface CheckoutOptions {
	ref: string;
	filepaths?: string[];
	/** Don't touch the working tree. */
	noCheckout?: boolean;
	force?: boolean;
}

export interface PushOptions {
	url?: string;
	remote?: string;
	ref?: string;
	remoteRef?: string;
	force?: boolean;
	corsProxy?: string;
	onAuth?: CloneOptions["onAuth"];
	headers?: Record<string, string>;
}

export interface PullOptions extends Omit<PushOptions, "force"> {
	fastForwardOnly?: boolean;
	author?: GitIdentity;
}

export interface DiffOptions {
	/** Tree-ish for the `a` side. Defaults to HEAD. */
	a?: string;
	/** Tree-ish for the `b` side. Defaults to the working tree. */
	b?: string;
}

/** Configuration handed to a backend at construction time. */
export interface BackendContext {
	/** The mirage backing the working tree. */
	fs: IFileSystem;
	/** Working-tree directory inside `fs` (e.g. "/workspace"). */
	dir: string;
	/**
	 * Where the `.git/` directory lives.
	 * - String: a path inside `fs`. Defaults to `${dir}/.git`.
	 * - IFileSystem: a separate filesystem mounted internally so `.git/`
	 *   never appears in the working-tree FS (sidecar mode).
	 */
	gitdir: string | IFileSystem;
}

/**
 * Common surface implemented by every backend. The high-level `MirageGit`
 * class dispatches to one of these.
 */
export interface GitBackend {
	readonly name: "iso-git" | "libgit2-wasm";
	init(ctx: BackendContext, opts?: InitOptions): Promise<void>;
	clone(ctx: BackendContext, opts: CloneOptions): Promise<void>;
	status(ctx: BackendContext): Promise<StatusRow[]>;
	add(ctx: BackendContext, opts: AddOptions): Promise<void>;
	commit(ctx: BackendContext, opts: CommitOptions): Promise<string>;
	log(ctx: BackendContext, opts?: LogOptions): Promise<CommitInfo[]>;
	branch(ctx: BackendContext, opts: BranchOptions): Promise<void>;
	listBranches(ctx: BackendContext): Promise<string[]>;
	currentBranch(ctx: BackendContext): Promise<string | undefined>;
	checkout(ctx: BackendContext, opts: CheckoutOptions): Promise<void>;
	resolveRef(ctx: BackendContext, ref: string): Promise<string>;
	readBlob(ctx: BackendContext, oid: string, filepath?: string): Promise<Uint8Array>;
	diff(ctx: BackendContext, opts?: DiffOptions): Promise<DiffEntry[]>;
	push?(ctx: BackendContext, opts: PushOptions): Promise<void>;
	pull?(ctx: BackendContext, opts: PullOptions): Promise<void>;
	listRemotes(ctx: BackendContext): Promise<{ remote: string; url: string }[]>;
	addRemote(ctx: BackendContext, remote: string, url: string): Promise<void>;
}
