import { describe, expect, test } from "bun:test";
import { VirtualFileSystem } from "../src/filesystem.js";

describe("VirtualFileSystem: basic ops", () => {
	test("writeFile + readFile", () => {
		const fs = new VirtualFileSystem();
		fs.writeFile("/hello.txt", "hi");
		expect(fs.readFile("/hello.txt")).toBe("hi");
	});

	test("exists", () => {
		const fs = new VirtualFileSystem({ files: { "/a.txt": "x" } });
		expect(fs.exists("/a.txt")).toBe(true);
		expect(fs.exists("/nope")).toBe(false);
	});

	test("mkdir + readDir", () => {
		const fs = new VirtualFileSystem();
		fs.mkdir("/src", { recursive: true });
		fs.writeFile("/src/a.ts", "a");
		fs.writeFile("/src/b.ts", "b");
		expect(fs.readDir("/src")).toEqual(["a.ts", "b.ts"]);
	});

	test("constructor seeds files and creates parent dirs", () => {
		const fs = new VirtualFileSystem({
			files: { "/deep/nested/path/file.txt": "content" },
		});
		expect(fs.readFile("/deep/nested/path/file.txt")).toBe("content");
		expect(fs.stat("/deep/nested").isDirectory()).toBe(true);
	});

	test("bare option skips default dirs", () => {
		const fs = new VirtualFileSystem({ bare: true });
		expect(fs.readDir("/")).toEqual([]);
	});

	test("standard POSIX dirs exist by default", () => {
		const fs = new VirtualFileSystem();
		expect(fs.stat("/tmp").isDirectory()).toBe(true);
		expect(fs.stat("/home").isDirectory()).toBe(true);
		expect(fs.stat("/usr/bin").isDirectory()).toBe(true);
	});
});

describe("VirtualFileSystem: rm / mv / cp", () => {
	test("rm file", () => {
		const fs = new VirtualFileSystem({ files: { "/a.txt": "x" } });
		fs.rm("/a.txt");
		expect(fs.exists("/a.txt")).toBe(false);
	});

	test("rm non-empty dir fails without recursive", () => {
		const fs = new VirtualFileSystem({ files: { "/d/a.txt": "x" } });
		expect(() => fs.rm("/d")).toThrow(/ENOTEMPTY|EISDIR/);
	});

	test("rm -rf", () => {
		const fs = new VirtualFileSystem({ files: { "/d/a.txt": "x", "/d/b.txt": "y" } });
		fs.rm("/d", { recursive: true });
		expect(fs.exists("/d")).toBe(false);
	});

	test("cp", () => {
		const fs = new VirtualFileSystem({ files: { "/a.txt": "x" } });
		fs.cp("/a.txt", "/b.txt");
		expect(fs.readFile("/b.txt")).toBe("x");
	});

	test("mv preserves content", () => {
		const fs = new VirtualFileSystem({ files: { "/a.txt": "x" } });
		fs.mv("/a.txt", "/b.txt");
		expect(fs.exists("/a.txt")).toBe(false);
		expect(fs.readFile("/b.txt")).toBe("x");
	});

	test("mv into directory", () => {
		const fs = new VirtualFileSystem({ files: { "/a.txt": "x" } });
		fs.mkdir("/d");
		fs.mv("/a.txt", "/d");
		expect(fs.readFile("/d/a.txt")).toBe("x");
	});
});

describe("VirtualFileSystem: symlinks", () => {
	test("readlink + realpath", () => {
		const fs = new VirtualFileSystem({ files: { "/real/file.txt": "hi" } });
		fs.symlink("/real/file.txt", "/link.txt");
		expect(fs.readlink("/link.txt")).toBe("/real/file.txt");
		expect(fs.realpath("/link.txt")).toBe("/real/file.txt");
	});

	test("readFile follows symlinks", () => {
		const fs = new VirtualFileSystem({ files: { "/real/file.txt": "hi" } });
		fs.symlink("/real/file.txt", "/link.txt");
		expect(fs.readFile("/link.txt")).toBe("hi");
	});

	test("lstat does not follow symlinks", () => {
		const fs = new VirtualFileSystem({ files: { "/real/file.txt": "hi" } });
		fs.symlink("/real/file.txt", "/link.txt");
		expect(fs.lstat("/link.txt").isSymlink()).toBe(true);
		expect(fs.stat("/link.txt").isFile()).toBe(true);
	});
});

describe("VirtualFileSystem: cwd", () => {
	test("cwd affects relative paths", () => {
		const fs = new VirtualFileSystem({ files: { "/sub/a.txt": "hi" } });
		fs.cwd = "/sub";
		expect(fs.readFile("a.txt")).toBe("hi");
	});

	test("setting cwd to non-directory throws", () => {
		const fs = new VirtualFileSystem({ files: { "/a.txt": "hi" } });
		expect(() => {
			fs.cwd = "/a.txt";
		}).toThrow(/ENOTDIR/);
	});
});

describe("VirtualFileSystem: glob", () => {
	test("returns all matches across subdirs", () => {
		const fs = new VirtualFileSystem({
			files: {
				"/a.ts": "",
				"/sub/b.ts": "",
				"/sub/c.txt": "",
			},
		});
		expect(fs.glob("/**/*.ts")).toEqual(["/a.ts", "/sub/b.ts"]);
	});
});

describe("VirtualFileSystem: snapshot (legacy flat)", () => {
	test("returns file contents", () => {
		const fs = new VirtualFileSystem({ bare: true, files: { "/a.txt": "x", "/b/c.txt": "y" } });
		expect(fs.snapshot()).toEqual({ "/a.txt": "x", "/b/c.txt": "y" });
	});
});
