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

describe("VirtualFileSystem: hardlinks", () => {
	test("shares file identity and content across hardlinks", () => {
		const fs = new VirtualFileSystem({ bare: true, files: { "/a.txt": "hi" } });

		fs.link("/a.txt", "/b.txt");
		fs.writeFile("/a.txt", "bye");

		expect(fs.readFile("/b.txt")).toBe("bye");
		expect(fs.stat("/a.txt").ino).toBe(fs.stat("/b.txt").ino);
		expect(fs.stat("/a.txt").nlink).toBe(2);
		expect(fs.stat("/b.txt").nlinks).toBe(2);
	});

	test("removing one hardlink leaves the other path valid", () => {
		const fs = new VirtualFileSystem({ bare: true, files: { "/a.txt": "hi" } });
		fs.link("/a.txt", "/b.txt");

		fs.rm("/a.txt");

		expect(fs.exists("/a.txt")).toBe(false);
		expect(fs.readFile("/b.txt")).toBe("hi");
		expect(fs.stat("/b.txt").nlink).toBe(1);
	});

	test("hardlinking directories fails", () => {
		const fs = new VirtualFileSystem({ bare: true });
		fs.mkdir("/dir");

		expect(() => fs.link("/dir", "/dir-link")).toThrow(/EPERM/);
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

describe("VirtualFileSystem: binary content (readFileBytes / writeFileBytes)", () => {
	test("round-trips arbitrary bytes including 0x00 and 0xFF", () => {
		const fs = new VirtualFileSystem({ bare: true });
		const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd, 0x80]);
		fs.writeFileBytes("/blob.bin", bytes);
		const out = fs.readFileBytes("/blob.bin");
		expect(Array.from(out)).toEqual(Array.from(bytes));
	});

	test("size reflects the byte length, not a UTF-8 string length", () => {
		const fs = new VirtualFileSystem({ bare: true });
		// Three bytes, but a single multi-byte UTF-8 codepoint when decoded.
		fs.writeFileBytes("/x", new Uint8Array([0xe2, 0x98, 0x83]));
		expect(fs.stat("/x").size).toBe(3);
	});

	test("writeFile / readFile are UTF-8-encoded shortcuts over the bytes API", () => {
		const fs = new VirtualFileSystem({ bare: true });
		fs.writeFile("/a", "héllo");
		const bytes = fs.readFileBytes("/a");
		expect(bytes.length).toBe(6); // "h" + "é" (2 bytes) + "llo" = 6
		expect(fs.readFile("/a")).toBe("héllo");
	});

	test("constructor `files` accepts both string and Uint8Array values", () => {
		const fs = new VirtualFileSystem({
			bare: true,
			files: {
				"/a.txt": "text",
				"/b.bin": new Uint8Array([1, 2, 3]),
			},
		});
		expect(fs.readFile("/a.txt")).toBe("text");
		expect(Array.from(fs.readFileBytes("/b.bin"))).toEqual([1, 2, 3]);
	});
});

describe("VirtualFileSystem: rev counter on stats", () => {
	test("rev starts at 0 and increments on every write", () => {
		const fs = new VirtualFileSystem({ bare: true });
		fs.writeFile("/a.txt", "v1");
		const r1 = fs.stat("/a.txt").rev;
		fs.writeFile("/a.txt", "v2");
		const r2 = fs.stat("/a.txt").rev;
		fs.writeFileBytes("/a.txt", new Uint8Array([3]));
		const r3 = fs.stat("/a.txt").rev;
		// First write creates the file (rev=1 after touchMeta runs once).
		expect(r2).toBeGreaterThan(r1);
		expect(r3).toBeGreaterThan(r2);
	});

	test("rev is per-file (writing /a does not bump /b)", () => {
		const fs = new VirtualFileSystem({ bare: true });
		fs.writeFile("/a.txt", "x");
		fs.writeFile("/b.txt", "y");
		const aRev = fs.stat("/a.txt").rev;
		const bRev = fs.stat("/b.txt").rev;
		fs.writeFile("/a.txt", "x2");
		expect(fs.stat("/a.txt").rev).toBeGreaterThan(aRev);
		expect(fs.stat("/b.txt").rev).toBe(bRev);
	});
});
