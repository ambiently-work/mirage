export interface NodeMeta {
	mode: number;
	uid: number;
	gid: number;
	atime: number;
	mtime: number;
	ctime: number;
}

export type VfsNode =
	| { kind: "file"; content: string; meta: NodeMeta }
	| { kind: "directory"; children: Map<string, VfsNode>; meta: NodeMeta }
	| { kind: "symlink"; target: string; meta: NodeMeta };

export function defaultMeta(mode: number): NodeMeta {
	const now = Date.now();
	return {
		mode,
		uid: 0,
		gid: 0,
		atime: now,
		mtime: now,
		ctime: now,
	};
}

export function createFile(content: string = "", mode: number = 0o644): VfsNode {
	return {
		kind: "file",
		content,
		meta: defaultMeta(mode),
	};
}

export function createDirectory(mode: number = 0o755): VfsNode {
	return {
		kind: "directory",
		children: new Map(),
		meta: defaultMeta(mode),
	};
}

export function createSymlink(target: string): VfsNode {
	return {
		kind: "symlink",
		target,
		meta: defaultMeta(0o777),
	};
}
