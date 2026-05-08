import { describe, expect, test } from "bun:test";
import { VirtualFileSystem } from "../src/filesystem.js";
import { restore, snapshot } from "../src/snapshot.js";

describe("snapshot / restore", () => {
	test("round-trips file contents", () => {
		const fs = new VirtualFileSystem({
			bare: true,
			files: { "/a.txt": "hello", "/b/c.txt": "world" },
		});
		const snap = snapshot(fs);

		const restored = restore(snap);
		expect(restored.readFile("/a.txt")).toBe("hello");
		expect(restored.readFile("/b/c.txt")).toBe("world");
	});

	test("round-trips directories (empty dirs preserved)", () => {
		const fs = new VirtualFileSystem({ bare: true });
		fs.mkdir("/empty", { recursive: true });
		const snap = snapshot(fs);

		const restored = restore(snap);
		expect(restored.exists("/empty")).toBe(true);
		expect(restored.stat("/empty").isDirectory()).toBe(true);
	});

	test("round-trips symlinks", () => {
		const fs = new VirtualFileSystem({ bare: true, files: { "/target.txt": "real" } });
		fs.symlink("/target.txt", "/link.txt");
		const snap = snapshot(fs);

		const restored = restore(snap);
		expect(restored.readlink("/link.txt")).toBe("/target.txt");
		expect(restored.readFile("/link.txt")).toBe("real");
	});

	test("round-trips file modes", () => {
		const fs = new VirtualFileSystem({ bare: true, files: { "/script.sh": "#!/bin/sh" } });
		fs.chmod("/script.sh", 0o755);
		const snap = snapshot(fs);

		const restored = restore(snap);
		expect(restored.stat("/script.sh").mode).toBe(0o755);
	});

	test("round-trips hardlink identity", () => {
		const fs = new VirtualFileSystem({ bare: true, files: { "/a.txt": "hi" } });
		fs.link("/a.txt", "/b.txt");
		const snap = snapshot(fs);

		const restored = restore(snap);
		restored.writeFile("/a.txt", "bye");

		expect(restored.readFile("/b.txt")).toBe("bye");
		expect(restored.stat("/a.txt").ino).toBe(restored.stat("/b.txt").ino);
		expect(restored.stat("/a.txt").nlink).toBe(2);
	});

	test("is JSON-serializable", () => {
		const fs = new VirtualFileSystem({ bare: true, files: { "/a.txt": "x" } });
		const snap = snapshot(fs);
		const serialized = JSON.stringify(snap);
		const parsed = JSON.parse(serialized);

		const restored = restore(parsed);
		expect(restored.readFile("/a.txt")).toBe("x");
	});

	test("throws on unsupported version", () => {
		expect(() =>
			restore({
				// @ts-expect-error intentional bad version
				version: 99,
				createdAt: 0,
				root: {
					kind: "directory",
					children: {},
					meta: { mode: 0, uid: 0, gid: 0, atime: 0, mtime: 0, ctime: 0 },
				},
			}),
		).toThrow(/unsupported snapshot version/);
	});

	test("restore preserves the tree even when parent has default dirs", () => {
		const fs = new VirtualFileSystem({ files: { "/workspace/main.ts": "x" } });
		const snap = snapshot(fs);
		const restored = restore(snap);
		expect(restored.readFile("/workspace/main.ts")).toBe("x");
		expect(restored.stat("/tmp").isDirectory()).toBe(true);
	});
});

describe("snapshot v2: binary content", () => {
	test("non-UTF-8 bytes round-trip via base64 fallback", () => {
		const fs = new VirtualFileSystem({ bare: true });
		// 0xFF on its own is not valid UTF-8 → snapshot should pick base64.
		const bytes = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x80, 0x81]);
		fs.writeFileBytes("/blob.bin", bytes);

		const snap = snapshot(fs);
		// Spot-check the stored encoding so a future regression that loses
		// binary fidelity is caught early.
		const blobNode = (snap.root as { children: Record<string, { encoding?: string }> }).children[
			"blob.bin"
		];
		expect(blobNode?.encoding).toBe("base64");

		const restored = restore(JSON.parse(JSON.stringify(snap)));
		expect(Array.from(restored.readFileBytes("/blob.bin"))).toEqual(Array.from(bytes));
	});

	test("UTF-8 text picks the utf8 encoding (no base64 bloat)", () => {
		const fs = new VirtualFileSystem({ bare: true, files: { "/a.txt": "héllo 世界" } });
		const snap = snapshot(fs);
		const node = (snap.root as { children: Record<string, { encoding?: string; content: string }> })
			.children["a.txt"];
		expect(node?.encoding).toBe("utf8");
		expect(node?.content).toBe("héllo 世界");
	});

	test("legacy v1 snapshots (no encoding field) still load as UTF-8", () => {
		const legacy = {
			version: 1 as const,
			createdAt: 0,
			root: {
				kind: "directory" as const,
				children: {
					"a.txt": {
						kind: "file" as const,
						content: "legacy content",
						meta: { mode: 0o644, uid: 0, gid: 0, atime: 0, mtime: 0, ctime: 0, rev: 0 },
					},
				},
				meta: { mode: 0o755, uid: 0, gid: 0, atime: 0, mtime: 0, ctime: 0, rev: 0 },
			},
		};
		const restored = restore(legacy);
		expect(restored.readFile("/a.txt")).toBe("legacy content");
	});
});
