import { describe, expect, test } from "bun:test";
import { HttpFileSystem } from "../src/adapters/http-fs.js";
import { LayeredFileSystem } from "../src/adapters/layered.js";
import { ObjectFileSystem } from "../src/adapters/object-fs.js";
import { ReadOnlyFileSystem } from "../src/adapters/read-only.js";
import { VirtualFileSystem } from "../src/filesystem.js";

describe("ObjectFileSystem", () => {
	test("readFile + readDir", () => {
		const fs = new ObjectFileSystem({
			"/config.json": "{}",
			"/data/users.csv": "name\nalice\n",
		});
		expect(fs.readFile("/config.json")).toBe("{}");
		expect(fs.readDir("/")).toEqual(["config.json", "data"]);
		expect(fs.readDir("/data")).toEqual(["users.csv"]);
	});

	test("glob", () => {
		const fs = new ObjectFileSystem({ "/a.ts": "", "/b.js": "", "/sub/c.ts": "" });
		expect(fs.glob("/**/*.ts")).toEqual(["/a.ts", "/sub/c.ts"]);
	});

	test("symlink throws", () => {
		const fs = new ObjectFileSystem();
		expect(() => fs.symlink("/a", "/b")).toThrow(/ENOSYS/);
	});
});

describe("ReadOnlyFileSystem", () => {
	test("reads succeed, writes throw EROFS", () => {
		const inner = new VirtualFileSystem({ files: { "/a.txt": "x" } });
		const ro = new ReadOnlyFileSystem(inner);
		expect(ro.readFile("/a.txt")).toBe("x");
		expect(() => ro.writeFile("/a.txt", "y")).toThrow(/EROFS/);
		expect(() => ro.mkdir("/d")).toThrow(/EROFS/);
		expect(() => ro.rm("/a.txt")).toThrow(/EROFS/);
	});
});

describe("LayeredFileSystem", () => {
	test("reads cascade top-down, writes go to top", () => {
		const base = new ReadOnlyFileSystem(
			new VirtualFileSystem({ files: { "/a.txt": "base", "/b.txt": "base-b" } }),
		);
		const overlay = new VirtualFileSystem();
		const fs = new LayeredFileSystem(overlay, base);

		expect(fs.readFile("/a.txt")).toBe("base");
		fs.writeFile("/a.txt", "overlay");
		expect(fs.readFile("/a.txt")).toBe("overlay");
		expect(overlay.readFile("/a.txt")).toBe("overlay");

		// b.txt still comes from the base layer
		expect(fs.readFile("/b.txt")).toBe("base-b");
	});

	test("readDir merges entries from all layers", () => {
		const base = new VirtualFileSystem({ files: { "/pkg/a.ts": "" } });
		const overlay = new VirtualFileSystem({ files: { "/pkg/b.ts": "" } });
		const fs = new LayeredFileSystem(overlay, base);
		expect(fs.readDir("/pkg")).toEqual(["a.ts", "b.ts"]);
	});
});

describe("HttpFileSystem", () => {
	test("seed + readFile synchronously", () => {
		const fs = new HttpFileSystem("https://example.com");
		fs.seed({ "/a.txt": "hi" });
		expect(fs.readFile("/a.txt")).toBe("hi");
	});

	test("readFile without seed throws", () => {
		const fs = new HttpFileSystem("https://example.com");
		expect(() => fs.readFile("/x.txt")).toThrow(/ENOENT/);
	});

	test("writes throw EROFS", () => {
		const fs = new HttpFileSystem("https://example.com");
		expect(() => fs.writeFile()).toThrow(/EROFS/);
	});
});
