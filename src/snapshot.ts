import { VirtualFileSystem } from "./filesystem.js";
import type { MirageNode, NodeMeta } from "./node.js";

/**
 * Full-fidelity snapshot of a {@link VirtualFileSystem}. Unlike
 * `VirtualFileSystem#snapshot()` (which returns a flat `Record<string,string>`
 * of file contents only), this captures the entire tree — directories,
 * symlinks, file modes, ownership, and timestamps — in a JSON-serializable
 * form suitable for "put away and restore later."
 *
 * The schema is stable across minor versions; breaking changes bump `version`.
 */
export interface Snapshot {
	version: 1;
	createdAt: number;
	root: SnapshotNode;
}

export type SnapshotNode =
	| { kind: "file"; content: string; meta: NodeMeta }
	| { kind: "directory"; children: Record<string, SnapshotNode>; meta: NodeMeta }
	| { kind: "symlink"; target: string; meta: NodeMeta };

/**
 * Capture the full state of a {@link VirtualFileSystem} into a serializable
 * object. Round-trippable through `restore()`.
 *
 * Mounts are NOT captured — only the underlying in-process tree. If you need
 * to round-trip through mounts, capture each mounted filesystem separately.
 */
export function snapshot(fs: VirtualFileSystem): Snapshot {
	return {
		version: 1,
		createdAt: Date.now(),
		root: nodeToSnapshot(fs.getRoot()),
	};
}

/**
 * Rehydrate a {@link VirtualFileSystem} from a previously captured snapshot.
 * Returns a fresh `VirtualFileSystem` with the snapshot's tree installed as
 * its root. The default POSIX directory tree is NOT overlaid — the snapshot
 * is authoritative.
 *
 * Throws if the snapshot's version is unsupported.
 */
export function restore(
	snap: Snapshot,
	options?: { cwd?: string; uid?: number; gid?: number },
): VirtualFileSystem {
	if (snap.version !== 1) {
		throw new Error(`unsupported snapshot version: ${snap.version}`);
	}
	if (snap.root.kind !== "directory") {
		throw new Error("snapshot root must be a directory");
	}
	const fs = new VirtualFileSystem({ ...options, bare: true });
	fs.setRoot(snapshotToNode(snap.root));
	return fs;
}

function nodeToSnapshot(node: MirageNode): SnapshotNode {
	if (node.kind === "file") {
		return { kind: "file", content: node.content, meta: { ...node.meta } };
	}
	if (node.kind === "symlink") {
		return { kind: "symlink", target: node.target, meta: { ...node.meta } };
	}
	const children: Record<string, SnapshotNode> = {};
	for (const [name, child] of node.children) {
		children[name] = nodeToSnapshot(child);
	}
	return { kind: "directory", children, meta: { ...node.meta } };
}

function snapshotToNode(snap: SnapshotNode): MirageNode {
	if (snap.kind === "file") {
		return { kind: "file", content: snap.content, meta: { ...snap.meta } };
	}
	if (snap.kind === "symlink") {
		return { kind: "symlink", target: snap.target, meta: { ...snap.meta } };
	}
	const children = new Map<string, MirageNode>();
	for (const [name, child] of Object.entries(snap.children)) {
		children.set(name, snapshotToNode(child));
	}
	return { kind: "directory", children, meta: { ...snap.meta } };
}
