# @giselles-ai/sandbox-volume

Persistent workspace synchronization for [@vercel/sandbox](https://github.com/vercel/sandbox).

```ts
import { Sandbox } from "@vercel/sandbox";
import {
  SandboxVolume,
  InMemoryStorageAdapter,
} from "@giselles-ai/sandbox-volume";

const adapter = new VercelBlobStorageAdapter();
const volume = await SandboxVolume.create({
  key: "sandbox-volume",
  adapter,
  include: ["src/**", "package.json"],
  exclude: [".sandbox/**/*", "dist/**"],
});

const initialSandbox = await Sandbox.create();
await volume.mount(initialSandbox, async () => {
  await initialSandbox.runCommand("bash", [
    "-lc",
    "mkdir workspace && echo 'hello!' > workspace/notes.md",
  ]);
});


const anotherSandbox = await Sandbox.create();
await anotherSandbox.mount(anotherSandbox, async () => {
  await anotherSandbox.runCommand("bash", ["-lc", "cat workspace/notes.md"]);
  // => hello!
});
```

`sandbox-volume` is not a filesystem mount and not a VM snapshot layer.
It is a **transactional workspace sync**:

1. load persisted workspace files into a sandbox path (default `/vercel/sandbox/workspace`)
2. run your code
3. diff current files against the last saved manifest
4. optionally save manifest + files back through a pluggable adapter

## Install

```bash
npm i @giselles-ai/sandbox-volume @vercel/sandbox
```

## Public API

All public types and implementations are exported from the package root.

```ts
import {
	SandboxVolume,
	InMemoryStorageAdapter,
	createMemoryStorageAdapter,
	createVercelBlobStorageAdapter,
	VercelBlobStorageAdapter,
	WorkspaceLockError,
	WorkspaceLockConflictError,
	WorkspaceLockAcquisitionError,
	WorkspaceLockReleaseError,
	WorkspaceLockStaleError,
	ManifestDiff,
} from "@giselles-ai/sandbox-volume";
```

Runtime tests and examples should use this import shape so behavior is validated against the
published API surface, not internal module paths.

`mount()` runs your callback, then commits file changes automatically when the callback
resolves. If the callback throws, it still closes and releases locks but does not commit.

For a force-cleanup run after changing path rules, use `rewrite()` (or `resync()`) to
explicitly re-persist the current scoped snapshot.

## Manual verification

Run the example entrypoint to exercise the public API (`createMemoryStorageAdapter`,
`mount`, `begin`/`commit`, `commitAll`, and `rewrite`) with a real `@vercel/sandbox` instance.

Note: this requires a Vercel OIDC context in your local environment (for example via `vercel link` and a valid `VERCEL_OIDC_TOKEN` / `.env.local`).

```bash
pnpm -F @giselles-ai/sandbox-volume example
```

## Core API

- `SandboxVolume.create(options)`
  - `adapter`: `StorageAdapter` (required)
  - `key`: stable workspace identifier (string)
  - `path` (optional): mount path, default `"/vercel/sandbox/workspace"`
  - `defaultLockMode` (optional): `"none" | "exclusive" | "shared"`
  - `include` (optional): glob include list, defaults to all files
  - `exclude` (optional): glob exclude list, applied after `include`
- `volume.begin(sandbox, options?)`
  - options: `{ path?, lock? }`
  - opens a `WorkspaceTransaction`
- `volume.mount(sandbox, callback, options?)`
  - callback: `(sandbox, tx) => Promise<TResult>`
  - commits automatically on success
  - always closes transaction in `finally`
- `volume.commitAll(sandbox)`
  - opens, commits once, closes
- `volume.rewrite(sandbox, options?)`
  - force-pushes current in-scope snapshot back to storage
  - useful for cleanup when include/exclude rules were narrowed and historical entries remain
- `volume.resync(sandbox, options?)`
  - alias of `rewrite()` for teams that prefer a sync-style verb
  - safe to run on every startup after changing path filters to guarantee baseline alignment

Transaction (`WorkspaceTransaction`) methods:

- `open()`
- `diff()`: returns `{ key, kind, changes }`
- `commit()`: persists when changes exist (`committed: true`) and returns commit metadata
- `rewrite()`: persists current in-scope snapshot even if workspace is unchanged
- `close()`: idempotent cleanup and optional lock release

## Path filters (`include` / `exclude`)

`SandboxVolume` supports an allow/deny filter for file synchronization:

- `include` is an allow list. If empty or omitted, all paths are eligible.
- `exclude` is a deny list and always wins when a path matches both.
- filtering applies during hydration, scan, diff, and commit.
- only filtered-in paths are included in the persisted manifest.

Example filter set:

```ts
{
  include: ["src/**", "package.json"],
  exclude: ["src/generated/**", "dist/**"],
}
```

When using those filters, `notes.md` and `dist/out.js` are not persisted nor tracked.

Known caveat:

- If a workspace was previously saved with broader rules and later narrowed, historical
  out-of-scope entries are not removed immediately. They remain in storage until
  `rewrite()` (or `resync()`) is called.

## Scan strategy

`sandbox-volume` scans files by default with `bash + find`:

- Primary: `find <mountPath> -type f -print0`
- Fallback: `node -e` recursive walker using `fs.readdirSync`

If `find` is unavailable or fails, it automatically falls back to the node-based
strategy. Both paths produce absolute file paths, then convert to mount-relative paths.
If both strategies fail, commit/diff operations throw with a combined error describing
which strategies were attempted and why they failed.

Tradeoff:

- This remains shell-dependent for the primary path, and node fallback requires the
  sandbox runtime to have Node available for recursion. If both are unavailable in
  your environment, path discovery will fail with a clear message and no hidden fallback
  is attempted.

## Memory adapter

`@giselles-ai/sandbox-volume` currently ships with a concrete in-memory adapter for
tests/examples.

```ts
import {
  InMemoryStorageAdapter,
  createMemoryStorageAdapter,
} from "@giselles-ai/sandbox-volume";

const adapter = new InMemoryStorageAdapter();
// or
const adapter = createMemoryStorageAdapter();
```

## Vercel Blob adapter

This package now includes a concrete Vercel Blob adapter, suitable for lightweight
persistent workspace storage in Vercel deployments.

```ts
import {
  SandboxVolume,
  createVercelBlobStorageAdapter,
} from "@giselles-ai/sandbox-volume";

const adapter = createVercelBlobStorageAdapter({
  token: process.env.BLOB_READ_WRITE_TOKEN,
  namespace: "my-org",
});

const volume = await SandboxVolume.create({
  key: "repos/my-app",
  adapter,
});
```

Adapter options:

- `token`: Vercel Blob token. Defaults to `BLOB_READ_WRITE_TOKEN`.
- `namespace`: Blob key namespace used for persisted workspace state.
- `access`: Blob visibility (`"public"` or `"private"`). Defaults to `"public"`.

`VercelBlobStorageAdapter` persists a single JSON state blob per workspace key at
`<namespace>/<workspace-key>/workspace-state.json` containing both manifest and
the full filtered file payloads.

## Diff model

The package tracks a manifest containing file path + hash + size and compares manifests on
every transaction:

- `create` / `update` / `delete` change kinds
- `delete` is explicit, not inferred from timestamps
- no-op commits are returned as `{ committed: false }` without calling `saveWorkspace`

`commitAll(sandbox)` and `rewrite/resync` are useful for explicit control points in automation
pipelines where callback-based `mount()` is inconvenient.

## Locking

If `defaultLockMode` or `mount(..., { lock })` is not `"none"`, the adapter must
implement `acquireLock` and `releaseLock`.

The package does not assume lock TTL. If a lock can expire in your backend, surface that
as a stale/invalid lease through `WorkspaceLockStaleError`.

- `WorkspaceLockConflictError`: another writer currently owns the requested lock.
- `WorkspaceLockAcquisitionError`: lock acquisition failed for reasons other than known
  conflict.
- `WorkspaceLockReleaseError`: lock release failed for reasons other than stale/invalid
  lease.
- `WorkspaceLockStaleError`: the held lease is no longer valid or missing.

When integrating lock behavior in application code, export all of the lock errors
(`WorkspaceLockError` and its subtypes) from the package and narrow errors in catch blocks
to distinguish expected conflict/retry cases from release failures.

`mount` and transaction close paths release locks in `finally`, then:
- If the callback/commit path fails and lock release also fails, the callback/commit error
  wins (cleanup status is surfaced only when the callback/commit succeeds).
- If callback/commit succeeds, release errors are thrown to callers.

## Planned features

The following are not implemented yet:

- S3/Supabase adapters in this package
- snapshot/branch/share helpers (`fork`, `snapshot`, `share`)

## License

Apache-2.0
