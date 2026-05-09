import { describe, expect, test } from "bun:test";
import { VirtualFileSystem } from "../../src/filesystem.js";
import {
	parseInflatedObject,
	parseTreeEntries,
	readBlobFromObjectStore,
} from "../../src/git/objects.js";

const enc = new TextEncoder();

describe("git object reader", () => {
	test("parseInflatedObject preserves binary blob bytes", () => {
		const body = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
		const object = parseInflatedObject(concat(enc.encode(`blob ${body.length}\0`), body));

		expect(object.type).toBe("blob");
		expect(Array.from(object.body)).toEqual(Array.from(body));
	});

	test("parseTreeEntries reads tree paths and raw object ids", () => {
		const oid = "0123456789abcdef0123456789abcdef01234567";
		const tree = concat(enc.encode("100644 file with spaces.txt\0"), hexToBytes(oid));

		expect(parseTreeEntries(tree)).toEqual([{ mode: "100644", path: "file with spaces.txt", oid }]);
	});

	test("readBlobFromObjectStore resolves commit path to byte-exact blob", async () => {
		const fs = new VirtualFileSystem({ bare: true });
		fs.mkdir("/repo/.git", { recursive: true });
		const blobOid = "1111111111111111111111111111111111111111";
		const treeOid = "2222222222222222222222222222222222222222";
		const commitOid = "3333333333333333333333333333333333333333";
		const blob = new Uint8Array([0, 1, 2, 3, 254, 255]);
		const tree = concat(enc.encode("100644 bin.dat\0"), hexToBytes(blobOid));
		const commit = enc.encode(
			`tree ${treeOid}\nauthor Test <test@example.com> 0 +0000\n\nbinary\n`,
		);

		await writeLooseObject(fs, "/repo/.git", blobOid, "blob", blob);
		await writeLooseObject(fs, "/repo/.git", treeOid, "tree", tree);
		await writeLooseObject(fs, "/repo/.git", commitOid, "commit", commit);

		const result = await readBlobFromObjectStore(fs, "/repo/.git", commitOid, "bin.dat");
		expect(Array.from(result)).toEqual(Array.from(blob));
	});
});

async function writeLooseObject(
	fs: VirtualFileSystem,
	gitdir: string,
	oid: string,
	type: "blob" | "tree" | "commit",
	body: Uint8Array,
): Promise<void> {
	const dir = `${gitdir}/objects/${oid.slice(0, 2)}`;
	fs.mkdir(dir, { recursive: true });
	fs.writeFileBytes(
		`${dir}/${oid.slice(2)}`,
		await deflate(concat(enc.encode(`${type} ${body.length}\0`), body)),
	);
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
	if (typeof CompressionStream === "function") {
		const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
		const compressed = await new Response(stream).arrayBuffer();
		return new Uint8Array(compressed);
	}
	const { deflateSync } = await import("node:zlib");
	return deflateSync(bytes);
}

function concat(...chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}
