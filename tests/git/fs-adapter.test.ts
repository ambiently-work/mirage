/**
 * Direct unit tests for the iso-git fs adapter — these protect the Windows
 * racy-git fix. iso-git's `compareStats` uses `trustino = false` on Windows
 * and only checks mode + size + mtimeSeconds, so the adapter MUST advance
 * `mtimeMs` across writes (not just `ino`) for diffs to detect same-second /
 * same-size overwrites cross-platform. We can't run a Windows VM in CI here,
 * so we verify the underlying invariant the Windows code path depends on.
 */

import { describe, expect, test } from "bun:test";
import { VirtualFileSystem } from "../../src/filesystem.js";
import { makeIsoGitFs } from "../../src/git/index.js";

describe("makeIsoGitFs — stat synthesis", () => {
	test("ino changes after a write (Linux/macOS code path)", async () => {
		const fs = new VirtualFileSystem({ bare: true });
		fs.writeFile("/a.txt", "v1");
		const adapter = makeIsoGitFs(fs, "/.git", "/");

		const before = (await adapter.promises.stat("/a.txt")) as { ino: number };
		fs.writeFile("/a.txt", "v2"); // same length on purpose
		const after = (await adapter.promises.stat("/a.txt")) as { ino: number };

		expect(after.ino).not.toBe(before.ino);
	});

	test("mtimeMs strictly advances across same-millisecond writes (Windows code path)", async () => {
		const fs = new VirtualFileSystem({ bare: true });
		fs.writeFile("/a.txt", "v1");
		const adapter = makeIsoGitFs(fs, "/.git", "/");

		const before = (await adapter.promises.stat("/a.txt")) as { mtimeMs: number };
		// Back-to-back same-size writes inside a single ms.
		fs.writeFile("/a.txt", "v2");
		fs.writeFile("/a.txt", "v3");
		const after = (await adapter.promises.stat("/a.txt")) as { mtimeMs: number };

		// On Windows iso-git ignores ino; only mtimeSeconds + size + mode count.
		// Adding `rev * 1000` to mtimeMs guarantees mtimeSeconds advances by at
		// least 1 per write, so any number of same-ms writes still register.
		expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);
		expect(Math.floor(after.mtimeMs / 1000)).toBeGreaterThan(Math.floor(before.mtimeMs / 1000));
	});

	test("size and mode mirror the underlying fs", async () => {
		const fs = new VirtualFileSystem({ bare: true });
		fs.writeFileBytes("/blob", new Uint8Array([1, 2, 3, 4, 5]));
		fs.chmod("/blob", 0o755);
		const adapter = makeIsoGitFs(fs, "/.git", "/");
		const s = (await adapter.promises.stat("/blob")) as { size: number; mode: number };
		expect(s.size).toBe(5);
		expect(s.mode & 0o777).toBe(0o755);
	});

	test("ENOENT errors carry an `code: 'ENOENT'` field for iso-git", async () => {
		const fs = new VirtualFileSystem({ bare: true });
		const adapter = makeIsoGitFs(fs, "/.git", "/");
		try {
			await adapter.promises.stat("/missing");
			throw new Error("expected stat to throw");
		} catch (err) {
			expect((err as { code?: string }).code).toBe("ENOENT");
		}
	});
});

describe("makeIsoGitFs — sidecar gitdir routing", () => {
	test("paths under `${dir}/.git` route to the sidecar fs", async () => {
		const working = new VirtualFileSystem({ bare: true });
		const sidecar = new VirtualFileSystem({ bare: true });
		const adapter = makeIsoGitFs(working, sidecar, "/workspace");

		await adapter.promises.writeFile("/workspace/.git/HEAD", "ref: refs/heads/main\n");
		await adapter.promises.writeFile("/workspace/src/index.ts", "// code\n");

		// Working-tree write landed in `working`, NOT `sidecar`.
		expect(working.readFile("/workspace/src/index.ts")).toBe("// code\n");
		expect(working.exists("/workspace/.git")).toBe(false);
		// `.git/` write was rewritten and landed in the sidecar at root.
		expect(sidecar.readFile("/HEAD")).toBe("ref: refs/heads/main\n");
	});

	test("readdir on the working dir does not leak gitdir entries", async () => {
		const working = new VirtualFileSystem({ bare: true });
		const sidecar = new VirtualFileSystem({ bare: true });
		const adapter = makeIsoGitFs(working, sidecar, "/workspace");

		working.mkdir("/workspace", { recursive: true });
		working.writeFile("/workspace/a.txt", "x");
		await adapter.promises.writeFile("/workspace/.git/HEAD", "...");

		// Working FS readdir of /workspace should NOT show `.git` since it
		// lives in the sidecar.
		const entries = await adapter.promises.readdir("/workspace");
		expect(entries).toEqual(["a.txt"]);
	});

	test("in-tree gitdir mode passes paths through unchanged", async () => {
		const working = new VirtualFileSystem({ bare: true });
		const adapter = makeIsoGitFs(working, "/workspace/.git", "/workspace");
		await adapter.promises.writeFile("/workspace/.git/HEAD", "...");
		expect(working.readFile("/workspace/.git/HEAD")).toBe("...");
	});
});
