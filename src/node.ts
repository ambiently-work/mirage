export interface NodeMeta {
	mode: number;
	uid: number;
	gid: number;
	atime: number;
	mtime: number;
	ctime: number;
	/**
	 * Per-file write revision. Starts at 0 and increments on each `writeFile` /
	 * `writeFileBytes`. Surfaced via `MirageStats.rev` so callers (notably the
	 * iso-git fs adapter) can derive a stable-but-changing pseudo-inode that
	 * defeats stat caches across sub-second-resolution mtime collisions.
	 */
	rev: number;
}

export interface SpecialFileHandlers {
	read?: (path: string) => string | Uint8Array;
	write?: (path: string, content: Uint8Array) => void;
	append?: (path: string, content: Uint8Array) => void;
	size?: number | (() => number);
}

export type MirageNode =
	| { kind: "file"; content: Uint8Array; meta: NodeMeta }
	| { kind: "directory"; children: Map<string, MirageNode>; meta: NodeMeta }
	| { kind: "symlink"; target: string; meta: NodeMeta }
	| { kind: "special"; handlers: SpecialFileHandlers; meta: NodeMeta };

export function defaultMeta(mode: number): NodeMeta {
	const now = Date.now();
	return {
		mode,
		uid: 0,
		gid: 0,
		atime: now,
		mtime: now,
		ctime: now,
		rev: 0,
	};
}

export function createFile(content: string | Uint8Array = "", mode: number = 0o644): MirageNode {
	return {
		kind: "file",
		content: typeof content === "string" ? encodeUtf8(content) : content,
		meta: defaultMeta(mode),
	};
}

export function createDirectory(mode: number = 0o755): MirageNode {
	return {
		kind: "directory",
		children: new Map(),
		meta: defaultMeta(mode),
	};
}

export function createSymlink(target: string): MirageNode {
	return {
		kind: "symlink",
		target,
		meta: defaultMeta(0o777),
	};
}

export function createSpecialFile(handlers: SpecialFileHandlers, mode: number = 0o666): MirageNode {
	return {
		kind: "special",
		handlers,
		meta: defaultMeta(mode),
	};
}

const _enc = new TextEncoder();
const _dec = new TextDecoder("utf-8", { fatal: false });

export function encodeUtf8(s: string): Uint8Array {
	return _enc.encode(s);
}

export function decodeUtf8(bytes: Uint8Array): string {
	return _dec.decode(bytes);
}
