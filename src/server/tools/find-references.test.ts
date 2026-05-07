import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Indexer } from "../../indexer/indexer.js";
import { getProjectConfig } from "../../utils/config.js";
import { handleFindReferences } from "./find-references.js";

// Regression tests for github.com/sverklo/sverklo/issues/14.
//
// sverklo_refs used to substring-match the symbol name, so a query
// for `embed` returned 48 hits that were mostly `embeddingStore`,
// `embeddingBatch`, `EmbeddingStore` class, etc. — dozens of false
// positives drowning the 5 real call sites.
//
// The fix: word-boundary matching by default, substring opt-in via
// `exact: false`.

describe("handleFindReferences — issue #14 regression", () => {
  let tmpRoot: string;
  let indexer: Indexer;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "sverklo-refs-"));
    mkdirSync(join(tmpRoot, "src"), { recursive: true });

    // Seed a codebase that reproduces the original noise pattern:
    // one real identifier `embed` plus several longer identifiers
    // that contain `embed` as a substring. The exact-match mode
    // should return only the real ones.
    writeFileSync(
      join(tmpRoot, "src", "indexer.ts"),
      [
        "export class Indexer {",
        "  public embeddingStore: unknown;",
        "  public embeddingBatch: unknown[] = [];",
        "  async run() {",
        "    const vectors = await embed(['text']);",
        "    this.embeddingStore = vectors;",
        "    this.embeddingBatch.push(...vectors);",
        "    return embed(['another']);",
        "  }",
        "}",
        "declare function embed(texts: string[]): Promise<unknown>;",
      ].join("\n"),
      "utf-8"
    );

    writeFileSync(
      join(tmpRoot, "src", "storage.ts"),
      [
        "export class EmbeddingStore {",
        "  // stores vectors produced by the indexer",
        "  save() {}",
        "}",
      ].join("\n"),
      "utf-8"
    );

    const cfg = getProjectConfig(tmpRoot);
    indexer = new Indexer(cfg);
    await indexer.index();
  });

  afterEach(() => {
    try {
      indexer.close();
    } catch {}
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("default exact mode matches whole identifiers only", async () => {
    const out = await handleFindReferences(indexer, { symbol: "embed" });
    // The two real calls to embed() must appear
    expect(out).toContain("await embed(['text'])");
    expect(out).toContain("embed(['another'])");
    // But `embeddingStore`, `embeddingBatch`, `EmbeddingStore` must NOT
    // be reported as references to `embed`
    expect(out).not.toContain("embeddingStore: unknown");
    expect(out).not.toContain("embeddingBatch.push");
    expect(out).not.toContain("class EmbeddingStore");
  });

  it("exact: false opts into substring behavior for edge cases", async () => {
    const out = await handleFindReferences(indexer, { symbol: "embed", exact: false });
    // In substring mode, the longer names do match
    expect(out).toContain("embeddingStore");
    // And the real calls are still there
    expect(out).toContain("embed(['text'])");
  });

  it("rejects missing symbol with a clear error", async () => {
    const out = await handleFindReferences(indexer, {});
    expect(out).toContain("Error");
    expect(out).toContain("symbol");
  });

  it("does not match inside longer identifiers that share a prefix", async () => {
    // `Embedding` has `embed` as a prefix but should not match
    // in exact mode.
    const out = await handleFindReferences(indexer, { symbol: "embed" });
    expect(out).not.toContain("EmbeddingStore");
  });

  it("matches exact identifier even when it contains regex metachars", async () => {
    // Names with dots / dollar signs / brackets must not break the
    // regex builder.
    const out = await handleFindReferences(indexer, { symbol: "$invalid" });
    // Should return "No references" for a non-existent symbol, not
    // throw on regex construction.
    expect(out).toContain("No references found");
  });
});

// Regression test for github.com/sverklo/sverklo/issues/28.
//
// When v0.20.2's brace-counter fix landed, the parser started emitting
// ~2× more chunks per large JS file. find-references' FTS candidate
// budget (then 50) was small enough that a single file with the symbol
// scattered across many chunks could saturate the candidate set,
// evicting references in other files. P2 on lodash dropped F1 ~0.50
// → ~0.20. Fix: bump FTS budget to 500 + cap chunks-per-file at 8.
// This test asserts file diversity is preserved when one file has
// many high-rank chunks containing the target symbol.
describe("handleFindReferences — issue #28 file diversity", () => {
  let tmpRoot: string;
  let indexer: Indexer;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "sverklo-refs-diversity-"));
    mkdirSync(join(tmpRoot, "src"), { recursive: true });

    // Simulate the lodash shape: one "big" file with the symbol
    // appearing in many small chunks plus several "small" files
    // with one call site each. Pre-fix: big.ts saturates the
    // candidate budget, small files vanish from the output.
    const bigChunks: string[] = [];
    for (let i = 0; i < 12; i++) {
      bigChunks.push(`export function fn${i}(x: unknown) {`);
      bigChunks.push(`  return target(x);`);
      bigChunks.push(`}`);
      bigChunks.push("");
    }
    writeFileSync(join(tmpRoot, "src", "big.ts"), bigChunks.join("\n"), "utf-8");
    writeFileSync(
      join(tmpRoot, "src", "small1.ts"),
      ["export function caller1() {", "  return target('one');", "}", ""].join("\n"),
      "utf-8"
    );
    writeFileSync(
      join(tmpRoot, "src", "small2.ts"),
      ["export function caller2() {", "  return target('two');", "}", ""].join("\n"),
      "utf-8"
    );
    writeFileSync(
      join(tmpRoot, "src", "small3.ts"),
      ["export function caller3() {", "  return target('three');", "}", ""].join("\n"),
      "utf-8"
    );
    writeFileSync(
      join(tmpRoot, "src", "target.ts"),
      ["export function target(x: unknown): unknown { return x; }", ""].join("\n"),
      "utf-8"
    );

    const config = getProjectConfig(tmpRoot);
    indexer = new Indexer(config);
    await indexer.index();
  });

  afterEach(() => {
    indexer.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("surfaces references from all files, not just the one with the most chunks", async () => {
    const out = await handleFindReferences(indexer, { symbol: "target" });
    // Pre-fix: only big.ts would appear (it dominated FTS candidates).
    // Post-fix: small1/small2/small3 also surface.
    expect(out).toContain("small1.ts");
    expect(out).toContain("small2.ts");
    expect(out).toContain("small3.ts");
    expect(out).toContain("big.ts");
  });
});
