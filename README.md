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
- **Git loaders** (optional, `/git` export) — clone a URL or hydrate from a local repo via `git ls-files`; save back out as a fresh repo with `git init` + commit.
- **Built-in `.gitignore` matcher** — pure JS, browser-safe.
- **Zero runtime deps** — core package is pure TypeScript.

## Packages

Single package: `@ambiently-work/mirage`. Three entry points:

- `@ambiently-work/mirage` — core (browser + server safe), incl. `GitIgnore` matcher.
- `@ambiently-work/mirage/disk` — Node-only `loadFromDisk` / `saveToDisk`.
- `@ambiently-work/mirage/git` — Node-only `loadFromGit` / `saveAsGitRepo` (requires the `git` binary).

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

### Load a git repo (URL or local working tree)

`/git` clones a remote URL into a temp directory, or — for a local path — uses
`git ls-files` so `.gitignore` and `core.excludesfile` rules are respected
automatically. After loading, you get back metadata about the `HEAD` commit.

```ts
import { VirtualFileSystem } from "@ambiently-work/mirage";
import { loadFromGit, saveAsGitRepo } from "@ambiently-work/mirage/git";

const fs = new VirtualFileSystem();

// Clone a remote repo at a specific tag/branch into the mirage
const meta = await loadFromGit(fs, "https://github.com/foo/bar", {
  ref: "v1.2.3",
  depth: 1,
  target: "/workspace",
});
console.log(meta.commit, meta.commitMessage);

// Or hydrate from a local checkout (uses `git ls-files`)
await loadFromGit(fs, "./my-repo", { target: "/workspace" });

// …agent edits files in the mirage…

// Persist the workspace back to disk and commit it as a fresh repo
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
