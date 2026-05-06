# mirage

A **pluggable, in-process virtual filesystem** written in TypeScript. Works in the browser, in Bun, in Node, and inside sandboxes — with no `node:fs` dependency in the core. Ships with layered overlays, HTTP/object-backed adapters, snapshot/restore, a built-in `.gitignore` matcher, and Node-only helpers for loading a real repo (or a git URL) into and back out of the mirage.

Built for agents, sandboxes, REPLs, and anything that needs "a filesystem without a filesystem."

```ts
import { VirtualFileSystem } from "@ambiently-work/mirage";

const fs = new VirtualFileSystem({
  files: { "/src/index.ts": "export const hi = 'world';\n" },
});

fs.writeFile("/src/index.ts", "export const hi = 'mirage';\n");
console.log(fs.readFile("/src/index.ts"));
```

## Features

- **POSIX-ish semantics** — `readFile`, `writeFile`, `mkdir`, `rm`, `mv`, `cp`, symlinks, `chmod`, glob, ...
- **`IFileSystem` interface** — one contract, plug anything in (in-memory, object, HTTP, layered, read-only, your own).
- **Mount points** — compose filesystems at arbitrary paths.
- **Snapshot / restore** — dump the whole FS (including symlinks and modes) and rehydrate it later.
- **Layered overlays** — a writable scratch layer on top of an immutable base.
- **Disk loaders** (optional, `/disk` export) — load a directory from disk (with `.gitignore` support), or write the mirage back out.
- **In-process git** (optional, `/git` export) — `MirageGit` runs `clone`/`add`/`commit`/`status`/`diff`/`log`/`branch`/`checkout`/`push`/`pull` directly against the mirage in browsers, workerd, Bun, and Node. Two pluggable backends: `IsoGitBackend` (isomorphic-git, pure JS) and `LibGit2Backend` (libgit2-via-WASM). `.git/` lives in-tree by default, or in a sidecar filesystem on request.
- **Git CLI loaders** (Node-only, `/git-cli` export) — clone a URL or hydrate from a local repo via the `git` binary; save back out as a fresh repo.
- **Built-in `.gitignore` matcher** — pure JS, browser-safe.
- **Binary-safe storage** — `readFileBytes` / `writeFileBytes` round-trip arbitrary bytes; the string API encodes/decodes UTF-8.

## Packages

Single package: `@ambiently-work/mirage`. Four entry points:

- `@ambiently-work/mirage` — core (browser + server safe), incl. `GitIgnore` matcher.
- `@ambiently-work/mirage/disk` — Node-only `loadFromDisk` / `saveToDisk`.
- `@ambiently-work/mirage/git` — browser-safe in-process git (`MirageGit`, `IsoGitBackend`, `LibGit2Backend`).
- `@ambiently-work/mirage/git-cli` — Node-only `loadFromGit` / `saveAsGitRepo` (requires the `git` binary).

## Usage

### Basic

```ts
import { VirtualFileSystem } from "@ambiently-work/mirage";

const fs = new VirtualFileSystem();
fs.mkdir("/src", { recursive: true });
fs.writeFile("/src/hello.txt", "hi");
fs.readDir("/src"); // ["hello.txt"]
```

### Snapshot and restore

```ts
import { VirtualFileSystem, snapshot, restore } from "@ambiently-work/mirage";

const fs = new VirtualFileSystem({ files: { "/a.txt": "hello" } });
const snap = snapshot(fs);

// serialize, stash somewhere…
const json = JSON.stringify(snap);

// later:
const restored = restore(JSON.parse(json));
restored.readFile("/a.txt"); // "hello"
```

### Load a directory from disk

```ts
import { VirtualFileSystem } from "@ambiently-work/mirage";
import { loadFromDisk, saveToDisk } from "@ambiently-work/mirage/disk";

const fs = new VirtualFileSystem();
await loadFromDisk(fs, "/path/to/repo", {
  target: "/workspace",
  gitignore: true, // honour .gitignore files (root + nested) while walking
});

// …agent edits files in the mirage…

await saveToDisk(fs, "/workspace", "/path/to/output");
```

### In-process git (browser / workerd / Bun / Node)

`@ambiently-work/mirage/git` bundles two engines that run anywhere — browsers,
workerd, Bun, Node — with no `git` binary needed. Operations execute against
the mirage filesystem directly: clone over HTTP, stage/commit, status/diff,
branch/checkout, log, push/pull. `.git/` lives inside the working-tree mirage
by default, or in an opt-in sidecar filesystem.

```ts
import { VirtualFileSystem } from "@ambiently-work/mirage";
import { MirageGit, IsoGitBackend, LibGit2Backend } from "@ambiently-work/mirage/git";

const fs = new VirtualFileSystem({ bare: true });
fs.mkdir("/workspace", { recursive: true });

const git = new MirageGit({
  fs,
  dir: "/workspace",
  backend: new IsoGitBackend(),               // or new LibGit2Backend()
  defaultAuthor: { name: "Agent", email: "agent@example.com" },
});

await git.clone({ url: "https://github.com/foo/bar", ref: "main" });

fs.writeFile("/workspace/src/index.ts", "// agent edit\n");
await git.add(["src/index.ts"]);
const oid = await git.commit({ message: "feat: agent edit" });

const status = await git.status();   // [filepath, head, workdir, stage] rows
const log = await git.log({ depth: 5 });
const blob = await git.readBlob(oid, "src/index.ts");
```

**Picking a backend.** `IsoGitBackend` (default) is pure JS — clone/push/pull
against any HTTPS git host that supports the smart protocol, full diff/walk
support, smallest install. `LibGit2Backend` uses libgit2 compiled to WASM
(via `wasm-git`) and supports init/add/commit/log/status/branch/checkout but
not clone/push/pull/diff in v1; it's swappable so you can opt in for libgit2
semantics where you need them. Both implement the same `GitBackend` interface.

**Sidecar `.git/`.** Pass an `IFileSystem` instead of a path for `gitdir` to
keep `.git/` out of the working-tree mirage. Useful when `snapshot(fs)` should
serialize just the project, not the object database:

```ts
const repo = new VirtualFileSystem({ bare: true });
const git = new MirageGit({ fs, dir: "/workspace", gitdir: repo, backend: new IsoGitBackend() });
```

### Load a git repo from disk (Node-only, requires `git` binary)

For Node-only code that needs to bulk-load an existing checkout via the system
`git` binary, use `@ambiently-work/mirage/git-cli`. It clones/inspects via
`git ls-files` (so `.gitignore` and `core.excludesfile` are respected) and can
write the mirage back out as a fresh repo.

```ts
import { VirtualFileSystem } from "@ambiently-work/mirage";
import { loadFromGit, saveAsGitRepo } from "@ambiently-work/mirage/git-cli";

const fs = new VirtualFileSystem();

const meta = await loadFromGit(fs, "https://github.com/foo/bar", {
  ref: "v1.2.3",
  depth: 1,
  target: "/workspace",
});
console.log(meta.commit, meta.commitMessage);

await saveAsGitRepo(fs, "/workspace", "/tmp/out", {
  commit: {
    message: "feat: agent edits",
    author: { name: "Agent", email: "agent@example.com" },
  },
  remote: { name: "origin", url: "git@github.com:you/fork.git" },
});
```

### Match a `.gitignore` (no Node required)

```ts
import { GitIgnore, matchGitignore } from "@ambiently-work/mirage";

const gi = new GitIgnore("*.log\n!important.log\n/build/\n");
gi.ignores("foo.log"); // true
gi.ignores("important.log"); // false
gi.ignores("build", true); // true (directory-only rule)

// Or one-shot:
matchGitignore("dist/\n*.tmp", "dist/bundle.js"); // true
```

### Layered overlay

```ts
import { LayeredFileSystem, VirtualFileSystem, ReadOnlyFileSystem } from "@ambiently-work/mirage";

const base = new ReadOnlyFileSystem(new VirtualFileSystem({ files: { "/etc/config": "..." } }));
const overlay = new VirtualFileSystem();
const fs = new LayeredFileSystem(overlay, base);

fs.writeFile("/etc/config", "modified"); // goes to overlay
fs.readFile("/etc/config"); // reads from overlay
```

## Built with mirage

- [faux](https://github.com/ambiently-work/faux) — in-process POSIX shell.
- [agent-sdk](https://github.com/ambiently-work/agent-sdk) — LLM agent loop with sandboxed tools.

## License

MIT © ambiently
