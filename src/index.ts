// Core types

export {
	type FileHook,
	type FileHookContext,
	type FileHookResult,
	HookedFileSystem,
	type HookedFileSystemOptions,
	type HookOperation,
	type HookRule,
} from "./adapters/hooked.js";
// Adapters
export { HttpFileSystem, type HttpFileSystemOptions } from "./adapters/http-fs.js";
export { LayeredFileSystem } from "./adapters/layered.js";
export { ObjectFileSystem } from "./adapters/object-fs.js";
export { ReadOnlyFileSystem } from "./adapters/read-only.js";
// The default in-memory implementation
export { VirtualFileSystem, type VirtualFileSystemOptions } from "./filesystem.js";
// Gitignore matcher (browser-safe — pure JS)
export {
	GitIgnore,
	type GitIgnoreAddOptions,
	type GitIgnoreRule,
	matchGitignore,
	parseGitignore,
} from "./gitignore.js";
// Glob
export { globFiles, globMatch, useWasmGlob } from "./glob.js";
export type { MirageNode, NodeMeta, SpecialFileHandlers } from "./node.js";
export {
	createDirectory,
	createFile,
	createSpecialFile,
	createSymlink,
	defaultMeta,
} from "./node.js";
// Path utilities
export {
	basename,
	dirname,
	extname,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
	split,
} from "./path.js";
// Snapshot / restore (full-fidelity — directories, symlinks, modes)
export {
	type FileEncoding,
	restore,
	type Snapshot,
	type SnapshotNode,
	snapshot,
} from "./snapshot.js";
// Built-in tools
export * from "./tools/builtins/index.js";
export type { IFileSystem, MirageMount, MirageMountOptions, MirageStats } from "./types.js";
export type { WasmGlobModule } from "./wasm.js";
