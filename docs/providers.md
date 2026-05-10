# Providers and Backends

This package exposes multiple pluggable backends/providers depending on the integration point.

## Filesystem adapters

- `VirtualFileSystem`: default in-memory provider.
- `ObjectFileSystem`: object-backed file source.
- `HttpFileSystem`: HTTP-backed reads.
- `ReadOnlyFileSystem`: write-protected wrapper.
- `LayeredFileSystem`: writable overlay + immutable base.
- `HookedFileSystem`: write interception/validation pipeline.

All adapters implement the same `IFileSystem` contract, so callers can compose them with mounts or wrap one implementation with another. For example, a sandbox can put a `LayeredFileSystem` over a `ReadOnlyFileSystem`, then add `HookedFileSystem` validation around the writable layer.

## Git backends (`@ambiently-work/mirage/git`)

- `IsoGitBackend`
  - Pure JavaScript implementation via `isomorphic-git`.
  - Supports clone/push/pull over HTTPS.
  - Best default for browser/workerd portability and small installs.

- `LibGit2Backend`
  - WASM-backed integration via `wasm-git`.
  - Uses libgit2 semantics for local repository operations such as init, add, commit, status, diff, branch, checkout, log, and object reads.
  - Routes clone/push/pull through the same mirage-backed HTTP transport used by the isomorphic backend, so remote operations still work against the in-memory repository layout.
  - Useful when libgit2-compatible local behavior is preferred.

Both backends implement the same `GitBackend` interface and are passed to `MirageGit`.

```ts
import { VirtualFileSystem } from "@ambiently-work/mirage";
import { IsoGitBackend, MirageGit } from "@ambiently-work/mirage/git";

const fs = new VirtualFileSystem({ bare: true });
fs.mkdir("/workspace", { recursive: true });

const git = new MirageGit({
  fs,
  dir: "/workspace",
  backend: new IsoGitBackend(),
});
```

## Selecting a backend

Default to `IsoGitBackend` unless you specifically need libgit2 semantics for local operations. Choose `LibGit2Backend` when matching libgit2 behavior matters more than the extra WASM module cost.

If you do not want `.git/` mixed into the working-tree filesystem, pass an `IFileSystem` as `gitdir`:

```ts
const repo = new VirtualFileSystem({ bare: true });
const git = new MirageGit({
  fs,
  dir: "/workspace",
  gitdir: repo,
  backend: new IsoGitBackend(),
});
```
