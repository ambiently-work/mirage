import { VirtualFileSystem } from "./filesystem.js";
import type { MirageNode, NodeMeta } from "./node.js";
import { encodeUtf8 } from "./node.js";

/**
 * Full-fidelity snapshot of a {@link VirtualFileSystem}. Captures the entire
 * tree — directories, symlinks, file modes, ownership, and timestamps — in a
 * JSON-serializable form suitable for "put away and restore later."
 *
 * The schema is stable across minor versions; breaking changes bump `version`.
 *
 * Since v2 file contents are stored byte-exact. Plain UTF-8 text uses
 * `{ encoding: "utf8", content: string }`; everything else falls back to
 * `{ encoding: "base64", content: string }`. Older `version: 1` snapshots
 * (UTF-8-only text content) are still accepted by `restore()`.
 */
export interface Snapshot {
	version: 1 | 2;
	createdAt: number;
	root: SnapshotNode;
}

export type FileEncoding = "utf8" | "base64";

export type SnapshotNode =
	| {
			kind: "file";
			content: string;
			/** Defaults to "utf8" for legacy version-1 snapshots. */
			encoding?: FileEncoding;
			meta: NodeMeta;
	  }
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
		version: 2,
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
	if (snap.version !== 1 && snap.version !== 2) {
		throw new Error(`unsupported snapshot version: ${snap.version}`);
	}
	if (snap.root.kind !== "directory") {
		throw new Error("snapshot root must be a directory");
	}
	const fs = new VirtualFileSystem({ ...options, bare: true });
	fs.setRoot(snapshotToNode(snap.root, new Map()));
	return fs;
}

function nodeToSnapshot(node: MirageNode): SnapshotNode {
	if (node.kind === "file") {
		const decoded = tryDecodeUtf8(node.content);
		if (decoded !== null) {
			return {
				kind: "file",
				encoding: "utf8",
				content: decoded,
				meta: { ...node.meta },
			};
		}
		return {
			kind: "file",
			encoding: "base64",
			content: bytesToBase64(node.content),
			meta: { ...node.meta },
		};
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

function snapshotToNode(snap: SnapshotNode, hardlinks: Map<number, MirageNode>): MirageNode {
	if (snap.kind === "file") {
		if (snap.meta.nlink && snap.meta.nlink > 1 && snap.meta.ino) {
			const existing = hardlinks.get(snap.meta.ino);
			if (existing) return existing;
		}
		const encoding = snap.encoding ?? "utf8";
		const bytes = encoding === "base64" ? base64ToBytes(snap.content) : encodeUtf8(snap.content);
		const node: MirageNode = { kind: "file", content: bytes, meta: { ...snap.meta } };
		if (snap.meta.nlink && snap.meta.nlink > 1 && snap.meta.ino) {
			hardlinks.set(snap.meta.ino, node);
		}
		return node;
	}
	if (snap.kind === "symlink") {
		return { kind: "symlink", target: snap.target, meta: { ...snap.meta } };
	}
	const children = new Map<string, MirageNode>();
	for (const [name, child] of Object.entries(snap.children)) {
		children.set(name, snapshotToNode(child, hardlinks));
	}
	return { kind: "directory", children, meta: { ...snap.meta } };
}

/** Round-trip-safe UTF-8 decode. Returns null if the bytes aren't valid UTF-8. */
function tryDecodeUtf8(bytes: Uint8Array): string | null {
	try {
		const dec = new TextDecoder("utf-8", { fatal: true });
		const text = dec.decode(bytes);
		// Round-trip check: if re-encoding doesn't match the input, the text
		// contained replacement characters — fall back to base64.
		const reencoded = encodeUtf8(text);
		if (reencoded.length !== bytes.length) return null;
		for (let i = 0; i < bytes.length; i++) {
			if (reencoded[i] !== bytes[i]) return null;
		}
		return text;
	} catch {
		return null;
	}
}

function bytesToBase64(bytes: Uint8Array): string {
	if (typeof Buffer !== "undefined") {
		return Buffer.from(bytes).toString("base64");
	}
	// Browser fallback.
	let s = "";
	for (let i = 0; i < bytes.length; i++) {
		s += String.fromCharCode(bytes[i] as number);
	}
	return btoa(s);
}

function base64ToBytes(s: string): Uint8Array {
	if (typeof Buffer !== "undefined") {
		return new Uint8Array(Buffer.from(s, "base64"));
	}
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
