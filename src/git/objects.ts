import { decodeUtf8 } from "../node.js";
import type { IFileSystem } from "../types.js";

type GitObjectType = "blob" | "tree" | "commit" | "tag";

interface GitObject {
	type: GitObjectType;
	body: Uint8Array;
}

export async function readGitObject(
	fs: IFileSystem,
	gitdir: string,
	oid: string,
): Promise<GitObject> {
	const normalized = normalizeOid(oid);
	const loosePath = joinPath(gitdir, `objects/${normalized.slice(0, 2)}/${normalized.slice(2)}`);
	if (fs.exists(loosePath)) {
		return parseInflatedObject(await inflateZlib(fs.readFileBytes(loosePath)), normalized);
	}
	throw new Error(
		`Git object ${normalized} is not available as a loose object; packed object reading is not implemented yet`,
	);
}

export async function readBlobFromObjectStore(
	fs: IFileSystem,
	gitdir: string,
	oid: string,
	filepath?: string,
): Promise<Uint8Array> {
	const root = await readGitObject(fs, gitdir, oid);
	if (!filepath) {
		if (root.type !== "blob") {
			throw new Error(`Git object ${oid} is a ${root.type}, not a blob`);
		}
		return root.body;
	}

	const treeOid = root.type === "commit" ? parseCommitTree(root.body) : normalizeTreeish(root, oid);
	const blobOid = await resolveTreePath(fs, gitdir, treeOid, filepath);
	const blob = await readGitObject(fs, gitdir, blobOid);
	if (blob.type !== "blob") {
		throw new Error(`${filepath} resolved to a ${blob.type}, not a blob`);
	}
	return blob.body;
}

export function parseInflatedObject(
	bytes: Uint8Array,
	oidForError: string = "<unknown>",
): GitObject {
	const nul = bytes.indexOf(0);
	if (nul < 0) throw new Error(`Git object ${oidForError} has no header terminator`);
	const header = decodeUtf8(bytes.slice(0, nul));
	const match = /^(blob|tree|commit|tag) ([0-9]+)$/.exec(header);
	if (!match) throw new Error(`Git object ${oidForError} has an invalid header`);
	const body = bytes.slice(nul + 1);
	const size = Number(match[2]);
	if (body.length !== size) {
		throw new Error(
			`Git object ${oidForError} size mismatch: expected ${size}, got ${body.length}`,
		);
	}
	return { type: match[1] as GitObjectType, body };
}

export function parseCommitTree(body: Uint8Array): string {
	const text = decodeUtf8(body);
	const firstLine = text.split("\n", 1)[0];
	const match = /^tree ([0-9a-f]{40})$/.exec(firstLine ?? "");
	if (!match?.[1]) throw new Error("Commit object is missing its tree header");
	return match[1];
}

export function parseTreeEntries(body: Uint8Array): { mode: string; path: string; oid: string }[] {
	const entries: { mode: string; path: string; oid: string }[] = [];
	let offset = 0;
	while (offset < body.length) {
		const space = indexOfByte(body, 0x20, offset);
		if (space < 0) throw new Error("Tree object has an unterminated mode");
		const nul = indexOfByte(body, 0, space + 1);
		if (nul < 0) throw new Error("Tree object has an unterminated path");
		const oidStart = nul + 1;
		const oidEnd = oidStart + 20;
		if (oidEnd > body.length) throw new Error("Tree object has a truncated oid");
		entries.push({
			mode: decodeUtf8(body.slice(offset, space)),
			path: decodeUtf8(body.slice(space + 1, nul)),
			oid: bytesToHex(body.slice(oidStart, oidEnd)),
		});
		offset = oidEnd;
	}
	return entries;
}

async function resolveTreePath(
	fs: IFileSystem,
	gitdir: string,
	treeOid: string,
	filepath: string,
): Promise<string> {
	const parts = filepath.split("/").filter(Boolean);
	if (parts.length === 0) throw new Error("readBlob filepath must not be empty");
	let currentTree = treeOid;
	for (let i = 0; i < parts.length; i++) {
		const tree = await readGitObject(fs, gitdir, currentTree);
		if (tree.type !== "tree") throw new Error(`${parts.slice(0, i).join("/")} is not a tree`);
		const part = parts[i] as string;
		const entry = parseTreeEntries(tree.body).find((e) => e.path === part);
		if (!entry) throw new Error(`Path not found in tree: ${filepath}`);
		if (i === parts.length - 1) return entry.oid;
		currentTree = entry.oid;
	}
	throw new Error(`Path not found in tree: ${filepath}`);
}

function normalizeTreeish(obj: GitObject, oid: string): string {
	if (obj.type === "tree") return normalizeOid(oid);
	throw new Error(
		`Git object ${oid} is a ${obj.type}; pass a filepath only with commit or tree objects`,
	);
}

async function inflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
	if (typeof DecompressionStream === "function") {
		const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
		const inflated = await new Response(stream).arrayBuffer();
		return new Uint8Array(inflated);
	}
	const { inflateSync } = await import("node:zlib");
	return inflateSync(bytes);
}

function normalizeOid(oid: string): string {
	const normalized = oid.trim().toLowerCase();
	if (!/^[0-9a-f]{40}$/.test(normalized)) throw new Error(`Invalid git object id: ${oid}`);
	return normalized;
}

function indexOfByte(bytes: Uint8Array, needle: number, from: number): number {
	for (let i = from; i < bytes.length; i++) {
		if (bytes[i] === needle) return i;
	}
	return -1;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function joinPath(a: string, b: string): string {
	if (a.endsWith("/")) return a + b;
	return `${a}/${b}`;
}
