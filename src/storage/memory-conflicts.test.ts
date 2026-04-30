import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Indexer } from "../indexer/indexer.js";
import { getProjectConfig } from "../utils/config.js";

// v0.20 contradiction-detection tests for the bi-temporal memory layer.
// These exercise MemoryStore.findConflicts — the new method behind the
// `sverklo_memories mode:"conflicts"` MCP surface.
//
// Detection rules under test:
//   1. Both memories must be active (valid_until_sha IS NULL)
//   2. They must share at least one pin
//   3. Category must be decision/preference/pattern (procedural/context excluded)
//   4. Same SHA pairs are skipped (co-recorded, not divergent)

describe("MemoryStore.findConflicts", () => {
  let tmpRoot: string;
  let indexer: Indexer;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "sverklo-conflicts-"));
    mkdirSync(join(tmpRoot, "src"), { recursive: true });
    indexer = new Indexer(getProjectConfig(tmpRoot));
    await indexer.index();
  });

  afterEach(() => {
    indexer.close();
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch { /* tmpdir cleanup is best-effort */ }
  });

  function insertWithPins(
    category: "decision" | "preference" | "pattern" | "procedural" | "context",
    content: string,
    pins: string[],
    sha: string | null
  ): number {
    const id = indexer.memoryStore.insert(
      category,
      content,
      null,
      1.0,
      sha,
      null,
      null,
      "project"
    );
    indexer.memoryStore.setPins(id, pins);
    return id;
  }

  it("returns empty array when no memories share pins", () => {
    insertWithPins("decision", "use postgres", ["src/db.ts"], "abc1230");
    insertWithPins("decision", "use react query", ["src/api.ts"], "abc1231");

    const conflicts = indexer.memoryStore.findConflicts();
    expect(conflicts).toHaveLength(0);
  });

  it("flags two decision memories with the same pin", () => {
    const a = insertWithPins(
      "decision",
      "JWT verification in middleware",
      ["src/auth.ts"],
      "abc123a"
    );
    const b = insertWithPins(
      "decision",
      "JWT verification in route handler",
      ["src/auth.ts"],
      "abc123b"
    );

    const conflicts = indexer.memoryStore.findConflicts();
    expect(conflicts).toHaveLength(1);
    const ids = [conflicts[0].a.id, conflicts[0].b.id].sort((x, y) => x - y);
    expect(ids).toEqual([a, b].sort((x, y) => x - y));
    expect(conflicts[0].sharedPins).toEqual(["src/auth.ts"]);
  });

  it("excludes procedural and context categories", () => {
    insertWithPins(
      "procedural",
      "to deploy: run npm run deploy",
      ["src/deploy.ts"],
      "abc1230"
    );
    insertWithPins(
      "context",
      "deploy script lives in scripts/",
      ["src/deploy.ts"],
      "abc1231"
    );
    insertWithPins(
      "procedural",
      "alternative deploy script flow",
      ["src/deploy.ts"],
      "abc1232"
    );

    const conflicts = indexer.memoryStore.findConflicts();
    expect(conflicts).toHaveLength(0);
  });

  it("excludes pairs co-recorded at the same SHA", () => {
    const sha = "abc1230";
    insertWithPins(
      "decision",
      "use postgres for primary store",
      ["src/db.ts"],
      sha
    );
    insertWithPins(
      "decision",
      "use redis for cache",
      ["src/db.ts"],
      sha
    );

    const conflicts = indexer.memoryStore.findConflicts();
    expect(conflicts).toHaveLength(0);
  });

  it("ranks by number of shared pins (more shared = stronger signal)", () => {
    // Pair 1: shares 2 pins
    insertWithPins(
      "decision",
      "auth: use OAuth via passport",
      ["src/auth.ts", "src/middleware.ts"],
      "abc111a"
    );
    insertWithPins(
      "decision",
      "auth: use JWT directly",
      ["src/auth.ts", "src/middleware.ts"],
      "abc111b"
    );
    // Pair 2: shares 1 pin
    insertWithPins(
      "preference",
      "prefer arrow functions",
      ["src/utils.ts"],
      "abc222a"
    );
    insertWithPins(
      "preference",
      "prefer named functions in this module",
      ["src/utils.ts"],
      "abc222b"
    );

    const conflicts = indexer.memoryStore.findConflicts();
    expect(conflicts.length).toBeGreaterThanOrEqual(2);
    expect(conflicts[0].sharedPins.length).toBeGreaterThanOrEqual(
      conflicts[1].sharedPins.length
    );
  });

  it("excludes invalidated (superseded) memories", () => {
    const a = insertWithPins(
      "decision",
      "JWT in middleware",
      ["src/auth.ts"],
      "abc1230"
    );
    const b = insertWithPins(
      "decision",
      "JWT in route handler",
      ["src/auth.ts"],
      "abc1231"
    );
    // Mark A as invalidated by B — proper bi-temporal supersession
    indexer.memoryStore.invalidate(a, "abc1231", b);

    const conflicts = indexer.memoryStore.findConflicts();
    expect(conflicts).toHaveLength(0);
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 6; i++) {
      insertWithPins(
        "decision",
        `decision A variant ${i}`,
        [`src/file${i}.ts`],
        `aaa${i}000`
      );
      insertWithPins(
        "decision",
        `decision B variant ${i}`,
        [`src/file${i}.ts`],
        `bbb${i}000`
      );
    }
    const limited = indexer.memoryStore.findConflicts(3);
    expect(limited.length).toBe(3);
  });

  it("handles memories with null or empty pins gracefully", () => {
    const noPins = indexer.memoryStore.insert(
      "decision",
      "decision with no pins",
      null,
      1.0,
      "abc1230",
      null,
      null,
      "project"
    );
    expect(noPins).toBeGreaterThan(0);

    insertWithPins("decision", "decision with empty pins", [], "abc1231");
    insertWithPins(
      "decision",
      "another decision pinned to a file",
      ["src/file.ts"],
      "abc1232"
    );

    // Should not crash, should not flag the no-pins / empty-pins entries
    expect(() => indexer.memoryStore.findConflicts()).not.toThrow();
    const conflicts = indexer.memoryStore.findConflicts();
    expect(conflicts).toHaveLength(0);
  });
});
