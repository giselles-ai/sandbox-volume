import { describe, expect, it } from "bun:test";

import { buildManifest, createEmptyManifest, diffManifests, hasChanges } from "../manifest";

describe("manifest diff", () => {
  it("detects no changes when manifests are equal", () => {
    const nextTime = new Date("2026-03-17T00:00:00Z");
    const base = buildManifest(
      [
        {
          path: "src/index.ts",
          content: new TextEncoder().encode("console.log('same')"),
        },
      ],
      nextTime,
    );
    const next = buildManifest(
      [
        {
          path: "src/index.ts",
          content: new TextEncoder().encode("console.log('same')"),
        },
      ],
      nextTime,
    );

    const diff = diffManifests("repo/key", base, next);
    expect(hasChanges(diff)).toBe(false);
    expect(diff.kind).toBe("no-op");
    expect(diff.changes).toHaveLength(0);
  });

  it("detects created files", () => {
    const base = createEmptyManifest();
    const next = buildManifest([
      {
        path: "src/new.ts",
        content: new TextEncoder().encode("new file"),
      },
    ]);

    const diff = diffManifests("repo/key", base, next);
    expect(diff.changes).toEqual([
      {
        kind: "create",
        path: "src/new.ts",
        hash: expect.any(String),
        size: 8,
        lastSeenAt: expect.any(Date),
      },
    ]);
  });

  it("detects updated files", () => {
    const base = buildManifest([
      {
        path: "src/index.ts",
        content: new TextEncoder().encode("before"),
      },
    ]);
    const next = buildManifest([
      {
        path: "src/index.ts",
        content: new TextEncoder().encode("after"),
      },
    ]);

    const diff = diffManifests("repo/key", base, next);
    expect(diff.changes).toEqual([
      {
        kind: "update",
        path: "src/index.ts",
        hash: expect.any(String),
        size: 5,
        lastSeenAt: expect.any(Date),
      },
    ]);
  });

  it("detects deletions", () => {
    const base = buildManifest([
      {
        path: "obsolete.ts",
        content: new TextEncoder().encode("obsolete"),
      },
    ]);
    const next = buildManifest([]);
    const deleted = base.paths[0]!;

    const diff = diffManifests("repo/key", base, next);
    expect(diff.changes).toEqual([
      {
        kind: "delete",
        path: "obsolete.ts",
        hash: deleted.hash,
        size: deleted.size,
        lastSeenAt: deleted.lastSeenAt,
      },
    ]);
  });
});
