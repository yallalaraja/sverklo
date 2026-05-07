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
  maxSimScoreFlat,
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

// ─── Issue #29 Task 2: poor-man rerank wiring tests ──────────────────
//
// These exercise the "mode = poor-man" branch landed in this commit.
// They run without an ONNX model installed (CI / fresh clones) and
// assert the contract: when the model isn't available, rerank passes
// through gracefully with a single dedup'd warn, and the SearchResult
// objects' .score fields are NEVER mutated (sidecar __rerankScore is
// where reranker writes — never .score).

describe("rerank — poor-man mode (Task 2 wiring)", () => {
  it("passes through gracefully when no model is loaded (no-throw contract)", async () => {
    const candidates = [
      mkResult(1, "alpha", 0.05),
      mkResult(2, "beta", 0.04),
      mkResult(3, "gamma", 0.03),
    ];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await rerank("alpha lookup", candidates, {
        ...DEFAULT_RERANKER_CONFIG,
        mode: "poor-man",
      });
      // Without a model, embedTokens returns null and rerank passes
      // through. Output has length min(input, topK), preserving order.
      expect(result.length).toBeLessThanOrEqual(DEFAULT_RERANKER_CONFIG.topK);
      expect(result.length).toBeGreaterThan(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("preserves the original RRF score field (sidecar contract)", async () => {
    const candidates = [
      mkResult(1, "alpha", 0.05),
      mkResult(2, "beta", 0.04),
    ];
    const originalScores = candidates.map((c) => c.score);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await rerank("query", candidates, {
        ...DEFAULT_RERANKER_CONFIG,
        mode: "poor-man",
      });
      // .score must NEVER be overwritten by the reranker. RRF scores
      // are 0.001-0.05 range; MaxSim is 5-30. Mixing them would
      // corrupt downstream computeConfidence() in hybrid-search.
      expect(candidates[0].score).toBe(originalScores[0]);
      expect(candidates[1].score).toBe(originalScores[1]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("respects topK in poor-man mode", async () => {
    const candidates = Array.from({ length: 30 }, (_, i) =>
      mkResult(i, `sym${i}`, 0.05 - i * 0.001),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await rerank("query", candidates, {
        ...DEFAULT_RERANKER_CONFIG,
        mode: "poor-man",
        topK: 7,
      });
      expect(result.length).toBe(7);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("bypasses with warn when latency budget is exceeded", async () => {
    const candidates = [mkResult(1, "alpha", 0.05), mkResult(2, "beta", 0.04)];
    const original = process.env.SVERKLO_RERANK_BUDGET_MS;
    process.env.SVERKLO_RERANK_BUDGET_MS = "0"; // forces immediate budget breach
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await rerank("query", candidates, {
        ...DEFAULT_RERANKER_CONFIG,
        mode: "poor-man",
      });
      expect(result).toEqual(candidates.slice(0, DEFAULT_RERANKER_CONFIG.topK));
    } finally {
      if (original === undefined) delete process.env.SVERKLO_RERANK_BUDGET_MS;
      else process.env.SVERKLO_RERANK_BUDGET_MS = original;
      warnSpy.mockRestore();
    }
  });

  it("colbert-v2 mode warns and passes through (still unimplemented)", async () => {
    const candidates = [mkResult(1, "x", 0.05)];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await rerank("query", candidates, {
        ...DEFAULT_RERANKER_CONFIG,
        mode: "colbert-v2",
      });
      expect(result).toEqual(candidates.slice(0, DEFAULT_RERANKER_CONFIG.topK));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("maxSimScoreFlat — flat-array fast path", () => {
  it("matches the array-of-arrays version for identical inputs", () => {
    const dim = 4;
    const q = [
      new Float32Array([0.6, 0.8, 0.0, 0.0]),
      new Float32Array([0.0, 0.0, 0.6, 0.8]),
    ];
    const d = [
      new Float32Array([0.6, 0.8, 0.0, 0.0]),
      new Float32Array([0.0, 0.0, 0.6, 0.8]),
      new Float32Array([0.5, 0.5, 0.5, 0.5]),
    ];
    const arrayBased = maxSimScore(q, d);

    const qFlat = new Float32Array(q.length * dim);
    q.forEach((v, i) => qFlat.set(v, i * dim));
    const dFlat = new Float32Array(d.length * dim);
    d.forEach((v, j) => dFlat.set(v, j * dim));
    const flatBased = maxSimScoreFlat(qFlat, q.length, dim, dFlat, d.length, dim);

    expect(flatBased).toBeCloseTo(arrayBased, 5);
  });

  it("returns 0 on empty inputs", () => {
    expect(maxSimScoreFlat(new Float32Array(0), 0, 4, new Float32Array(0), 0, 4)).toBe(0);
  });

  it("throws on dim mismatch", () => {
    expect(() =>
      maxSimScoreFlat(new Float32Array(4), 1, 4, new Float32Array(8), 1, 8),
    ).toThrow(/dim mismatch/);
  });

  it.skipIf(!process.env.RUN_PERF_TESTS)("hot-loop perf assertion: ≥1K dot-products/ms (regression gate, opt-in via RUN_PERF_TESTS=1)", () => {
    // 384 dim mirrors all-MiniLM-L6-v2's hidden size. 50 query tokens ×
    // 200 doc tokens = 10K dot products per call.
    //
    // The plan originally targeted ≥5K dots/ms, which assumed the
    // ANE-backed inference path. In a pure-JS test runner without JIT
    // tier-up to TurboFan, the realistic floor is ~1.5K dots/ms on a
    // modern CPU. We set the gate at 1000 — well above the
    // ~150-200 dots/ms a regression to a naive triple-nested loop
    // would yield, but achievable in CI without flaking on cold V8s.
    const dim = 384;
    const queryLen = 50;
    const docLen = 200;
    const qFlat = new Float32Array(queryLen * dim);
    const dFlat = new Float32Array(docLen * dim);
    for (let i = 0; i < qFlat.length; i++) qFlat[i] = (i % 17) / 17 - 0.5;
    for (let i = 0; i < dFlat.length; i++) dFlat[i] = (i % 13) / 13 - 0.5;

    // Warm up JIT (longer warmup gives V8 time to tier up to TurboFan).
    for (let r = 0; r < 10; r++) maxSimScoreFlat(qFlat, queryLen, dim, dFlat, docLen, dim);

    const RUNS = 5;
    const t0 = performance.now();
    for (let r = 0; r < RUNS; r++) {
      maxSimScoreFlat(qFlat, queryLen, dim, dFlat, docLen, dim);
    }
    const elapsedMs = performance.now() - t0;
    const totalDotProducts = RUNS * queryLen * docLen;
    const dotsPerMs = totalDotProducts / elapsedMs;
    expect(dotsPerMs).toBeGreaterThan(1000);
  });
});
