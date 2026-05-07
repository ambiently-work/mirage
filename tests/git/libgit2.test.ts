import { describe, expect, test } from "bun:test";
import { VirtualFileSystem } from "../../src/filesystem.js";
import { MirageGit } from "../../src/git/index.js";
import { LibGit2Backend, parseRawDiffTreeOutput } from "../../src/git/libgit2-backend.js";

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

	test("readBlob round-trips arbitrary bytes from a commit", async () => {
		const { git, fs } = newGit();
		await git.init({ defaultBranch: "main" });
		const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
		fs.writeFileBytes("/workspace/bin.dat", bytes);
		await git.add("bin.dat");
		const oid = await git.commit({ message: "binary" });

		const blob = await git.readBlob(oid, "bin.dat");
		expect(Array.from(blob)).toEqual(Array.from(bytes));
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

	test("working-tree diff throws a descriptive error", async () => {
		const { git } = newGit();
		await git.init({ defaultBranch: "main" });
		await expect(git.diff()).rejects.toThrow(/tree-to-tree/);
	});
});

describe("LibGit2Backend — diff", () => {
	test("parses NUL-delimited diff-tree raw output", () => {
		const before = "1111111111111111111111111111111111111111";
		const after = "2222222222222222222222222222222222222222";
		const added = "3333333333333333333333333333333333333333";
		const removed = "4444444444444444444444444444444444444444";
		const out = [
			`:100644 100644 ${before} ${after} M`,
			"changed λ file.txt",
			`:000000 100644 0000000000000000000000000000000000000000 ${added} A`,
			"added.txt",
			`:100644 000000 ${removed} 0000000000000000000000000000000000000000 D`,
			"removed.txt",
			"",
		].join("\0");

		expect(parseRawDiffTreeOutput(out)).toEqual([
			{ path: "changed λ file.txt", added: false, removed: false, aOid: before, bOid: after },
			{ path: "added.txt", added: true, removed: false, aOid: null, bOid: added },
			{ path: "removed.txt", added: false, removed: true, aOid: removed, bOid: null },
		]);
	});

	test("parses newline-delimited diff-tree raw output", () => {
		const before = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const after = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		const out = `:100644 100644 ${before} ${after} M\tchanged.txt\n`;

		expect(parseRawDiffTreeOutput(out)).toEqual([
			{ path: "changed.txt", added: false, removed: false, aOid: before, bOid: after },
		]);
	});

	test("diffs committed trees", async () => {
		const { git, fs } = newGit();
		await git.init({ defaultBranch: "main" });
		fs.writeFile("/workspace/a.txt", "one");
		fs.writeFile("/workspace/b.txt", "two");
		await git.add(["a.txt", "b.txt"]);
		const base = await git.commit({ message: "feat: base" });

		fs.writeFile("/workspace/a.txt", "ONE");
		fs.rm("/workspace/b.txt", { force: true });
		fs.writeFile("/workspace/c.txt", "three");
		await git.add(["a.txt", "b.txt", "c.txt"]);
		const next = await git.commit({ message: "feat: update" });

		const diff = await git.diff({ a: base, b: next });
		const byPath = new Map(diff.map((d) => [d.path, d]));
		expect(byPath.get("a.txt")).toMatchObject({ added: false, removed: false });
		expect(byPath.get("a.txt")?.aOid).toMatch(/^[0-9a-f]{40}$/);
		expect(byPath.get("a.txt")?.bOid).toMatch(/^[0-9a-f]{40}$/);
		expect(byPath.get("b.txt")).toMatchObject({ added: false, removed: true, bOid: null });
		expect(byPath.get("c.txt")).toMatchObject({ added: true, removed: false, aOid: null });
		expect(diff.map((d) => d.path).sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
	});
});
