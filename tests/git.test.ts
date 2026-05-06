import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { VirtualFileSystem } from "../src/filesystem.js";
import { loadFromGit, looksLikeGitUrl, readGitMetadata, saveAsGitRepo } from "../src/git.js";

function makeTempDir(): string {
	return fs.mkdtempSync(nodePath.join(os.tmpdir(), "mirage-git-"));
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
		},
	});
}

function makeRepo(): { dir: string; cleanup: () => void } {
	const dir = makeTempDir();
	git(dir, "init", "--initial-branch", "main", "--quiet");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "commit.gpgsign", "false");
	// Keep blobs byte-for-byte: prevents Windows runners' default
	// `core.autocrlf=true` from rewriting \n → \r\n on add or checkout.
	git(dir, "config", "core.autocrlf", "false");
	fs.writeFileSync(nodePath.join(dir, "README.md"), "# Hello\n");
	fs.mkdirSync(nodePath.join(dir, "src"));
	fs.writeFileSync(nodePath.join(dir, "src/index.ts"), "export const x = 1;\n");
	fs.writeFileSync(nodePath.join(dir, ".gitignore"), "build/\n*.log\n");
	fs.mkdirSync(nodePath.join(dir, "build"));
	fs.writeFileSync(nodePath.join(dir, "build/output.js"), "ignored");
	fs.writeFileSync(nodePath.join(dir, "debug.log"), "ignored");
	git(dir, "add", "-A");
	git(dir, "commit", "-m", "feat: initial");
	return {
		dir,
		cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
	};
}

describe("looksLikeGitUrl", () => {
	test("recognises common URL forms", () => {
		expect(looksLikeGitUrl("https://github.com/foo/bar")).toBe(true);
		expect(looksLikeGitUrl("git@github.com:foo/bar.git")).toBe(true);
		expect(looksLikeGitUrl("ssh://git@example.com/foo")).toBe(true);
		expect(looksLikeGitUrl("file:///tmp/foo")).toBe(true);
		expect(looksLikeGitUrl("./local")).toBe(false);
		expect(looksLikeGitUrl("/abs/path")).toBe(false);
	});
});

describe("loadFromGit (local repo)", () => {
	test("hydrates tracked files and skips ignored ones", async () => {
		const repo = makeRepo();
		try {
			const mirage = new VirtualFileSystem();
			const meta = await loadFromGit(mirage, repo.dir, { target: "/workspace" });

			expect(mirage.readFile("/workspace/README.md")).toBe("# Hello\n");
			expect(mirage.readFile("/workspace/src/index.ts")).toBe("export const x = 1;\n");
			expect(mirage.readFile("/workspace/.gitignore")).toBe("build/\n*.log\n");
			expect(mirage.exists("/workspace/build/output.js")).toBe(false);
			expect(mirage.exists("/workspace/debug.log")).toBe(false);

			expect(meta.branch).toBe("main");
			expect(meta.commit?.length).toBe(40);
			expect(meta.commitMessage).toBe("feat: initial");
			expect(meta.commitAuthor).toBe("Test <test@example.com>");
			expect(meta.cloned).toBe(false);
		} finally {
			repo.cleanup();
		}
	});

	test("includes untracked-but-not-ignored files by default", async () => {
		const repo = makeRepo();
		try {
			fs.writeFileSync(nodePath.join(repo.dir, "todo.txt"), "wip");
			const mirage = new VirtualFileSystem();
			await loadFromGit(mirage, repo.dir);
			expect(mirage.readFile("/todo.txt")).toBe("wip");
		} finally {
			repo.cleanup();
		}
	});

	test("includeUntracked=false skips uncommitted files", async () => {
		const repo = makeRepo();
		try {
			fs.writeFileSync(nodePath.join(repo.dir, "todo.txt"), "wip");
			const mirage = new VirtualFileSystem();
			await loadFromGit(mirage, repo.dir, { includeUntracked: false });
			expect(mirage.exists("/todo.txt")).toBe(false);
		} finally {
			repo.cleanup();
		}
	});

	test("falls back to plain disk load when source has no .git", async () => {
		const dir = makeTempDir();
		try {
			fs.writeFileSync(nodePath.join(dir, "a.txt"), "hi");
			fs.writeFileSync(nodePath.join(dir, ".gitignore"), "ignored.txt\n");
			fs.writeFileSync(nodePath.join(dir, "ignored.txt"), "no");

			const mirage = new VirtualFileSystem();
			const meta = await loadFromGit(mirage, dir);
			expect(mirage.readFile("/a.txt")).toBe("hi");
			expect(mirage.exists("/ignored.txt")).toBe(false);
			expect(meta.cloned).toBe(false);
			expect(meta.commit).toBeUndefined();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects ref on a local path", async () => {
		const repo = makeRepo();
		try {
			const mirage = new VirtualFileSystem();
			await expect(loadFromGit(mirage, repo.dir, { ref: "main" })).rejects.toThrow(/ref/);
		} finally {
			repo.cleanup();
		}
	});
});

describe("loadFromGit (clone)", () => {
	test("clones a local file:// URL into a temp dir", async () => {
		const repo = makeRepo();
		try {
			const mirage = new VirtualFileSystem();
			const meta = await loadFromGit(mirage, pathToFileURL(repo.dir).href, { depth: 1 });
			expect(mirage.readFile("/README.md")).toBe("# Hello\n");
			expect(meta.cloned).toBe(true);
			// Temp clone should be cleaned up by default
			expect(fs.existsSync(meta.workingTreePath)).toBe(false);
		} finally {
			repo.cleanup();
		}
	});

	test("keepClone=true preserves the temp dir", async () => {
		const repo = makeRepo();
		try {
			const mirage = new VirtualFileSystem();
			const meta = await loadFromGit(mirage, pathToFileURL(repo.dir).href, {
				depth: 1,
				keepClone: true,
			});
			expect(fs.existsSync(meta.workingTreePath)).toBe(true);
			fs.rmSync(meta.workingTreePath, { recursive: true, force: true });
		} finally {
			repo.cleanup();
		}
	});
});

describe("saveAsGitRepo", () => {
	test("writes files, runs git init, and commits", async () => {
		const dest = makeTempDir();
		try {
			const mirage = new VirtualFileSystem({
				files: {
					"/work/package.json": `{"name":"x"}`,
					"/work/src/index.ts": "export const x = 1;\n",
				},
			});

			await saveAsGitRepo(mirage, "/work", dest, {
				commit: {
					message: "feat: initial commit",
					author: { name: "Test", email: "test@example.com" },
				},
			});

			expect(fs.existsSync(nodePath.join(dest, ".git"))).toBe(true);
			const meta = await readGitMetadata(dest);
			expect(meta.branch).toBe("main");
			expect(meta.commitMessage).toBe("feat: initial commit");
			expect(meta.commitAuthor).toBe("Test <test@example.com>");
		} finally {
			fs.rmSync(dest, { recursive: true, force: true });
		}
	});

	test("commit is a no-op on an empty diff", async () => {
		const dest = makeTempDir();
		try {
			const mirage = new VirtualFileSystem({ files: { "/work/a.txt": "hi" } });

			await saveAsGitRepo(mirage, "/work", dest, {
				commit: {
					message: "first",
					author: { name: "Test", email: "test@example.com" },
				},
			});
			// Second save with no changes should not throw
			await saveAsGitRepo(mirage, "/work", dest, {
				commit: {
					message: "noop",
					author: { name: "Test", email: "test@example.com" },
				},
			});

			const meta = await readGitMetadata(dest);
			expect(meta.commitMessage).toBe("first");
		} finally {
			fs.rmSync(dest, { recursive: true, force: true });
		}
	});

	test("adds a remote when one is requested", async () => {
		const dest = makeTempDir();
		try {
			const mirage = new VirtualFileSystem({ files: { "/work/a.txt": "hi" } });
			await saveAsGitRepo(mirage, "/work", dest, {
				remote: { name: "origin", url: "https://example.com/foo.git" },
			});

			const out = execFileSync("git", ["remote", "-v"], { cwd: dest, encoding: "utf8" });
			expect(out).toContain("origin");
			expect(out).toContain("https://example.com/foo.git");
		} finally {
			fs.rmSync(dest, { recursive: true, force: true });
		}
	});
});

describe("round trip", () => {
	test("loadFromGit + saveAsGitRepo preserves the working tree", async () => {
		const repo = makeRepo();
		const dest = makeTempDir();
		try {
			const mirage = new VirtualFileSystem();
			await loadFromGit(mirage, repo.dir);
			await saveAsGitRepo(mirage, "/", dest, {
				commit: {
					message: "feat: round-trip",
					author: { name: "Test", email: "test@example.com" },
				},
			});

			expect(fs.readFileSync(nodePath.join(dest, "README.md"), "utf8")).toBe("# Hello\n");
			expect(fs.readFileSync(nodePath.join(dest, "src/index.ts"), "utf8")).toBe(
				"export const x = 1;\n",
			);
			// Ignored files were dropped on load and not resurrected.
			expect(fs.existsSync(nodePath.join(dest, "build/output.js"))).toBe(false);
			expect(fs.existsSync(nodePath.join(dest, "debug.log"))).toBe(false);
		} finally {
			repo.cleanup();
			fs.rmSync(dest, { recursive: true, force: true });
		}
	});
});
