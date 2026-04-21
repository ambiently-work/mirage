import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { loadFromDisk, saveToDisk } from "../src/disk.js";
import { VirtualFileSystem } from "../src/filesystem.js";

function makeTempDir(): string {
	return fs.mkdtempSync(nodePath.join(os.tmpdir(), "mirage-test-"));
}

describe("loadFromDisk", () => {
	test("hydrates files from a real directory", async () => {
		const dir = makeTempDir();
		try {
			fs.mkdirSync(nodePath.join(dir, "src"));
			fs.writeFileSync(nodePath.join(dir, "package.json"), `{"name":"x"}`);
			fs.writeFileSync(nodePath.join(dir, "src/index.ts"), "export const x = 1;");

			const vfs = new VirtualFileSystem();
			await loadFromDisk(vfs, dir, { target: "/workspace" });

			expect(vfs.readFile("/workspace/package.json")).toBe(`{"name":"x"}`);
			expect(vfs.readFile("/workspace/src/index.ts")).toBe("export const x = 1;");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("default filter skips node_modules / .git / dist", async () => {
		const dir = makeTempDir();
		try {
			fs.mkdirSync(nodePath.join(dir, "node_modules/foo"), { recursive: true });
			fs.writeFileSync(nodePath.join(dir, "node_modules/foo/index.js"), "x");
			fs.mkdirSync(nodePath.join(dir, ".git"));
			fs.writeFileSync(nodePath.join(dir, ".git/HEAD"), "ref: main");
			fs.writeFileSync(nodePath.join(dir, "kept.txt"), "ok");

			const vfs = new VirtualFileSystem();
			await loadFromDisk(vfs, dir);

			expect(vfs.exists("/kept.txt")).toBe(true);
			expect(vfs.exists("/node_modules")).toBe(false);
			expect(vfs.exists("/.git")).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("custom filter", async () => {
		const dir = makeTempDir();
		try {
			fs.writeFileSync(nodePath.join(dir, "a.ts"), "a");
			fs.writeFileSync(nodePath.join(dir, "b.js"), "b");

			const vfs = new VirtualFileSystem();
			await loadFromDisk(vfs, dir, {
				filter: (p) => p.endsWith(".ts"),
			});

			expect(vfs.exists("/a.ts")).toBe(true);
			expect(vfs.exists("/b.js")).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("records symlinks as symlinks by default", async () => {
		const dir = makeTempDir();
		try {
			fs.writeFileSync(nodePath.join(dir, "target.txt"), "real");
			fs.symlinkSync("target.txt", nodePath.join(dir, "link.txt"));

			const vfs = new VirtualFileSystem();
			await loadFromDisk(vfs, dir);

			expect(vfs.lstat("/link.txt").isSymlink()).toBe(true);
			expect(vfs.readlink("/link.txt")).toBe("target.txt");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("saveToDisk", () => {
	test("writes a VFS subtree out to disk", async () => {
		const vfs = new VirtualFileSystem({
			files: {
				"/workspace/package.json": `{"name":"x"}`,
				"/workspace/src/index.ts": "export const x = 1;",
			},
		});

		const dir = makeTempDir();
		try {
			await saveToDisk(vfs, "/workspace", dir);

			expect(fs.readFileSync(nodePath.join(dir, "package.json"), "utf8")).toBe(`{"name":"x"}`);
			expect(fs.readFileSync(nodePath.join(dir, "src/index.ts"), "utf8")).toBe(
				"export const x = 1;",
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("round-trips via loadFromDisk", async () => {
		const src = makeTempDir();
		const dst = makeTempDir();
		try {
			fs.mkdirSync(nodePath.join(src, "sub"));
			fs.writeFileSync(nodePath.join(src, "sub/a.txt"), "hello");

			const vfs = new VirtualFileSystem();
			await loadFromDisk(vfs, src);
			await saveToDisk(vfs, "/", dst);

			expect(fs.readFileSync(nodePath.join(dst, "sub/a.txt"), "utf8")).toBe("hello");
		} finally {
			fs.rmSync(src, { recursive: true, force: true });
			fs.rmSync(dst, { recursive: true, force: true });
		}
	});

	test("clean option wipes target first", async () => {
		const dir = makeTempDir();
		try {
			fs.writeFileSync(nodePath.join(dir, "stale.txt"), "old");

			const vfs = new VirtualFileSystem({ files: { "/workspace/new.txt": "fresh" } });
			await saveToDisk(vfs, "/workspace", dir, { clean: true });

			expect(fs.existsSync(nodePath.join(dir, "stale.txt"))).toBe(false);
			expect(fs.readFileSync(nodePath.join(dir, "new.txt"), "utf8")).toBe("fresh");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
