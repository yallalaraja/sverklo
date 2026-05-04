/**
 * Sverklo + ColBERT-style rerank baseline (issue #29).
 *
 * Subclass of SverkloBaseline that flips on the optional late-interaction
 * rerank step. Used for A/B testing: register both `sverklo` and
 * `sverklo-rerank` baselines in the same bench run, compare F1 deltas.
 *
 * The rerank step itself is implemented in src/search/rerank.ts and is
 * a no-op until the model integration lands. This baseline exists now
 * so the bench infrastructure is wired and the A/B comparison can fire
 * automatically the moment the rerank implementation drops in.
 *
 * Mode is selected via constructor (default: "poor-man" since that's
 * the cheapest to wire). Different modes can be A/B'd by registering
 * multiple instances with different names.
 */

import { SverkloBaseline } from "./sverklo.ts";

type RerankMode = "poor-man" | "colbert-v2" | "colbert-code";

export class SverkloRerankBaseline extends SverkloBaseline {
  name = "sverklo-rerank";

  constructor(mode: RerankMode = "poor-man") {
    super();
    this.rerankMode = mode;
    // Append mode tag so multiple rerank baselines can coexist in one run.
    if (mode !== "poor-man") this.name = `sverklo-rerank-${mode}`;
  }
}
