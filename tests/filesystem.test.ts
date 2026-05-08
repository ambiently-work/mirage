import { describe, expect, test } from "bun:test";
import { VirtualFileSystem } from "../src/filesystem.js";
import { snapshot } from "../src/snapshot.js";

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

describe("VirtualFileSystem: mounts", () => {
	test("lists mount metadata through the public API", () => {
		const fs = new VirtualFileSystem({ bare: true });
		const mounted = new VirtualFileSystem({ bare: true });

		fs.mount("/work", mounted, {
			kind: "tmpfs",
			source: "none",
			options: { readonly: false },
		});

		expect(fs.listMounts()).toEqual([
			{
				path: "/work",
				kind: "tmpfs",
				source: "none",
				options: { readonly: false },
			},
		]);
	});

	test("listMounts returns cloned option objects sorted by path", () => {
		const fs = new VirtualFileSystem({ bare: true });
		fs.mount("/z", new VirtualFileSystem({ bare: true }), { kind: "zfs", options: { label: "z" } });
		fs.mount("/a", new VirtualFileSystem({ bare: true }), { kind: "afs", options: { label: "a" } });

		const mounts = fs.listMounts();
		expect(mounts.map((mount) => mount.path)).toEqual(["/a", "/z"]);
		if (mounts[0]?.options) {
			mounts[0].options.label = "changed";
		}

		expect(fs.listMounts()[0]?.options).toEqual({ label: "a" });
	});

	test("unmount removes metadata", () => {
		const fs = new VirtualFileSystem({ bare: true });
		fs.mount("/work", new VirtualFileSystem({ bare: true }), { kind: "tmpfs" });
		fs.unmount("/work");
		expect(fs.listMounts()).toEqual([]);
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
		const fs = new VirtualFileSystem();
		const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd, 0x80]);
		fs.writeFileBytes("/blob.bin", bytes);
		const out = fs.readFileBytes("/blob.bin");
		expect(Array.from(out)).toEqual(Array.from(bytes));
	});

	test("size reflects the byte length, not a UTF-8 string length", () => {
		const fs = new VirtualFileSystem();
		// Three bytes, but a single multi-byte UTF-8 codepoint when decoded.
		fs.writeFileBytes("/x", new Uint8Array([0xe2, 0x98, 0x83]));
		expect(fs.stat("/x").size).toBe(3);
	});

	test("writeFile / readFile are UTF-8-encoded shortcuts over the bytes API", () => {
		const fs = new VirtualFileSystem();
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

describe("VirtualFileSystem: special files", () => {
	test("uses handlers instead of persisted file contents", () => {
		const fs = new VirtualFileSystem();
		const writes: string[] = [];

		fs.specialFile("/dev/null", {
			read: () => "",
			write: (_path, content) => {
				writes.push(new TextDecoder().decode(content));
			},
		});

		fs.writeFile("/dev/null", "discarded");

		expect(writes).toEqual(["discarded"]);
		expect(fs.readFile("/dev/null")).toBe("");
		expect(fs.snapshot()).toEqual({});
	});

	test("supports generated byte streams and dynamic stat size", () => {
		const fs = new VirtualFileSystem();
		let reads = 0;
		fs.specialFile("/dev/zero", {
			read: () => {
				reads += 1;
				return new Uint8Array([0, 0, 0, 0]);
			},
			size: () => reads,
		});

		expect(Array.from(fs.readFileBytes("/dev/zero"))).toEqual([0, 0, 0, 0]);
		expect(fs.stat("/dev/zero").isFile()).toBe(true);
		expect(fs.stat("/dev/zero").size).toBe(1);
	});

	test("uses append handler when provided", () => {
		const fs = new VirtualFileSystem();
		const writes: string[] = [];
		fs.specialFile("/dev/stdout", {
			write: (_path, content) => writes.push(`write:${new TextDecoder().decode(content)}`),
			append: (_path, content) => writes.push(`append:${new TextDecoder().decode(content)}`),
		});

		fs.appendFile("/dev/stdout", "hi");

		expect(writes).toEqual(["append:hi"]);
	});

	test("snapshot rejects special files because handlers are not serializable", () => {
		const fs = new VirtualFileSystem();
		fs.specialFile("/dev/null", { read: () => "" });
		expect(() => snapshot(fs)).toThrow(/ENOTSUP/);
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
