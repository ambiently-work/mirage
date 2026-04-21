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
