import { describe, expect, test } from "bun:test";
import {
	basename,
	dirname,
	extname,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
	split,
} from "../src/path.js";

describe("isAbsolute", () => {
	test("true for absolute paths", () => {
		expect(isAbsolute("/")).toBe(true);
		expect(isAbsolute("/foo")).toBe(true);
	});

	test("false for relative paths", () => {
		expect(isAbsolute("")).toBe(false);
		expect(isAbsolute("foo")).toBe(false);
		expect(isAbsolute("./foo")).toBe(false);
	});
});

describe("normalize", () => {
	test("collapses duplicate slashes and .", () => {
		expect(normalize("/foo//bar/./baz")).toBe("/foo/bar/baz");
	});

	test("resolves ..", () => {
		expect(normalize("/foo/bar/../baz")).toBe("/foo/baz");
		expect(normalize("/../foo")).toBe("/foo");
	});

	test("preserves trailing .. in relative paths", () => {
		expect(normalize("../../foo")).toBe("../../foo");
	});

	test("handles edge cases", () => {
		expect(normalize("")).toBe(".");
		expect(normalize("/")).toBe("/");
		expect(normalize(".")).toBe(".");
	});
});

describe("join", () => {
	test("joins path parts", () => {
		expect(join("/foo", "bar", "baz")).toBe("/foo/bar/baz");
	});

	test("normalizes the result", () => {
		expect(join("/foo/", "/bar/", "./baz")).toBe("/foo/bar/baz");
	});

	test("handles no args", () => {
		expect(join()).toBe(".");
	});
});

describe("resolve", () => {
	test("absolute path wins", () => {
		expect(resolve("/cwd", "/abs/path")).toBe("/abs/path");
	});

	test("joins relative to cwd", () => {
		expect(resolve("/cwd", "./foo")).toBe("/cwd/foo");
	});
});

describe("dirname / basename / extname", () => {
	test("dirname", () => {
		expect(dirname("/foo/bar.txt")).toBe("/foo");
		expect(dirname("/")).toBe("/");
		expect(dirname("foo.txt")).toBe(".");
	});

	test("basename", () => {
		expect(basename("/foo/bar.txt")).toBe("bar.txt");
		expect(basename("/foo/bar.txt", ".txt")).toBe("bar");
		expect(basename("/")).toBe("/");
	});

	test("extname", () => {
		expect(extname("/foo/bar.txt")).toBe(".txt");
		expect(extname("/foo/bar")).toBe("");
		expect(extname("/foo/.hidden")).toBe("");
	});
});

describe("split / relative", () => {
	test("split", () => {
		expect(split("/foo/bar/baz")).toEqual(["/", "foo", "bar", "baz"]);
		expect(split("foo/bar")).toEqual(["foo", "bar"]);
		expect(split("/")).toEqual(["/"]);
	});

	test("relative", () => {
		expect(relative("/a/b", "/a/b/c/d")).toBe("c/d");
		expect(relative("/a/b/c", "/a/b/d")).toBe("../d");
		expect(relative("/a/b", "/a/b")).toBe(".");
	});
});
