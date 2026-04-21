import { describe, expect, test } from "bun:test";
import { GitIgnore, matchGitignore, parseGitignore } from "../src/gitignore.js";

describe("parseGitignore", () => {
	test("skips blank lines and comments", () => {
		const rules = parseGitignore("\n# comment\n  \nfoo\n");
		expect(rules.length).toBe(1);
		expect(rules[0]?.pattern).toBe("foo");
	});

	test("recognises negation and dir-only flags", () => {
		const rules = parseGitignore("foo/\n!bar");
		expect(rules[0]?.dirOnly).toBe(true);
		expect(rules[0]?.negate).toBe(false);
		expect(rules[1]?.negate).toBe(true);
		expect(rules[1]?.dirOnly).toBe(false);
	});

	test("escaped leading hash and bang are literal", () => {
		const rules = parseGitignore("\\#foo\n\\!bar");
		expect(rules.map((r) => r.pattern)).toEqual(["#foo", "!bar"]);
	});
});

describe("GitIgnore matching", () => {
	test("simple file pattern matches at any depth", () => {
		const gi = new GitIgnore("foo.log");
		expect(gi.ignores("foo.log")).toBe(true);
		expect(gi.ignores("a/b/foo.log")).toBe(true);
		expect(gi.ignores("foo.txt")).toBe(false);
	});

	test("anchored pattern only matches at root", () => {
		const gi = new GitIgnore("/foo.log");
		expect(gi.ignores("foo.log")).toBe(true);
		expect(gi.ignores("a/foo.log")).toBe(false);
	});

	test("trailing slash is directory-only", () => {
		const gi = new GitIgnore("build/");
		expect(gi.ignores("build", true)).toBe(true);
		expect(gi.ignores("build", false)).toBe(false);
		// children of an ignored directory are themselves ignored
		expect(gi.ignores("build/index.js")).toBe(true);
	});

	test("** prefix matches any depth", () => {
		const gi = new GitIgnore("**/dist");
		expect(gi.ignores("dist", true)).toBe(true);
		expect(gi.ignores("a/dist", true)).toBe(true);
		expect(gi.ignores("a/b/dist", true)).toBe(true);
	});

	test("trailing /** matches everything inside", () => {
		const gi = new GitIgnore("logs/**");
		expect(gi.ignores("logs/today.log")).toBe(true);
		expect(gi.ignores("logs/a/b.log")).toBe(true);
		expect(gi.ignores("audit.log")).toBe(false);
	});

	test("character class", () => {
		const gi = new GitIgnore("foo.[oa]");
		expect(gi.ignores("foo.o")).toBe(true);
		expect(gi.ignores("foo.a")).toBe(true);
		expect(gi.ignores("foo.b")).toBe(false);
	});

	test("negation re-includes a previously ignored path", () => {
		const gi = new GitIgnore("*.log\n!important.log");
		expect(gi.ignores("foo.log")).toBe(true);
		expect(gi.ignores("important.log")).toBe(false);
	});

	test("descendants of an excluded parent stay excluded even when re-included", () => {
		// Per gitignore(5): can't re-include a child of an excluded directory.
		const gi = new GitIgnore("logs/\n!logs/keep.log");
		expect(gi.ignores("logs/keep.log")).toBe(true);
	});

	test("rules from a sub-directory's .gitignore are scoped to it", () => {
		const gi = new GitIgnore();
		gi.add("secret.txt", { base: "src" });
		expect(gi.ignores("src/secret.txt")).toBe(true);
		expect(gi.ignores("secret.txt")).toBe(false);
		expect(gi.ignores("other/secret.txt")).toBe(false);
	});

	test("matchGitignore convenience", () => {
		expect(matchGitignore("*.log", "foo.log")).toBe(true);
		expect(matchGitignore("*.log", "foo.txt")).toBe(false);
	});
});
