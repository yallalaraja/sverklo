// PageRank implementation for file importance ranking.
// Aider's key innovation: apply PageRank to the dependency graph
// so that structurally important files (many importers) rank higher.
//
// Performance: this is a hot path on cold-start (runs once per index())
// and on every reindexFile (file watcher). At 4000-file scale, the
// arithmetic is fast but the data-layout was Map<Set> — each iteration
// did O(edges) Map.get + Set.iteration, and the pointer-chasing
// dominated over the math.
//
// Architectural review 2026-05-13 (Tier 2.4 / Perf P6) flagged this as
// a structural data-layout fix. We now build a Compressed Sparse Row
// (CSR) representation once: in-edges packed contiguously into an
// Int32Array, indexed by per-node offset arrays. Iteration is
// straight integer indexing into typed arrays — V8 hot-path
// friendly, no object allocation per access.

const DAMPING = 0.85;
const ITERATIONS = 20;
const CONVERGENCE_THRESHOLD = 0.0001;

export function computePageRank(
  fileIds: number[],
  edges: { source: number; target: number }[]
): Map<number, number> {
  const n = fileIds.length;
  if (n === 0) return new Map();

  // Map fileId → dense node index (0..n-1) so we can use typed arrays
  // for everything downstream. Map.get is O(1) but allocates entries;
  // we pay this once for setup, then it's pure integer math.
  const idToIdx = new Map<number, number>();
  for (let i = 0; i < n; i++) idToIdx.set(fileIds[i], i);

  // Build CSR for IN-edges (we need "incomers" of each node during
  // iteration) plus a per-node OUT-degree counter for the divide step.
  const outDegree = new Int32Array(n);
  // First pass: count in-edges per target and out-edges per source so
  // we know the slice sizes.
  const inDegree = new Int32Array(n);
  // Pre-filter edges to those whose endpoints are in our index. Edges
  // pointing to files we don't have (e.g. removed during a partial
  // reindex) can't contribute.
  const validEdges: { srcIdx: number; tgtIdx: number }[] = [];
  for (const e of edges) {
    const srcIdx = idToIdx.get(e.source);
    const tgtIdx = idToIdx.get(e.target);
    if (srcIdx === undefined || tgtIdx === undefined) continue;
    validEdges.push({ srcIdx, tgtIdx });
    outDegree[srcIdx]++;
    inDegree[tgtIdx]++;
  }

  // CSR offsets: inOffsets[i] = start index in inEdges array for
  // node i's incomers. Last entry is total length (so slice from
  // [inOffsets[i], inOffsets[i+1]) gives node i's incomers).
  const inOffsets = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) inOffsets[i + 1] = inOffsets[i] + inDegree[i];

  // Pack in-edges contiguously: inEdges[k] = source node index of the
  // k-th incomer (across all nodes, ordered by target).
  const inEdges = new Int32Array(validEdges.length);
  // Use a copy of inOffsets as a write cursor since we'll consume each
  // slot in order.
  const cursor = new Int32Array(n);
  for (let i = 0; i < n; i++) cursor[i] = inOffsets[i];
  for (const { srcIdx, tgtIdx } of validEdges) {
    inEdges[cursor[tgtIdx]++] = srcIdx;
  }

  // Two rank arrays we swap each iteration. Float64Array because IEEE-754
  // arithmetic on millions of edges is cheaper on the typed-array path
  // than boxed Number objects in Map values.
  let ranks = new Float64Array(n);
  let newRanks = new Float64Array(n);
  const initialRank = 1 / n;
  for (let i = 0; i < n; i++) ranks[i] = initialRank;

  const teleport = (1 - DAMPING) / n;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    let maxDelta = 0;

    for (let i = 0; i < n; i++) {
      let incomingRank = 0;
      const start = inOffsets[i];
      const end = inOffsets[i + 1];
      for (let k = start; k < end; k++) {
        const srcIdx = inEdges[k];
        const deg = outDegree[srcIdx] || 1;
        incomingRank += ranks[srcIdx] / deg;
      }

      const r = teleport + DAMPING * incomingRank;
      newRanks[i] = r;

      const delta = r > ranks[i] ? r - ranks[i] : ranks[i] - r;
      if (delta > maxDelta) maxDelta = delta;
    }

    // Swap. Reuse the old `ranks` buffer as the next iteration's
    // scratch — no allocation per iteration.
    const tmp = ranks;
    ranks = newRanks;
    newRanks = tmp;

    if (maxDelta < CONVERGENCE_THRESHOLD) break;
  }

  // Normalize to 0-1 range
  let maxRank = 0;
  for (let i = 0; i < n; i++) {
    if (ranks[i] > maxRank) maxRank = ranks[i];
  }

  const result = new Map<number, number>();
  if (maxRank > 0) {
    for (let i = 0; i < n; i++) result.set(fileIds[i], ranks[i] / maxRank);
  } else {
    for (let i = 0; i < n; i++) result.set(fileIds[i], ranks[i]);
  }
  return result;
}
