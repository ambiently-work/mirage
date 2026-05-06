import { describe, expect, test } from "bun:test";
import { VirtualFileSystem } from "../../src/filesystem.js";
import { LibGit2Backend, MirageGit } from "../../src/git/index.js";

function fresh(): VirtualFileSystem {
	const fs = new VirtualFileSystem({ bare: true });
	fs.mkdir("/workspace", { recursive: true });
	return fs;
}

function newGit(opts?: { gitdir?: VirtualFileSystem }): { git: MirageGit; fs: VirtualFileSystem } {
	const fs = fresh();
	const git = new MirageGit({
		fs,
		dir: "/workspace",
		gitdir: opts?.gitdir,
		backend: new LibGit2Backend(),
		defaultAuthor: { name: "Test", email: "test@example.com" },
	});
	return { git, fs };
}

describe("LibGit2Backend — init", () => {
	test("creates a repo with the requested default branch", async () => {
		const { git, fs } = newGit();
		await git.init({ defaultBranch: "main" });
		expect(fs.exists("/workspace/.git")).toBe(true);
		expect(fs.exists("/workspace/.git/HEAD")).toBe(true);
		const head = fs.readFile("/workspace/.git/HEAD").trim();
		expect(head).toBe("ref: refs/heads/main");
	});

	test("sidecar gitdir keeps .git out of the working FS", async () => {
		const sidecar = new VirtualFileSystem({ bare: true });
		const { git, fs } = newGit({ gitdir: sidecar });
		await git.init({ defaultBranch: "main" });
		expect(fs.exists("/workspace/.git")).toBe(false);
		expect(sidecar.exists("/HEAD")).toBe(true);
	});
});

describe("LibGit2Backend — write flow", () => {
	test("init + add + commit produces a HEAD commit", async () => {
		const { git, fs } = newGit();
		await git.init({ defaultBranch: "main" });
		fs.writeFile("/workspace/README.md", "# hello\n");
		await git.add("README.md");
		const oid = await git.commit({ message: "feat: initial" });
		expect(oid).toMatch(/^[0-9a-f]{40}$/);

		const head = await git.resolveRef("HEAD");
		expect(head).toBe(oid);
	});

	test("listRemotes returns added remote", async () => {
		const { git } = newGit();
		await git.init({ defaultBranch: "main" });
		await git.addRemote("origin", "https://example.com/foo.git");
		const remotes = await git.listRemotes();
		expect(remotes).toEqual([{ remote: "origin", url: "https://example.com/foo.git" }]);
	});
});

describe("LibGit2Backend — unsupported ops", () => {
	test("clone throws a descriptive error", async () => {
		const { git } = newGit();
		await expect(git.clone({ url: "https://example.com/x.git" })).rejects.toThrow(/IsoGitBackend/);
	});

	test("push throws a descriptive error", async () => {
		const { git } = newGit();
		await git.init({ defaultBranch: "main" });
		await expect(git.push({ remote: "origin" })).rejects.toThrow(/IsoGitBackend/);
	});

	test("diff throws a descriptive error", async () => {
		const { git } = newGit();
		await git.init({ defaultBranch: "main" });
		await expect(git.diff()).rejects.toThrow(/IsoGitBackend/);
	});
});
