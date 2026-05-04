/**
 * Tests for embedTokens() — the per-token embedding path used by the
 * late-interaction reranker (#29).
 *
 * Two layers:
 *
 * 1. **Always-on contract tests.** Run without an ONNX model installed.
 *    Lock the "no session → all nulls, no throw" behavior so production
 *    retrieval can never break behind a missing model.
 *
 * 2. **Skip-if-no-model integration tests.** Run only when
 *    ~/.sverklo/models/{model.onnx,tokenizer.json} exists. Verify the
 *    real shape contract (len, dim, L2-norm) on a live ONNX session.
 *    Skipped automatically on CI / fresh clones where the model isn't
 *    downloaded.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { embedTokens, embed, EMBEDDING_DIM, initEmbedder } from "./embedder.ts";
import type { TokenEmbedding } from "./embedder.ts";

const MODEL_DIR = join(homedir(), ".sverklo", "models");
const HAS_MODEL =
  existsSync(join(MODEL_DIR, "model.onnx")) &&
  existsSync(join(MODEL_DIR, "tokenizer.json"));

describe("embedTokens — contract (no model required)", () => {
  it("exports the expected dim constant", () => {
    expect(EMBEDDING_DIM).toBe(384);
  });

  it("returns one slot per input text", async () => {
    // Whether or not the model loaded, the output shape matches input length.
    const out = await embedTokens(["alpha", "beta", "gamma"]);
    expect(out).toHaveLength(3);
  });

  it("never throws on empty input", async () => {
    const out = await embedTokens([]);
    expect(out).toEqual([]);
  });
});

describe.runIf(HAS_MODEL)("embedTokens — with ONNX model installed", () => {
  beforeAll(async () => {
    await initEmbedder();
  });

  it("returns L2-normalized token vectors with correct shape", async () => {
    const out = await embedTokens(["hello world"]);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toBeNull();
    const r = out[0] as TokenEmbedding;

    // hello world tokenizes to ~2 wordpiece tokens (hello, world). After
    // CLS/SEP stripping, expect 2-3 real tokens. Looser bound to tolerate
    // tokenizer variations across MiniLM exports.
    expect(r.len).toBeGreaterThanOrEqual(1);
    expect(r.len).toBeLessThanOrEqual(5);
    expect(r.dim).toBe(EMBEDDING_DIM);
    expect(r.tokens).toBeInstanceOf(Float32Array);
    expect(r.tokens.length).toBe(r.len * r.dim);

    // Each token vector L2-normalized.
    for (let t = 0; t < r.len; t++) {
      let norm = 0;
      for (let d = 0; d < r.dim; d++) {
        const v = r.tokens[t * r.dim + d];
        norm += v * v;
      }
      norm = Math.sqrt(norm);
      // Allow small slack — float32 accumulation drift across 384 dims.
      expect(norm).toBeGreaterThan(0.99);
      expect(norm).toBeLessThan(1.01);
    }
  });

  it("handles batches of multiple texts", async () => {
    const out = await embedTokens([
      "the quick brown fox",
      "function map(arr, fn) { return arr.map(fn); }",
      "x",
    ]);
    expect(out).toHaveLength(3);
    for (const r of out) {
      expect(r).not.toBeNull();
      const e = r as TokenEmbedding;
      expect(e.dim).toBe(EMBEDDING_DIM);
      expect(e.tokens.length).toBe(e.len * e.dim);
    }
  });

  it("returns zero-length tokens for empty string (degenerate but safe)", async () => {
    const out = await embedTokens([""]);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toBeNull();
    const r = out[0] as TokenEmbedding;
    expect(r.len).toBe(0);
    expect(r.tokens.length).toBe(0);
    expect(r.dim).toBe(EMBEDDING_DIM);
  });

  it("does not mutate the embed() pooled output for the same text", async () => {
    // Sanity that the refactor (#29 prep commit) didn't drift embed()
    // when embedTokens runs against the same session. Run interleaved.
    const text = "function add(a, b) { return a + b; }";
    const before = await embed([text]);
    const tokens = await embedTokens([text]);
    const after = await embed([text]);
    expect(before[0]).toBeInstanceOf(Float32Array);
    expect(after[0]).toBeInstanceOf(Float32Array);
    // bitwise equality — embed() is deterministic for the same input
    expect(Array.from(after[0])).toEqual(Array.from(before[0]));
    expect(tokens[0]).not.toBeNull();
  });
});
