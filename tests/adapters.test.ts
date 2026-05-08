import { describe, expect, test } from "bun:test";
import { HookedFileSystem } from "../src/adapters/hooked.js";
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

	test("hardlinks share file identity", () => {
		const fs = new ObjectFileSystem({ "/a.txt": "hi" });
		fs.link("/a.txt", "/b.txt");
		fs.writeFile("/b.txt", "bye");

		expect(fs.readFile("/a.txt")).toBe("bye");
		expect(fs.stat("/a.txt").ino).toBe(fs.stat("/b.txt").ino);
		expect(fs.stat("/a.txt").nlink).toBe(2);
	});

	test("reports no mounts", () => {
		const fs = new ObjectFileSystem();
		expect(fs.listMounts()).toEqual([]);
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

	test("delegates mount listing", () => {
		const inner = new VirtualFileSystem({ bare: true });
		inner.mount("/mnt", new ObjectFileSystem(), { kind: "object", source: "memory" });
		const ro = new ReadOnlyFileSystem(inner);
		expect(ro.listMounts()).toEqual([{ path: "/mnt", kind: "object", source: "memory" }]);
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

	test("combines mount listings from layers", () => {
		const base = new VirtualFileSystem({ bare: true });
		const overlay = new VirtualFileSystem({ bare: true });
		base.mount("/base", new ObjectFileSystem(), { kind: "object" });
		overlay.mount("/overlay", new ObjectFileSystem(), { kind: "object" });

		const fs = new LayeredFileSystem(overlay, base);

		expect(fs.listMounts()).toEqual([
			{ path: "/overlay", kind: "object" },
			{ path: "/base", kind: "object" },
		]);
	});
});

describe("HookedFileSystem", () => {
	test("formats matching text writes by extension and glob", () => {
		const inner = new VirtualFileSystem({ bare: true });
		const fs = new HookedFileSystem(inner, {
			rules: [
				{
					extensions: "ts",
					glob: "/src/**/*.ts",
					hook: (content) => {
						if (typeof content !== "string") return;
						return `${content.trim()}\n`;
					},
				},
			],
		});

		fs.mkdir("/src", { recursive: true });
		fs.writeFile("/src/index.ts", "export const x = 1;   ");
		fs.writeFile("/README.md", "  kept  ");

		expect(inner.readFile("/src/index.ts")).toBe("export const x = 1;\n");
		expect(inner.readFile("/README.md")).toBe("  kept  ");
	});

	test("runs hooks in order and can reject writes like a linter", () => {
		const inner = new VirtualFileSystem({ bare: true });
		const fs = new HookedFileSystem(inner, {
			rules: [
				{
					extensions: ".ts",
					hook: (content) =>
						typeof content === "string" ? content.replace("var ", "let ") : undefined,
				},
				{
					extensions: ".ts",
					hook: (content) => {
						if (typeof content === "string" && content.includes("debugger")) {
							throw new Error("lint: debugger is not allowed");
						}
					},
				},
			],
		});

		fs.writeFile("/a.ts", "var x = 1;");
		expect(inner.readFile("/a.ts")).toBe("let x = 1;");
		expect(() => fs.writeFile("/b.ts", "debugger;")).toThrow(/debugger is not allowed/);
		expect(inner.exists("/b.ts")).toBe(false);
	});

	test("applies hooks to appended final content", () => {
		const inner = new VirtualFileSystem({ bare: true, files: { "/notes.txt": "one" } });
		const fs = new HookedFileSystem(inner, {
			rules: [
				{
					extensions: "txt",
					hook: (content) => (typeof content === "string" ? content.toUpperCase() : undefined),
				},
			],
		});

		fs.appendFile("/notes.txt", " two");

		expect(inner.readFile("/notes.txt")).toBe("ONE TWO");
	});

	test("applies hooks to copy destinations", () => {
		const inner = new VirtualFileSystem({ bare: true, files: { "/src/a.txt": "hello" } });
		const fs = new HookedFileSystem(inner, {
			rules: [
				{
					glob: "/out/*.txt",
					hook: (content, context) => {
						expect(context.operation).toBe("copy");
						if (content instanceof Uint8Array)
							return new TextEncoder().encode(`${new TextDecoder().decode(content)}!`);
					},
				},
			],
		});
		fs.mkdir("/out", { recursive: true });

		fs.cp("/src/a.txt", "/out/a.txt");

		expect(inner.readFile("/out/a.txt")).toBe("hello!");
	});

	test("matches the final path when copying into a directory", () => {
		const inner = new VirtualFileSystem({ bare: true, files: { "/src/a.txt": "hello" } });
		const fs = new HookedFileSystem(inner, {
			rules: [
				{
					glob: "/out/*.txt",
					hook: (content, context) => {
						expect(context.path).toBe("/out/a.txt");
						if (content instanceof Uint8Array)
							return new TextEncoder().encode(new TextDecoder().decode(content).toUpperCase());
					},
				},
			],
		});
		fs.mkdir("/out", { recursive: true });

		fs.cp("/src/a.txt", "/out");

		expect(inner.readFile("/out/a.txt")).toBe("HELLO");
	});

	test("supports adding hooks after construction", () => {
		const inner = new VirtualFileSystem({ bare: true });
		const fs = new HookedFileSystem(inner);

		fs.addHook({
			test: (context) => context.normalizedPath === "/config.json",
			hook: (content) => (typeof content === "string" ? `${content}\n` : undefined),
		});
		fs.writeFile("config.json", "{}");

		expect(inner.readFile("config.json")).toBe("{}\n");
		expect(fs.getHooks()).toHaveLength(1);
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

	test("reports no mounts", () => {
		const fs = new HttpFileSystem("https://example.com");
		expect(fs.listMounts()).toEqual([]);
	});
});
