import { describe, expect, test } from "bun:test";
import { VirtualFileSystem } from "../../src/filesystem.js";
import { IsoGitBackend, MirageGit } from "../../src/git/index.js";
import { decodeUtf8 } from "../../src/node.js";

function fresh(): VirtualFileSystem {
	const fs = new VirtualFileSystem({ bare: true });
	fs.mkdir("/workspace", { recursive: true });
	return fs;
}

function newGit(opts?: {
	gitdir?: VirtualFileSystem | string;
	dir?: string;
	fs?: VirtualFileSystem;
}): { git: MirageGit; fs: VirtualFileSystem } {
	const fs = opts?.fs ?? fresh();
	const git = new MirageGit({
		fs,
		dir: opts?.dir ?? "/workspace",
		gitdir: opts?.gitdir,
		backend: new IsoGitBackend(),
		defaultAuthor: { name: "Test", email: "test@example.com" },
	});
	return { git, fs };
}

describe("IsoGitBackend — basic flow", () => {
	test("init + add + commit + log roundtrip", async () => {
		const { git, fs } = newGit();
		await git.init({ defaultBranch: "main" });
		fs.writeFile("/workspace/README.md", "# hello\n");
		await git.add("README.md");
		const oid = await git.commit({ message: "feat: initial" });
		expect(oid).toMatch(/^[0-9a-f]{40}$/);

		const log = await git.log();
		expect(log).toHaveLength(1);
		const head = log[0];
		expect(head?.oid).toBe(oid);
		expect(head?.message.trim()).toBe("feat: initial");
		expect(head?.author.name).toBe("Test");
	});

	test("status reflects working-tree changes", async () => {
		const { git, fs } = newGit();
		await git.init({ defaultBranch: "main" });
		fs.writeFile("/workspace/a.txt", "alpha");
		await git.add("a.txt");
		await git.commit({ message: "init" });

		// Modify and add a new file.
		fs.writeFile("/workspace/a.txt", "alpha modified");
		fs.writeFile("/workspace/b.txt", "beta");
		const status = await git.status();
		const byPath = Object.fromEntries(status.map((r) => [r[0], r]));
		// a.txt: at HEAD, modified in workdir, not staged => [1, 2, 1]
		expect(byPath["a.txt"]?.[1]).toBe(1);
		expect(byPath["a.txt"]?.[2]).toBe(2);
		// b.txt: not at HEAD, present in workdir, not staged => [0, 2, 0]
		expect(byPath["b.txt"]?.[1]).toBe(0);
		expect(byPath["b.txt"]?.[2]).toBe(2);
	});

	test("listBranches and currentBranch", async () => {
		const { git, fs } = newGit();
		await git.init({ defaultBranch: "main" });
		fs.writeFile("/workspace/a.txt", "x");
		await git.add("a.txt");
		await git.commit({ message: "init" });

		await git.branch({ ref: "feat/x", checkout: true });
		const branches = await git.listBranches();
		expect(branches.sort()).toEqual(["feat/x", "main"]);
		expect(await git.currentBranch()).toBe("feat/x");
	});

	test("readBlob round-trips arbitrary bytes", async () => {
		const { git, fs } = newGit();
		await git.init({ defaultBranch: "main" });
		// Pseudo-binary content: includes a 0x00 byte and a non-UTF-8 byte (0xFF).
		const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
		fs.writeFileBytes("/workspace/bin.dat", bytes);
		await git.add("bin.dat");
		await git.commit({ message: "binary" });

		const oid = await git.resolveRef("HEAD");
		const blob = await git.readBlob(oid, "bin.dat");
		expect(Array.from(blob)).toEqual(Array.from(bytes));
	});

	test("diff against HEAD reports added + modified + removed", async () => {
		const { git, fs } = newGit();
		await git.init({ defaultBranch: "main" });
		fs.writeFile("/workspace/a.txt", "one");
		fs.writeFile("/workspace/b.txt", "two");
		await git.add(["a.txt", "b.txt"]);
		await git.commit({ message: "init" });

		// Same-length sub-second overwrite: only `rev` advances, not size or
		// mtimeSeconds. The fs adapter mixes rev into ino so iso-git's stat
		// cache still invalidates and rehashes.
		fs.writeFile("/workspace/a.txt", "ONE");
		fs.rm("/workspace/b.txt", { force: true });
		fs.writeFile("/workspace/c.txt", "three");

		const diff = await git.diff();
		const byPath = new Map(diff.map((d) => [d.path, d]));
		expect(byPath.get("a.txt")?.added).toBe(false);
		expect(byPath.get("a.txt")?.removed).toBe(false);
		expect(byPath.get("b.txt")?.removed).toBe(true);
		expect(byPath.get("c.txt")?.added).toBe(true);
	});
});

describe("IsoGitBackend — .git storage", () => {
	test("in-tree gitdir places .git inside the working FS", async () => {
		const { git, fs } = newGit();
		await git.init({ defaultBranch: "main" });
		expect(fs.exists("/workspace/.git")).toBe(true);
		expect(fs.stat("/workspace/.git").isDirectory()).toBe(true);
		expect(fs.exists("/workspace/.git/HEAD")).toBe(true);
	});

	test("sidecar gitdir keeps the working FS lean", async () => {
		const sidecar = new VirtualFileSystem({ bare: true });
		const { git, fs } = newGit({ gitdir: sidecar });

		await git.init({ defaultBranch: "main" });
		fs.writeFile("/workspace/a.txt", "hi");
		await git.add("a.txt");
		await git.commit({ message: "init" });

		// `.git` should NOT exist in the working-tree mirage.
		expect(fs.exists("/workspace/.git")).toBe(false);
		// But it should exist in the sidecar.
		expect(sidecar.exists("/HEAD")).toBe(true);
		expect(sidecar.exists("/objects")).toBe(true);

		const log = await git.log();
		expect(log).toHaveLength(1);
		expect(log[0]?.message.trim()).toBe("init");
	});

	test("sidecar log roundtrip after writing a binary file", async () => {
		const sidecar = new VirtualFileSystem({ bare: true });
		const { git, fs } = newGit({ gitdir: sidecar });
		await git.init({ defaultBranch: "main" });
		const bytes = new Uint8Array([1, 2, 3, 0, 255]);
		fs.writeFileBytes("/workspace/data.bin", bytes);
		await git.add("data.bin");
		const oid = await git.commit({ message: "binary in sidecar" });

		const blob = await git.readBlob(oid, "data.bin");
		expect(Array.from(blob)).toEqual(Array.from(bytes));
	});
});

describe("IsoGitBackend — checkout", () => {
	test("checkout switches working tree to a branch", async () => {
		const { git, fs } = newGit();
		await git.init({ defaultBranch: "main" });
		fs.writeFile("/workspace/a.txt", "main version");
		await git.add("a.txt");
		await git.commit({ message: "main" });

		await git.branch({ ref: "feature", checkout: true });
		fs.writeFile("/workspace/a.txt", "feature version");
		await git.add("a.txt");
		await git.commit({ message: "feature" });

		await git.checkout({ ref: "main", force: true });
		expect(decodeUtf8(fs.readFileBytes("/workspace/a.txt"))).toBe("main version");

		await git.checkout({ ref: "feature", force: true });
		expect(decodeUtf8(fs.readFileBytes("/workspace/a.txt"))).toBe("feature version");
	});
});

describe("IsoGitBackend — remotes", () => {
	test("addRemote + listRemotes", async () => {
		const { git } = newGit();
		await git.init({ defaultBranch: "main" });
		await git.addRemote("origin", "https://example.com/foo.git");
		const remotes = await git.listRemotes();
		expect(remotes).toEqual([{ remote: "origin", url: "https://example.com/foo.git" }]);
	});
});
