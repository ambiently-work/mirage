/**
 * Browser-safe in-process git for Mirage. Bundled engines: `IsoGitBackend`
 * (isomorphic-git, pure JS, default) and `LibGit2Backend` (wasm-git, libgit2
 * compiled to WASM).
 *
 * For cli/`git`-binary loaders, see `@ambiently-work/mirage/git-cli` (Node-only).
 */

export type { PromiseFsClientShape } from "./fs-adapter.js";
export { makeIsoGitFs } from "./fs-adapter.js";
export { IsoGitBackend, type IsoGitBackendOptions } from "./iso-backend.js";
export { LibGit2Backend, type LibGit2BackendOptions } from "./libgit2-backend.js";
export { MirageGit, type MirageGitOptions } from "./mirage-git.js";
export type {
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
