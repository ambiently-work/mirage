import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualFileSystem } from "../../src/filesystem.js";
import { MirageGit } from "../../src/git/index.js";
import { LibGit2Backend, parseRawDiffTreeOutput } from "../../src/git/libgit2-backend.js";
import { decodeUtf8 } from "../../src/node.js";

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
	test("working-tree diff throws a descriptive error", async () => {
		const { git } = newGit();
		await git.init({ defaultBranch: "main" });
		await expect(git.diff()).rejects.toThrow(/tree-to-tree/);
	});
});

describe("LibGit2Backend — HTTP remotes", () => {
	test("clone reads a smart-HTTP repo and libgit2 can read the result", async () => {
		const remote = await createGitHttpRemote();
		try {
			const { git, fs } = newGit();
			await git.clone({ url: remote.url, ref: "main", depth: Infinity });

			expect(decodeUtf8(fs.readFileBytes("/workspace/README.md"))).toBe("# seed\n");
			const log = await git.log({ ref: "HEAD", depth: 1 });
			expect(log).toHaveLength(1);
			expect(log[0]?.message.trim()).toBe("feat: seed");
		} finally {
			remote.close();
		}
	});

	test("push sends refs to a smart-HTTP receive-pack handler", async () => {
		const remote = await createGitHttpRemote();
		try {
			const { git, fs } = newGit();
			await git.clone({ url: remote.url, ref: "main", depth: 1 });
			fs.writeFile("/workspace/pushed.txt", "from mirage\n");
			await git.add("pushed.txt");
			await git.commit({ message: "feat: push from mirage" });

			await git.push({ remote: "origin", ref: "main" });

			expect(remote.receivePackBodies.some((body) => body.includes("refs/heads/main"))).toBe(true);
			expect(runGit(remote.originPath, ["show", "main:pushed.txt"])).toBe("from mirage\n");
		} finally {
			remote.close();
		}
	});

	test("pull fast-forwards and rejects divergent history", async () => {
		const remote = await createGitHttpRemote();
		try {
			const { git, fs } = newGit();
			await git.clone({ url: remote.url, ref: "main" });

			const peer = nativeClone(remote);
			writeFileSync(join(peer, "remote.txt"), "from remote\n");
			runGit(peer, ["add", "remote.txt"]);
			runGit(peer, ["commit", "-m", "feat: remote change"]);
			runGit(peer, ["push", "origin", "main"]);

			await git.pull({
				remote: "origin",
				ref: "main",
				fastForwardOnly: true,
				author: { name: "Test", email: "test@example.com" },
			});
			expect(decodeUtf8(fs.readFileBytes("/workspace/remote.txt"))).toBe("from remote\n");

			fs.writeFile("/workspace/local.txt", "from local\n");
			await git.add("local.txt");
			await git.commit({ message: "feat: local divergent change" });

			writeFileSync(join(peer, "remote-2.txt"), "from remote again\n");
			runGit(peer, ["add", "remote-2.txt"]);
			runGit(peer, ["commit", "-m", "feat: second remote change"]);
			runGit(peer, ["push", "origin", "main"]);

			await expect(
				git.pull({
					remote: "origin",
					ref: "main",
					fastForwardOnly: true,
					author: { name: "Test", email: "test@example.com" },
				}),
			).rejects.toThrow(/fast-forward|Fast-forward|merge/i);
		} finally {
			remote.close();
		}
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

interface GitHttpRemote {
	url: string;
	root: string;
	originPath: string;
	receivePackBodies: string[];
	close(): void;
}

async function createGitHttpRemote(): Promise<GitHttpRemote> {
	const root = mkdtempSync(join(tmpdir(), "mirage-git-http-"));
	const originPath = join(root, "origin.git");
	const seed = join(root, "seed");
	runGit(root, ["init", "--bare", "origin.git"]);
	runGit(originPath, ["config", "http.receivepack", "true"]);
	mkdirSync(seed);
	runGit(seed, ["init"]);
	runGit(seed, ["checkout", "-b", "main"]);
	runGit(seed, ["config", "user.name", "Test"]);
	runGit(seed, ["config", "user.email", "test@example.com"]);
	writeFileSync(join(seed, "README.md"), "# seed\n");
	runGit(seed, ["add", "README.md"]);
	runGit(seed, ["commit", "-m", "feat: seed"]);
	runGit(seed, ["remote", "add", "origin", originPath]);
	runGit(seed, ["push", "origin", "main"]);
	runGit(originPath, ["symbolic-ref", "HEAD", "refs/heads/main"]);

	const receivePackBodies: string[] = [];
	const port = await getFreePort();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		async fetch(req) {
			const url = new URL(req.url);
			const requestBody = new Uint8Array(await req.arrayBuffer());
			if (url.pathname.endsWith("/git-receive-pack")) {
				receivePackBodies.push(new TextDecoder().decode(requestBody));
			}

			const proc = Bun.spawn(["git", "http-backend"], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					GIT_PROJECT_ROOT: root,
					GIT_HTTP_EXPORT_ALL: "1",
					PATH_INFO: decodeURIComponent(url.pathname),
					QUERY_STRING: url.search.slice(1),
					REQUEST_METHOD: req.method,
					CONTENT_TYPE: req.headers.get("content-type") ?? "",
					CONTENT_LENGTH: String(requestBody.byteLength),
					REMOTE_ADDR: "127.0.0.1",
				},
			});
			proc.stdin.write(requestBody);
			proc.stdin.end();

			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).arrayBuffer(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (exitCode !== 0) {
				return new Response(stderr, { status: 500 });
			}
			return cgiResponse(new Uint8Array(stdout));
		},
	});

	return {
		url: `http://127.0.0.1:${port}/origin.git`,
		root,
		originPath,
		receivePackBodies,
		close() {
			server.stop(true);
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close(() => reject(new Error("failed to allocate a local port")));
				return;
			}
			const { port } = address;
			server.close(() => resolve(port));
		});
	});
}

function nativeClone(remote: GitHttpRemote): string {
	const peer = join(remote.root, `peer-${Math.random().toString(16).slice(2)}`);
	runGit(remote.root, ["clone", remote.originPath, peer]);
	runGit(peer, ["checkout", "main"]);
	runGit(peer, ["config", "user.name", "Test"]);
	runGit(peer, ["config", "user.email", "test@example.com"]);
	return peer;
}

function cgiResponse(bytes: Uint8Array): Response {
	const text = new TextDecoder().decode(bytes);
	const crlf = text.indexOf("\r\n\r\n");
	const lf = text.indexOf("\n\n");
	const headerEnd = crlf >= 0 ? crlf : lf;
	const separatorLength = crlf >= 0 ? 4 : 2;
	if (headerEnd < 0) {
		return new Response(bytes, { status: 500 });
	}

	const rawHeaders = text.slice(0, headerEnd);
	const bodyOffset = new TextEncoder().encode(
		text.slice(0, headerEnd + separatorLength),
	).byteLength;
	const headers = new Headers();
	let status = 200;
	for (const line of rawHeaders.split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const name = line.slice(0, colon);
		const value = line.slice(colon + 1).trim();
		if (name.toLowerCase() === "status") {
			status = Number.parseInt(value, 10);
		} else {
			headers.append(name, value);
		}
	}
	return new Response(bytes.slice(bodyOffset), { status, headers });
}

function runGit(cwd: string, args: string[]): string {
	const proc = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
	const stdout = new TextDecoder().decode(proc.stdout);
	if (proc.exitCode !== 0) {
		const stderr = new TextDecoder().decode(proc.stderr);
		throw new Error(`git ${args.join(" ")} failed in ${cwd}\n${stderr || stdout}`);
	}
	return stdout;
}
