# Architecture

Mirage is built around a small, composable filesystem contract.

## Layers

1. **Core contract**: `IFileSystem` methods and node metadata/types.
2. **Default implementation**: `VirtualFileSystem` (in-memory tree).
3. **Adapters**: read-only, layered, object/HTTP-backed, write hooks.
4. **Optional integrations**:
   - `/disk` for host filesystem sync (Node-only)
   - `/git` for in-process git operations
   - `/git-cli` for shell `git` hydration/export (Node-only)
   - built-in native tools for explicitly configured filesystem, shell, HTTP, search, and code-eval adapters

## Design goals

- Runtime portability (browser, workerd, Bun, Node).
- Pure-JS core with no `node:fs` dependency.
- Deterministic behavior for tests/agents.
- Easy composition via wrappers and mounts.

## Data model notes

- Supports files, directories, and symlinks.
- Tracks metadata like mode bits.
- Snapshot/restore preserves structural fidelity.
