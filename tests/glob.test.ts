import { describe, expect, test } from "bun:test";
import { VirtualFileSystem } from "../src/filesystem.js";
import { globFiles, globMatch } from "../src/glob.js";

describe("globMatch", () => {
	test("literal match", () => {
		expect(globMatch("/foo/bar.txt", "/foo/bar.txt")).toBe(true);
		expect(globMatch("/foo/bar.txt", "/foo/baz.txt")).toBe(false);
	});

	test("single star matches within a segment", () => {
		expect(globMatch("/foo/*.ts", "/foo/a.ts")).toBe(true);
		expect(globMatch("/foo/*.ts", "/foo/a/b.ts")).toBe(false);
	});

	test("double star crosses segment boundaries", () => {
		expect(globMatch("/foo/**/*.ts", "/foo/a/b/c.ts")).toBe(true);
		expect(globMatch("/foo/**/*.ts", "/foo/a.ts")).toBe(true);
	});

	test("question mark matches one char", () => {
		expect(globMatch("/foo/?.ts", "/foo/a.ts")).toBe(true);
		expect(globMatch("/foo/?.ts", "/foo/ab.ts")).toBe(false);
	});

	test("char class", () => {
		expect(globMatch("/foo/[abc].ts", "/foo/a.ts")).toBe(true);
		expect(globMatch("/foo/[abc].ts", "/foo/d.ts")).toBe(false);
		expect(globMatch("/foo/[a-z].ts", "/foo/m.ts")).toBe(true);
		expect(globMatch("/foo/[!abc].ts", "/foo/d.ts")).toBe(true);
	});

	test("braces expand", () => {
		expect(globMatch("/foo/{a,b}.ts", "/foo/a.ts")).toBe(true);
		expect(globMatch("/foo/{a,b}.ts", "/foo/b.ts")).toBe(true);
		expect(globMatch("/foo/{a,b}.ts", "/foo/c.ts")).toBe(false);
	});

	test("escaped metacharacters are literal", () => {
		expect(globMatch("/foo/\\*.ts", "/foo/*.ts")).toBe(true);
		expect(globMatch("/foo/\\*.ts", "/foo/a.ts")).toBe(false);
	});
});

describe("globFiles", () => {
	test("returns matching absolute paths", () => {
		const fs = new VirtualFileSystem({
			files: {
				"/src/a.ts": "",
				"/src/b.ts": "",
				"/src/nested/c.ts": "",
				"/src/nested/d.js": "",
			},
		});

		const ts = globFiles(fs, "/src/**/*.ts", "/");
		expect(ts).toEqual(["/src/a.ts", "/src/b.ts", "/src/nested/c.ts"]);
	});

	test("respects cwd for relative patterns", () => {
		const fs = new VirtualFileSystem({
			files: {
				"/a.txt": "",
				"/sub/b.txt": "",
			},
		});
		const matches = globFiles(fs, "*.txt", "/sub");
		expect(matches).toEqual(["/sub/b.txt"]);
	});
});
