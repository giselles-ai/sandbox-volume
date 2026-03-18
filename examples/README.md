`examples/index.ts` is a runnable example that exercises the public API of `@giselles-ai/sandbox-volume` against a real `@vercel/sandbox` instance.

It walks through the following flows:

- auto-commit with `mount()`
- manual transactions with `begin()` / `diff()` / `commit()`
- `commitAll()`
- `rewrite()`

## Prerequisites

- Bun `1.3` or later
- installed project dependencies
- Vercel credentials that allow `@vercel/sandbox` to run locally

If dependencies are not installed yet, run this from the repository root:

```bash
bun install
```

## Required Environment Variables

This example calls `Sandbox.create({ runtime: "node24" })`, so it requires authentication that `@vercel/sandbox` can use.

The simplest option is Vercel OIDC:

- `VERCEL_OIDC_TOKEN`

For local development, the usual workflow is to fetch it into `.env.local` with `vercel link` and `vercel env pull`:

```bash
vercel link
vercel env pull .env.local
```

If you are not using `VERCEL_OIDC_TOKEN`, you can use these variables instead:

- `VERCEL_TEAM_ID`
- `VERCEL_PROJECT_ID`
- `VERCEL_TOKEN`

This example does not use the Blob adapter, so `BLOB_READ_WRITE_TOKEN` is not required.

## How To Run

From the repository root:

```bash
bun --env-file=.env.local examples/index.ts
```

If you already exported the environment variables in your shell, this also works:

```bash
bun examples/index.ts
```

## What You Should See

On success, each phase prints diff / commit results as JSON to stdout, followed by `verification complete`.

Highlights:

- phase 1: creates `/vercel/sandbox/workspace/package.json` and `/vercel/sandbox/workspace/src/index.ts`, then auto-commits when `mount()` finishes
- phase 2: hydrates an existing workspace, then shows update, create, and delete changes through `diff()` and `commit()`
- phase 3: verifies a no-op `commitAll()` and a forced `rewrite()`

## Common Failures

- authentication errors
  - `.env.local` may be missing, or `VERCEL_OIDC_TOKEN` may have expired
  - run `vercel env pull .env.local` again
- `Sandbox.create()` fails
  - check that the local project is linked to the correct Vercel project and that your credentials have access
- `bun: command not found`
  - install Bun
