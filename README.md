# mirage

A **pluggable, in-process virtual filesystem** written in TypeScript. Works in the browser, in Bun, in Node, and inside sandboxes — with no `node:fs` dependency in the core. Ships with layered overlays, HTTP/object-backed adapters, snapshot/restore, and a Node-only helper for loading a real repo into (and back out of) the VFS.

Built for agents, sandboxes, REPLs, and anything that needs "a filesystem without a filesystem."

```ts
import { VirtualFileSystem } from "@ambiently-work/vfs";

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
- **Disk loaders** (optional, `/disk` export) — load a repo from a real directory, or write the VFS back out.
- **Zero runtime deps** — core package is pure TypeScript.

## Packages

Single package: `@ambiently-work/vfs`. Two entry points:

- `@ambiently-work/vfs` — core (browser + server safe).
- `@ambiently-work/vfs/disk` — Node-only `loadFromDisk` / `saveToDisk`.

## Usage

### Basic

```ts
import { VirtualFileSystem } from "@ambiently-work/vfs";

const fs = new VirtualFileSystem();
fs.mkdir("/src", { recursive: true });
fs.writeFile("/src/hello.txt", "hi");
fs.readDir("/src"); // ["hello.txt"]
```

### Snapshot and restore

```ts
import { VirtualFileSystem, snapshot, restore } from "@ambiently-work/vfs";

const fs = new VirtualFileSystem({ files: { "/a.txt": "hello" } });
const snap = snapshot(fs);

// serialize, stash somewhere…
const json = JSON.stringify(snap);

// later:
const restored = restore(JSON.parse(json));
restored.readFile("/a.txt"); // "hello"
```

### Load a repo from disk

```ts
import { VirtualFileSystem } from "@ambiently-work/vfs";
import { loadFromDisk, saveToDisk } from "@ambiently-work/vfs/disk";

const fs = new VirtualFileSystem();
await loadFromDisk(fs, "/path/to/repo", { target: "/workspace" });

// …agent edits files in the VFS…

await saveToDisk(fs, "/workspace", "/path/to/output");
```

### Layered overlay

```ts
import { LayeredFileSystem, VirtualFileSystem, ReadOnlyFileSystem } from "@ambiently-work/vfs";

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
