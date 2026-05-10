# @ambiently-work/mirage

In-process virtual filesystem for TypeScript runtimes: Node, Bun, browsers, and workerd-style sandboxes.

Use Mirage when you need filesystem behavior without host disk access: agent sandboxes, code transforms, previews, tests, REPLs, and short-lived workspaces.

## Install

```bash
bun add @ambiently-work/mirage
# or
npm i @ambiently-work/mirage
# or
pnpm add @ambiently-work/mirage
```

## Quickstart

```ts
import { VirtualFileSystem } from "@ambiently-work/mirage";

const fs = new VirtualFileSystem({
  files: { "/app/index.ts": "export const hello = 'world'\n" },
});

fs.writeFile("/app/index.ts", "export const hello = 'mirage'\n");
console.log(fs.readFile("/app/index.ts"));
```

## What you get

- POSIX-like file APIs: `readFile`, `writeFile`, `mkdir`, `rm`, `mv`, `cp`, symlinks, chmod, glob, and byte reads/writes.
- An `IFileSystem` contract for swapping implementations.
- Mount points and composable adapters.
- Snapshot/restore for full in-memory state transfer.
- Layered overlays for scratch edits on top of immutable bases.
- Hooked writes for formatters, linters, and guardrails.
- Browser-safe `.gitignore` matching.
- In-process git through `MirageGit` with swappable backends.
- Node-only disk and git CLI loaders for real checkouts.
- Explicitly configured built-in tools for filesystem, shell, HTTP, search, and code evaluation integrations.

## Entry points

```ts
import { VirtualFileSystem } from "@ambiently-work/mirage";
import { loadFromDisk, saveToDisk } from "@ambiently-work/mirage/disk"; // Node-only
import { MirageGit, IsoGitBackend, LibGit2Backend } from "@ambiently-work/mirage/git";
import { loadFromGit, saveAsGitRepo } from "@ambiently-work/mirage/git-cli"; // Node-only, requires `git`
import { HookedFileSystem } from "@ambiently-work/mirage/hooks";
```

## Core examples

### Snapshot and restore

```ts
import { VirtualFileSystem, snapshot, restore } from "@ambiently-work/mirage";

const fs = new VirtualFileSystem({ files: { "/a.txt": "hello" } });
const snap = snapshot(fs);
const restored = restore(snap);

console.log(restored.readFile("/a.txt")); // hello
```

### Layered sandbox

Use a writable overlay on top of an immutable base filesystem.

```ts
import { LayeredFileSystem, ReadOnlyFileSystem, VirtualFileSystem } from "@ambiently-work/mirage";

const base = new ReadOnlyFileSystem(
  new VirtualFileSystem({ files: { "/project/config.json": "{}\n" } }),
);
const overlay = new VirtualFileSystem();
const fs = new LayeredFileSystem(overlay, base);

fs.writeFile("/project/config.json", '{"edited":true}\n');
console.log(fs.readFile("/project/config.json")); // {"edited":true}
```

### Hooked writes

Wrap a filesystem with `HookedFileSystem` to run formatters or validation before writes land.

```ts
import { HookedFileSystem, VirtualFileSystem } from "@ambiently-work/mirage";

const fs = new HookedFileSystem(new VirtualFileSystem(), {
  rules: [
    {
      glob: "/src/**/*.ts",
      extensions: "ts",
      hook: (content) => {
        if (typeof content !== "string") return;
        return `${content.trim()}\n`;
      },
    },
    {
      extensions: ["ts", "tsx"],
      hook: (content, ctx) => {
        if (typeof content === "string" && content.includes("debugger")) {
          throw new Error(`${ctx.path}: debugger is not allowed`);
        }
      },
    },
  ],
});
```

### Load a directory from disk

`@ambiently-work/mirage/disk` is Node-only. It keeps the core package free of `node:fs`.

```ts
import { VirtualFileSystem } from "@ambiently-work/mirage";
import { loadFromDisk, saveToDisk } from "@ambiently-work/mirage/disk";

const fs = new VirtualFileSystem();
await loadFromDisk(fs, "/path/to/repo", {
  target: "/workspace",
  gitignore: true,
});

// Agent edits files in the mirage.

await saveToDisk(fs, "/workspace", "/path/to/output");
```

### In-process git

`@ambiently-work/mirage/git` runs against the mirage filesystem directly in browsers, workerd, Bun, and Node. The working tree lives in the mirage. `.git/` lives there by default too, or in a sidecar filesystem if you pass one.

```ts
import { VirtualFileSystem } from "@ambiently-work/mirage";
import { IsoGitBackend, LibGit2Backend, MirageGit } from "@ambiently-work/mirage/git";

const fs = new VirtualFileSystem({ bare: true });
fs.mkdir("/workspace", { recursive: true });

const git = new MirageGit({
  fs,
  dir: "/workspace",
  backend: new IsoGitBackend(), // or new LibGit2Backend()
  defaultAuthor: { name: "Agent", email: "agent@example.com" },
});

await git.clone({ url: "https://github.com/foo/bar", ref: "main" });

fs.writeFile("/workspace/src/index.ts", "// agent edit\n");
await git.add(["src/index.ts"]);
const oid = await git.commit({ message: "feat: agent edit" });

const status = await git.status();
const log = await git.log({ depth: 5 });
const blob = await git.readBlob(oid, "src/index.ts");
```

`IsoGitBackend` is the default pure-JS backend. It uses `isomorphic-git` and supports clone, push, and pull over HTTPS.

`LibGit2Backend` uses libgit2 compiled to WASM for local repository operations, with remote clone, push, and pull routed through the same mirage-backed HTTP transport used by the isomorphic backend. Use it when you need libgit2 behavior for local git semantics.

To keep `.git/` out of the working-tree mirage, pass an `IFileSystem` as `gitdir`:

```ts
const repo = new VirtualFileSystem({ bare: true });
const git = new MirageGit({
  fs,
  dir: "/workspace",
  gitdir: repo,
  backend: new IsoGitBackend(),
});
```

### Load a git repo through the `git` binary

`@ambiently-work/mirage/git-cli` is Node-only and requires the system `git` binary. It is useful for loading an existing checkout or exporting a mirage subtree as a fresh repository.

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

### Match a `.gitignore`

```ts
import { GitIgnore, matchGitignore } from "@ambiently-work/mirage";

const gi = new GitIgnore("*.log\n!important.log\n/build/\n");
gi.ignores("foo.log"); // true
gi.ignores("important.log"); // false
gi.ignores("build", true); // true

matchGitignore("dist/\n*.tmp", "dist/bundle.js"); // true
```

## Built-in tools

Mirage exports optional built-in native tools from the root package:

- `FilesystemBuiltins`: constrained `readFile`, `writeFile`, `listDir`, and `glob`.
- `ShellBuiltins`: allowlisted command execution with timeout and stdout/stderr capture.
- `HttpBuiltins`: allowlisted HTTP requests with response size limits.
- `SearchBuiltins`: a pluggable web search adapter interface.
- `CodeEvalBuiltins`: one-shot TypeScript execution through a caller-provided sandbox adapter.

All built-ins require explicit configuration at construction time. They do not get ambient filesystem, shell, network, or eval authority by default.

## Docs

- [Architecture](./docs/architecture.md)
- [Providers and backends](./docs/providers.md)

## Development

```bash
bun run check
bun test
bun run build
```

## Built with Mirage

- [faux](https://github.com/ambiently-work/faux) - in-process POSIX shell.
- [agent-sdk](https://github.com/ambiently-work/agent-sdk) - LLM agent loop with sandboxed tools.

## License

MIT
