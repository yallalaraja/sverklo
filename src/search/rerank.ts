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
/**
 * Per-process dedup for warning messages so the bench doesn't get
 * spammed by 90 identical warns. Tracks "have we logged this exact
 * message" — one log per kind per session.
 */
const warnedKinds = new Set<string>();
function warnOnce(kind: string, message: string): void {
  if (warnedKinds.has(kind)) return;
  warnedKinds.add(kind);
  console.warn(message);
}

/**
 * Truncate doc text before tokenization. ColBERT-style models cap at
 * ~128 BERT tokens after tokenization; we apply a generous char budget
 * upstream so the tokenizer doesn't spend cycles on text we'll discard.
 * 600 chars ≈ 100-130 BERT tokens for typical English/code mix.
 */
const DOC_CHAR_BUDGET = 600;
function buildDocText(chunk: { name: string | null; content: string }): string {
  // `name` first so a name match anchors at least one query token. Then
  // the chunk content, truncated. We don't strip whitespace — the model
  // tokenizes whitespace consistently and removing it changes the
  // alignment vs untruncated text.
  const head = (chunk.name ?? "").slice(0, 64);
  const body = chunk.content.slice(0, DOC_CHAR_BUDGET);
  return head ? `${head}\n${body}` : body;
}

export async function rerank(
  query: string,
  candidates: SearchResult[],
  config: RerankerConfig = DEFAULT_RERANKER_CONFIG,
): Promise<SearchResult[]> {
  if (config.mode === "off" || candidates.length === 0) {
    return candidates.slice(0, config.topK);
  }

  // Modes other than "poor-man" are not yet implemented (issue #29
  // Tasks 4-7). Pass through unchanged with a single dedup'd warn.
  if (config.mode !== "poor-man") {
    warnOnce(
      `rerank-mode-${config.mode}`,
      `[sverklo] rerank mode "${config.mode}" not yet implemented (#29). Passing through unchanged.`,
    );
    return candidates.slice(0, config.topK);
  }

  // Poor-man's late interaction: token-vector mode of all-MiniLM-L6-v2
  // (no new model artifact) + MaxSim. Per the plan in #29, this exists
  // to answer "does any late interaction help on the bench at all?"
  // before the colbert-v2 ONNX work is justified.
  const start = Date.now();
  const budgetMs = parseInt(process.env.SVERKLO_RERANK_BUDGET_MS || "", 10) || 500;

  // Lazy import — keeps the cost zero when rerank is off, and avoids
  // a circular dependency through the embedder's transitive imports.
  let embedTokens: typeof import("../indexer/embedder.js").embedTokens;
  try {
    ({ embedTokens } = await import("../indexer/embedder.js"));
  } catch (e) {
    warnOnce(
      "rerank-embedder-import",
      `[sverklo] rerank: failed to load embedder; passing through. ${(e as Error)?.message || ""}`,
    );
    return candidates.slice(0, config.topK);
  }

  // Trim the candidate pool to config.candidatePool BEFORE tokenization
  // so we don't waste ORT cycles on candidates we'll throw away.
  const pool = candidates.slice(0, config.candidatePool);

  // Embed query first. If the session is unavailable (no model, etc.)
  // embedTokens returns null per text — pass through.
  let queryEmb: Awaited<ReturnType<typeof embedTokens>>[number];
  try {
    const out = await embedTokens([query]);
    queryEmb = out[0];
  } catch (e) {
    warnOnce(
      "rerank-query-embed",
      `[sverklo] rerank: query embed threw; passing through. ${(e as Error)?.message || ""}`,
    );
    return candidates.slice(0, config.topK);
  }
  if (!queryEmb || queryEmb.len === 0) {
    // Either no model installed or degenerate input. Pass through with
    // one warn (covers "user has no ONNX model on disk" case).
    warnOnce(
      "rerank-no-model",
      `[sverklo] rerank: no model loaded or empty query; passing through.`,
    );
    return candidates.slice(0, config.topK);
  }

  // Hard latency guard mid-stream: if the query embed alone took
  // most of the budget, skip the doc batch and pass through.
  if (Date.now() - start > budgetMs) {
    warnOnce(
      "rerank-budget-query",
      `[sverklo] rerank: query embed exceeded ${budgetMs}ms budget; passing through.`,
    );
    return candidates.slice(0, config.topK);
  }

  // Embed all docs in one batch call. embedTokens handles internal
  // batching at 16/batch. 50 candidates ≈ 3-4 ORT calls.
  let docEmbs: Awaited<ReturnType<typeof embedTokens>>;
  try {
    const docTexts = pool.map((r) => buildDocText(r.chunk));
    docEmbs = await embedTokens(docTexts);
  } catch (e) {
    warnOnce(
      "rerank-doc-embed",
      `[sverklo] rerank: doc embed threw; passing through. ${(e as Error)?.message || ""}`,
    );
    return candidates.slice(0, config.topK);
  }

  // If the budget is blown, return what we have unranked. The plan
  // explicitly allows partial-rerank fallback ("partially-reranked
  // head + un-touched tail in original order") but the simpler shape
  // is "all-or-nothing": if we hit the budget at this point, we
  // haven't computed any MaxSim scores yet, so return the original.
  if (Date.now() - start > budgetMs) {
    warnOnce(
      "rerank-budget-doc",
      `[sverklo] rerank: doc embed exceeded ${budgetMs}ms budget; passing through.`,
    );
    return candidates.slice(0, config.topK);
  }

  // Score every candidate. Where the doc embed returned null (rare —
  // degenerate input or mid-batch session loss), assign -Infinity so
  // the candidate falls to the bottom of the rerank order rather than
  // floating to the top with a false zero.
  type ScoredCandidate = { result: SearchResult; rerankScore: number; originalIndex: number };
  const scored: ScoredCandidate[] = [];
  for (let i = 0; i < pool.length; i++) {
    const docEmb = docEmbs[i];
    if (!docEmb || docEmb.len === 0) {
      scored.push({ result: pool[i], rerankScore: Number.NEGATIVE_INFINITY, originalIndex: i });
      continue;
    }
    const score = maxSimScoreFlat(
      queryEmb.tokens,
      queryEmb.len,
      queryEmb.dim,
      docEmb.tokens,
      docEmb.len,
      docEmb.dim,
    );
    scored.push({ result: pool[i], rerankScore: score, originalIndex: i });
  }

  // Stable sort descending by rerank score; ties keep original order
  // (originalIndex breaks ties).
  scored.sort((a, b) => {
    if (b.rerankScore !== a.rerankScore) return b.rerankScore - a.rerankScore;
    return a.originalIndex - b.originalIndex;
  });

  // Attach rerank score as a sidecar. Critical: do NOT mutate
  // result.score — RRF scores are 0.001-0.05 range while MaxSim is
  // typically 5-30, and downstream computeConfidence() in
  // hybrid-search would treat the rerank score as if it were RRF.
  const ranked: SearchResult[] = scored.map((s) => {
    (s.result as unknown as { __rerankScore?: number }).__rerankScore = s.rerankScore;
    return s.result;
  });

  return ranked.slice(0, config.topK);
}

/**
 * Late-interaction MaxSim score over array-of-arrays inputs.
 *
 *   score = sum over query tokens i of (max over doc tokens j of (q_i · d_j))
 *
 * Both inputs are L2-normalized; returns scalar (higher is better).
 *
 * This signature is preserved as a thin adapter over the flat-array
 * fast path (`maxSimScoreFlat`) so existing tests don't have to
 * change. The flat layout is what makes the inner dot-product loop
 * fast — V8 inlines `Float32Array[offset+i] * Float32Array[offset+i]`
 * aggressively while array-of-arrays loses bounds-check elision.
 */
export function maxSimScore(
  queryTokens: Float32Array[],
  docTokens: Float32Array[],
): number {
  if (queryTokens.length === 0 || docTokens.length === 0) return 0;
  // Determine dim from the first non-empty vector. Mixed dims would
  // be a bug upstream; we don't try to be clever about it.
  let dim = 0;
  for (const q of queryTokens) if (q.length > 0) { dim = q.length; break; }
  if (dim === 0) {
    for (const d of docTokens) if (d.length > 0) { dim = d.length; break; }
  }
  if (dim === 0) return 0;

  // Pack into flat arrays.
  const qFlat = new Float32Array(queryTokens.length * dim);
  for (let i = 0; i < queryTokens.length; i++) {
    const q = queryTokens[i];
    const copyLen = Math.min(dim, q.length);
    qFlat.set(q.subarray(0, copyLen), i * dim);
  }
  const dFlat = new Float32Array(docTokens.length * dim);
  for (let j = 0; j < docTokens.length; j++) {
    const d = docTokens[j];
    const copyLen = Math.min(dim, d.length);
    dFlat.set(d.subarray(0, copyLen), j * dim);
  }
  return maxSimScoreFlat(qFlat, queryTokens.length, dim, dFlat, docTokens.length, dim);
}

/**
 * Flat-array MaxSim, used directly by rerank() and adapted from above
 * for the array-of-arrays path. Manual 4-wide unrolling on the inner
 * dot-product is the single biggest perf lever (V8 elides bounds
 * checks inside straight-line typed-array indexing).
 *
 * Both query and doc tokens must use the same `dim`. The two `dim`
 * parameters exist so a future heterogeneous-model path doesn't have
 * to change this signature, but we throw on mismatch today.
 */
export function maxSimScoreFlat(
  queryFlat: Float32Array,
  queryLen: number,
  queryDim: number,
  docFlat: Float32Array,
  docLen: number,
  docDim: number,
): number {
  if (queryLen === 0 || docLen === 0) return 0;
  if (queryDim !== docDim) {
    throw new Error(
      `maxSimScoreFlat: dim mismatch (query=${queryDim}, doc=${docDim}). Heterogeneous-dim rerank not supported.`,
    );
  }
  const dim = queryDim;
  let total = 0;
  for (let i = 0; i < queryLen; i++) {
    const qOff = i * dim;
    let best = -Infinity;
    for (let j = 0; j < docLen; j++) {
      const dOff = j * dim;
      // Manual 4-wide unrolling of the dot-product. Trades a tiny
      // tail loop for V8's ability to keep the hot loop in registers.
      let dot = 0;
      const limit = dim - (dim & 3);
      let k = 0;
      for (; k < limit; k += 4) {
        dot += queryFlat[qOff + k] * docFlat[dOff + k]
             + queryFlat[qOff + k + 1] * docFlat[dOff + k + 1]
             + queryFlat[qOff + k + 2] * docFlat[dOff + k + 2]
             + queryFlat[qOff + k + 3] * docFlat[dOff + k + 3];
      }
      for (; k < dim; k++) {
        dot += queryFlat[qOff + k] * docFlat[dOff + k];
      }
      if (dot > best) best = dot;
    }
    if (best !== -Infinity) total += best;
  }
  return total;
}
