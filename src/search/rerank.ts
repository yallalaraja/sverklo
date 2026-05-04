/**
 * ColBERT/PLAID-style late-interaction reranker (issue #29).
 *
 * Phase 1 of the multi-vector evaluation. Wires a NEW optional post-step
 * on top of existing top-50 retrieval — does NOT change the index, does
 * NOT change indexing cost, does NOT change the on-disk schema. Just
 * reorders the top-K results using late-interaction scoring.
 *
 * Architecture:
 *
 *     query → hybrid retrieval (BM25 + dense + PageRank, RRF-fused)
 *           → top-50 candidates
 *           → [optional] late-interaction rerank
 *           → top-10 final
 *
 * Gated behind SVERKLO_RERANK env var. Off by default. Once we have
 * bench numbers proving lift, we'll either ship it as the default
 * behavior or close issue #29 with a "doesn't pay" writeup.
 *
 * Late-interaction scoring (MaxSim):
 *
 *   score(query, doc) = sum_i max_j (q_i · d_j)
 *
 * where q_i are query token vectors and d_j are doc token vectors.
 * The aggregation is "for each query token, find its best-matching
 * doc token and sum those maxima." Preserves token-level alignment
 * that single-vector mean-pooled embeddings destroy.
 *
 * Three implementation options, in order of effort:
 *
 *   1. **Poor-man's late interaction (quick spike).** Use the current
 *      all-MiniLM-L6-v2 model in token-vector mode (skip mean pooling,
 *      keep all 50-200 token outputs per chunk). Cheaper to integrate;
 *      lower-quality than a real ColBERT model but proves the wiring
 *      and lets us see if ANY late interaction helps.
 *
 *   2. **ColBERT v2 ONNX (real Phase 1).** Convert colbert-ir/colbertv2.0
 *      to ONNX, register CoreML execution provider for ANE acceleration
 *      on M-series Macs. Real benchmark target.
 *
 *   3. **Code-tuned ColBERT.** If a code-domain ColBERT model exists
 *      (lightonai/colbert-code or similar), prefer it. Otherwise stick
 *      with general ColBERT v2 and accept some out-of-domain noise.
 *
 * The poor-man's path is fastest to ship and gives a fast feasibility
 * answer. If poor-man's late interaction lifts P1 at all, real ColBERT
 * will lift it more.
 */

import type { SearchResult } from "../types/index.js";

export interface RerankerConfig {
  /** Which late-interaction backend. */
  mode: "off" | "poor-man" | "colbert-v2" | "colbert-code";
  /** Top-K to keep after rerank. */
  topK: number;
  /** Top-N from initial retrieval to feed into rerank. */
  candidatePool: number;
}

export const DEFAULT_RERANKER_CONFIG: RerankerConfig = {
  mode: "off",
  topK: 10,
  candidatePool: 50,
};

/**
 * Read reranker config from env. Off by default; opt in via
 * `SVERKLO_RERANK=poor-man` (or other supported modes). Designed so
 * the bench runner can A/B test by setting the env var per-baseline.
 */
export function rerankerConfigFromEnv(): RerankerConfig {
  const raw = process.env.SVERKLO_RERANK;
  if (!raw || raw === "0" || raw === "off") return DEFAULT_RERANKER_CONFIG;
  const mode = raw as RerankerConfig["mode"];
  return {
    ...DEFAULT_RERANKER_CONFIG,
    mode: mode === "poor-man" || mode === "colbert-v2" || mode === "colbert-code"
      ? mode
      : "off",
  };
}

/**
 * Late-interaction rerank entry point. STUB — issue #29 Phase 1 will
 * implement the three modes. Currently returns the input unchanged
 * when mode === "off" so the call site can be wired now and the
 * implementation can land in a follow-up branch without touching
 * hybrid-search.ts again.
 *
 * Contract:
 *   - Input: top-N results from hybrid retrieval (typically N=50).
 *   - Output: re-ordered top-K (typically K=10), scores reflect
 *     late-interaction MaxSim sum (NOT directly comparable to
 *     hybrid-search RRF scores — gated downstream by score type tag
 *     to avoid mixing).
 *   - Latency target: ≤50ms/query overhead on M-series with ANE.
 *   - Latency budget: ≤200ms on CPU-only fallback. If we exceed
 *     this, the rerank should bypass with a logged warning rather
 *     than block.
 */
export async function rerank(
  query: string,
  candidates: SearchResult[],
  config: RerankerConfig = DEFAULT_RERANKER_CONFIG,
): Promise<SearchResult[]> {
  if (config.mode === "off" || candidates.length === 0) {
    return candidates.slice(0, config.topK);
  }

  // TODO(#29): implement modes
  //   - "poor-man": all-MiniLM-L6-v2 token-vector mode + MaxSim
  //   - "colbert-v2": colbert-ir/colbertv2.0 via ONNX + CoreML EP
  //   - "colbert-code": code-tuned ColBERT if available
  //
  // Until implemented, log a warning and pass through unchanged so
  // the bench can be run in "wired but inert" mode to validate the
  // call-site integration without the model.
  console.warn(
    `[sverklo] rerank mode "${config.mode}" not yet implemented (#29). Passing through unchanged.`,
  );
  return candidates.slice(0, config.topK);
}

/**
 * Late-interaction MaxSim score. Will be the inner loop of the real
 * rerank() implementation once token vectors are available.
 *
 *   score = sum over query tokens i of (max over doc tokens j of (q_i · d_j))
 *
 * Both inputs are L2-normalized 2D float arrays of shape [num_tokens, dim].
 * Returns the scalar score; higher is better.
 */
export function maxSimScore(
  queryTokens: Float32Array[],
  docTokens: Float32Array[],
): number {
  if (queryTokens.length === 0 || docTokens.length === 0) return 0;
  let total = 0;
  for (const q of queryTokens) {
    let best = -Infinity;
    for (const d of docTokens) {
      let dot = 0;
      const len = Math.min(q.length, d.length);
      for (let i = 0; i < len; i++) dot += q[i] * d[i];
      if (dot > best) best = dot;
    }
    if (best !== -Infinity) total += best;
  }
  return total;
}
