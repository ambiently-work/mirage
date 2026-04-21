// Core types

// Adapters
export { HttpFileSystem, type HttpFileSystemOptions } from "./adapters/http-fs.js";
export { LayeredFileSystem } from "./adapters/layered.js";
export { ObjectFileSystem } from "./adapters/object-fs.js";
export { ReadOnlyFileSystem } from "./adapters/read-only.js";
// The default in-memory implementation
export { VirtualFileSystem, type VirtualFileSystemOptions } from "./filesystem.js";
// Glob
export { globFiles, globMatch, useWasmGlob } from "./glob.js";
export type { NodeMeta, VfsNode } from "./node.js";
export { createDirectory, createFile, createSymlink, defaultMeta } from "./node.js";
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
export { restore, type Snapshot, type SnapshotNode, snapshot } from "./snapshot.js";
export type { IFileSystem, VfsStats } from "./types.js";
export type { WasmGlobModule } from "./wasm.js";
