/**
 * Tests for the late-interaction rerank stub (issue #29).
 *
 * The actual model integration is in a follow-up branch. These tests
 * lock in the wiring contract: when SVERKLO_RERANK is off, rerank is
 * a strict pass-through; when on but the mode is unimplemented, it
 * passes through with a console warning rather than throwing. This
 * prevents accidentally breaking production retrieval behind the
 * env flag.
 */

import { describe, it, expect, vi } from "vitest";
import {
  rerank,
  rerankerConfigFromEnv,
  maxSimScore,
  DEFAULT_RERANKER_CONFIG,
} from "./rerank.ts";
import type { SearchResult } from "../types/index.ts";

function mkResult(id: number, name: string, score: number): SearchResult {
  return {
    chunk: {
      id,
      file_id: 1,
      type: "function",
      name,
      body: `function ${name}() { return ${id}; }`,
      startLine: 1,
      endLine: 3,
    } as SearchResult["chunk"],
    file: {
      id: 1,
      path: "src/test.ts",
      language: "typescript",
      pagerank: 0.5,
    } as SearchResult["file"],
    score,
  };
}

describe("rerank", () => {
  it("passes candidates through unchanged when mode is off", async () => {
    const candidates = [
      mkResult(1, "alpha", 0.9),
      mkResult(2, "beta", 0.8),
      mkResult(3, "gamma", 0.7),
    ];
    const result = await rerank("query", candidates, {
      ...DEFAULT_RERANKER_CONFIG,
      mode: "off",
    });
    expect(result).toEqual(candidates.slice(0, 10));
  });

  it("respects topK when mode is off", async () => {
    const candidates = Array.from({ length: 50 }, (_, i) =>
      mkResult(i, `sym${i}`, 1 - i * 0.01),
    );
    const result = await rerank("query", candidates, {
      ...DEFAULT_RERANKER_CONFIG,
      mode: "off",
      topK: 5,
    });
    expect(result).toHaveLength(5);
    expect(result[0].chunk.name).toBe("sym0");
  });

  it("returns empty for empty candidates regardless of mode", async () => {
    const result = await rerank("query", [], {
      ...DEFAULT_RERANKER_CONFIG,
      mode: "poor-man",
    });
    expect(result).toEqual([]);
  });

  it("falls back to pass-through (with warning) when mode is unimplemented", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const candidates = [mkResult(1, "alpha", 0.9), mkResult(2, "beta", 0.8)];
    const result = await rerank("query", candidates, {
      ...DEFAULT_RERANKER_CONFIG,
      mode: "colbert-v2",
    });
    expect(result).toEqual(candidates.slice(0, 10));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('rerank mode "colbert-v2" not yet implemented'),
    );
    warnSpy.mockRestore();
  });
});

describe("rerankerConfigFromEnv", () => {
  it("returns off when env var unset", () => {
    const orig = process.env.SVERKLO_RERANK;
    delete process.env.SVERKLO_RERANK;
    try {
      const cfg = rerankerConfigFromEnv();
      expect(cfg.mode).toBe("off");
    } finally {
      if (orig !== undefined) process.env.SVERKLO_RERANK = orig;
    }
  });

  it("returns off when env var is '0' or 'off'", () => {
    const orig = process.env.SVERKLO_RERANK;
    process.env.SVERKLO_RERANK = "off";
    try {
      expect(rerankerConfigFromEnv().mode).toBe("off");
      process.env.SVERKLO_RERANK = "0";
      expect(rerankerConfigFromEnv().mode).toBe("off");
    } finally {
      if (orig === undefined) delete process.env.SVERKLO_RERANK;
      else process.env.SVERKLO_RERANK = orig;
    }
  });

  it("parses known modes", () => {
    const orig = process.env.SVERKLO_RERANK;
    try {
      for (const mode of ["poor-man", "colbert-v2", "colbert-code"] as const) {
        process.env.SVERKLO_RERANK = mode;
        expect(rerankerConfigFromEnv().mode).toBe(mode);
      }
    } finally {
      if (orig === undefined) delete process.env.SVERKLO_RERANK;
      else process.env.SVERKLO_RERANK = orig;
    }
  });

  it("falls back to off for unknown mode strings", () => {
    const orig = process.env.SVERKLO_RERANK;
    process.env.SVERKLO_RERANK = "splinegoose";
    try {
      expect(rerankerConfigFromEnv().mode).toBe("off");
    } finally {
      if (orig === undefined) delete process.env.SVERKLO_RERANK;
      else process.env.SVERKLO_RERANK = orig;
    }
  });
});

describe("maxSimScore", () => {
  it("returns 0 for empty inputs", () => {
    expect(maxSimScore([], [])).toBe(0);
    expect(maxSimScore([new Float32Array([1, 0])], [])).toBe(0);
    expect(maxSimScore([], [new Float32Array([1, 0])])).toBe(0);
  });

  it("computes sum of per-query-token max dot products", () => {
    // Two query tokens, three doc tokens
    const q = [new Float32Array([1, 0]), new Float32Array([0, 1])];
    const d = [
      new Float32Array([0.9, 0.1]), // best for q[0]
      new Float32Array([0.1, 0.9]), // best for q[1]
      new Float32Array([0.5, 0.5]),
    ];
    // q[0] · d[0] = 0.9, q[1] · d[1] = 0.9 → total 1.8
    expect(maxSimScore(q, d)).toBeCloseTo(1.8, 5);
  });

  it("rewards alignment between query and doc tokens", () => {
    const q = [new Float32Array([1, 0]), new Float32Array([0, 1])];
    const aligned = [new Float32Array([1, 0]), new Float32Array([0, 1])];
    const misaligned = [
      new Float32Array([0.5, 0.5]),
      new Float32Array([0.5, -0.5]),
    ];
    expect(maxSimScore(q, aligned)).toBeGreaterThan(maxSimScore(q, misaligned));
  });
});
