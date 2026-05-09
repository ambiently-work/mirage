import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	CodeEvalBuiltins,
	FilesystemBuiltins,
	HttpBuiltins,
	SearchBuiltins,
	ShellBuiltins,
} from "../src/index.js";

describe("built-in tools", () => {
	let root: string | undefined;
	afterEach(async () => {
		if (root) await rm(root, { recursive: true, force: true });
		root = undefined;
	});

	test("filesystem read/write/list/glob", async () => {
		root = await mkdtemp(join(tmpdir(), "mirage-tools-"));
		const fsTools = new FilesystemBuiltins({ rootDir: root, allowlist: ["allowed"] });
		await fsTools.writeFile("allowed/a.txt", "hello");
		expect(await fsTools.readFile("allowed/a.txt")).toBe("hello");
		expect(await fsTools.listDir("allowed")).toEqual(["a.txt"]);
		expect(await fsTools.glob("allowed/*.txt")).toEqual(["allowed/a.txt"]);
	});

	test("shell allowlist", async () => {
		const nodeCmd = process.execPath;
		const shell = new ShellBuiltins({ allowCommands: [nodeCmd, basename(nodeCmd)] });
		const result = await shell.runCommand(nodeCmd, ["-e", 'console.log("ok")']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("ok");
	});

	test("http allowlist", async () => {
		const http = new HttpBuiltins({ allowlist: ["https://example.com"] });
		const result = await http.httpRequest("https://example.com");
		expect(result.status).toBeGreaterThanOrEqual(200);
		expect(result.status).toBeLessThan(500);
	});

	test("search adapter", async () => {
		const search = new SearchBuiltins({
			search: async (query) => [{ title: query, url: "https://example.com" }],
		});
		expect(await search.webSearch("hi", 1)).toEqual([{ title: "hi", url: "https://example.com" }]);
	});

	test("code eval", async () => {
		const evalTool = new CodeEvalBuiltins({ runTypeScript: async () => 7 });
		expect(await evalTool.evaluate("1+2")).toBe(7);
	});
});
