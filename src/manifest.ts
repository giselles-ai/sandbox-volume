import { createHash } from "node:crypto";

export type WorkspaceManifestVersion = number;

export interface WorkspaceManifest {
  version: WorkspaceManifestVersion;
  updatedAt: Date;
  paths: WorkspaceManifestEntry[];
}

export interface WorkspaceManifestEntry {
  path: string;
  hash: string;
  size: number;
  lastSeenAt: Date;
}

export type WorkspaceFileChangeKind = "create" | "update" | "delete";
export type WorkspaceDiffKind = WorkspaceFileChangeKind | "no-op";

export interface WorkspaceFileChange {
  kind: WorkspaceFileChangeKind;
  path: string;
  hash: string;
  size: number;
  lastSeenAt: Date;
}

export interface WorkspaceDiff {
  key: string;
  changes: WorkspaceFileChange[];
  kind: WorkspaceDiffKind;
}

export function hashContent(content: Uint8Array | string): string {
  return createHash("sha256")
    .update(typeof content === "string" ? content : Buffer.from(content))
    .digest("hex");
}

export function createEmptyManifest(at: Date = new Date()): WorkspaceManifest {
  return {
    version: 1,
    updatedAt: at,
    paths: [],
  };
}

export function buildManifest(
  paths: Array<{ path: string; content: Uint8Array }>,
  now: Date = new Date(),
): WorkspaceManifest {
  return {
    version: 1,
    updatedAt: now,
    paths: paths.map(({ path, content }) => ({
      path,
      size: content.byteLength,
      hash: hashContent(content),
      lastSeenAt: now,
    })),
  };
}

export function diffManifests(
  key: string,
  base: WorkspaceManifest | null,
  next: WorkspaceManifest,
): WorkspaceDiff {
  const oldByPath = new Map<string, WorkspaceManifestEntry>();
  const changed: WorkspaceDiff["changes"] = [];

  for (const entry of base?.paths ?? []) {
    oldByPath.set(entry.path, entry);
  }

  for (const entry of next.paths) {
    const before = oldByPath.get(entry.path);
    if (!before) {
      changed.push({
        kind: "create",
        path: entry.path,
        size: entry.size,
        hash: entry.hash,
        lastSeenAt: entry.lastSeenAt,
      });
      continue;
    }

    if (before.hash !== entry.hash || before.size !== entry.size) {
      changed.push({
        kind: "update",
        path: entry.path,
        size: entry.size,
        hash: entry.hash,
        lastSeenAt: entry.lastSeenAt,
      });
    }

    oldByPath.delete(entry.path);
  }

  for (const before of oldByPath.values()) {
    changed.push({
      kind: "delete",
      path: before.path,
      size: before.size,
      hash: before.hash,
      lastSeenAt: before.lastSeenAt,
    });
  }

  return {
    key,
    changes: changed,
    kind:
      changed.length === 0
        ? "no-op"
        : changed.every((entry) => entry.kind === "create")
          ? "create"
          : changed.every((entry) => entry.kind === "delete")
            ? "delete"
            : "update",
  };
}

export function hasChanges(diff: WorkspaceDiff): boolean {
  return diff.changes.length > 0;
}

export function dedupeWorkspaceChanges(
  changes: WorkspaceDiff["changes"],
): WorkspaceDiff["changes"] {
  const nextByPath = new Map<string, WorkspaceDiff["changes"][number]>();
  for (const change of changes) {
    nextByPath.set(change.path, change);
  }
  return [...nextByPath.values()];
}
