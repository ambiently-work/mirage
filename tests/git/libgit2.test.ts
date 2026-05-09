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
});

describe("LibGit2Backend — diff", () => {
	test("parses NUL-delimited diff-tree raw output", () => {
		const before = "1111111111111111111111111111111111111111";
		const after = "2222222222222222222222222222222222222222";
		const added = "3333333333333333333333333333333333333333";
		const removed = "4444444444444444444444444444444444444444";
		const typeChangedA = "5555555555555555555555555555555555555555";
		const typeChangedB = "6666666666666666666666666666666666666666";
		const out = [
			`:100644 100644 ${before} ${after} M`,
			"changed λ file.txt",
			`:000000 100644 0000000000000000000000000000000000000000 ${added} A`,
			"added.txt",
			`:100644 000000 ${removed} 0000000000000000000000000000000000000000 D`,
			"removed.txt",
			`:100644 120000 ${typeChangedA} ${typeChangedB} T`,
			"type changed.txt",
			"",
		].join("\0");

		expect(parseRawDiffTreeOutput(out)).toEqual([
			{ path: "changed λ file.txt", added: false, removed: false, aOid: before, bOid: after },
			{ path: "added.txt", added: true, removed: false, aOid: null, bOid: added },
			{ path: "removed.txt", added: false, removed: true, aOid: removed, bOid: null },
			{
				path: "type changed.txt",
				added: false,
				removed: false,
				aOid: typeChangedA,
				bOid: typeChangedB,
			},
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

	test("diffs HEAD against working tree changes", async () => {
		const { git, fs } = newGit();
		await git.init({ defaultBranch: "main" });
		fs.writeFile("/workspace/changed.txt", "one");
		fs.writeFile("/workspace/removed.txt", "bye");
		await git.add(["changed.txt", "removed.txt"]);
		await git.commit({ message: "feat: base" });

		fs.writeFile("/workspace/changed.txt", "two");
		fs.rm("/workspace/removed.txt", { force: true });
		fs.writeFile("/workspace/added.txt", "hello");

		const diff = await git.diff();
		const byPath = new Map(diff.map((d) => [d.path, d]));
		expect(byPath.get("changed.txt")).toMatchObject({ added: false, removed: false });
		expect(byPath.get("changed.txt")?.aOid).toMatch(/^[0-9a-f]{40}$/);
		expect(byPath.get("changed.txt")?.bOid).toMatch(/^[0-9a-f]{40}$/);
		expect(byPath.get("removed.txt")).toMatchObject({
			added: false,
			removed: true,
			bOid: null,
		});
		expect(byPath.get("added.txt")).toMatchObject({ added: true, removed: false, aOid: null });
		expect(diff.map((d) => d.path)).toEqual(["added.txt", "changed.txt", "removed.txt"]);
	});

	test("includes files added to an unborn working tree", async () => {
		const { git, fs } = newGit();
		await git.init({ defaultBranch: "main" });
		fs.writeFile("/workspace/added then staged.txt", "hello");
		await git.add("added then staged.txt");

		const diff = await git.diff();
		expect(diff).toHaveLength(1);
		expect(diff[0]).toMatchObject({
			path: "added then staged.txt",
			added: true,
			removed: false,
			aOid: null,
		});
		expect(diff[0]?.bOid).toMatch(/^[0-9a-f]{40}$/);
	});
});
