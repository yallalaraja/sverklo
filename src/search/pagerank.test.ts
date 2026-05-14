import { describe, it, expect } from "vitest";
import { computePageRank } from "./pagerank.js";

describe("computePageRank (CSR implementation)", () => {
  it("returns empty map for no files", () => {
    const out = computePageRank([], []);
    expect(out.size).toBe(0);
  });

  it("assigns equal rank to isolated nodes (no edges)", () => {
    const out = computePageRank([1, 2, 3], []);
    expect(out.size).toBe(3);
    // All three should have the same rank (normalized to 1.0 after div by max)
    expect(out.get(1)).toBeCloseTo(1.0);
    expect(out.get(2)).toBeCloseTo(1.0);
    expect(out.get(3)).toBeCloseTo(1.0);
  });

  it("ranks a heavy importer highest in a star graph", () => {
    // 2,3,4,5 all import 1; 1 imports nothing
    const edges = [
      { source: 2, target: 1 },
      { source: 3, target: 1 },
      { source: 4, target: 1 },
      { source: 5, target: 1 },
    ];
    const out = computePageRank([1, 2, 3, 4, 5], edges);
    const r1 = out.get(1)!;
    expect(r1).toBeGreaterThan(out.get(2)!);
    expect(r1).toBeGreaterThan(out.get(3)!);
    expect(r1).toBeGreaterThan(out.get(4)!);
    expect(r1).toBeGreaterThan(out.get(5)!);
    expect(r1).toBeCloseTo(1.0); // normalized to max
  });

  it("ignores edges whose endpoints aren't in the fileIds set", () => {
    // Edge from 99 (unknown) → 1 should be skipped, not throw
    const edges = [
      { source: 99, target: 1 },
      { source: 2, target: 1 },
    ];
    const out = computePageRank([1, 2], edges);
    expect(out.size).toBe(2);
    expect(out.get(1)!).toBeGreaterThan(out.get(2)!);
  });

  it("handles a triangle (each imports the next)", () => {
    const edges = [
      { source: 1, target: 2 },
      { source: 2, target: 3 },
      { source: 3, target: 1 },
    ];
    const out = computePageRank([1, 2, 3], edges);
    // All three are symmetric — equal rank, all normalized to 1.0
    expect(out.get(1)!).toBeCloseTo(1.0);
    expect(out.get(2)!).toBeCloseTo(1.0);
    expect(out.get(3)!).toBeCloseTo(1.0);
  });

  it("scales: 200 nodes converges without throwing", () => {
    const fileIds = Array.from({ length: 200 }, (_, i) => i + 1);
    const edges: { source: number; target: number }[] = [];
    // Random-ish chain: each file imports the next, plus every 5th
    // imports node 1 (heavy hub).
    for (let i = 1; i < 200; i++) edges.push({ source: i, target: i + 1 });
    for (let i = 5; i <= 200; i += 5) edges.push({ source: i, target: 1 });
    const out = computePageRank(fileIds, edges);
    expect(out.size).toBe(200);
    // Node 1 has 40 incomers from the hub pattern + 1 from the chain wrap
    // it shouldn't have. Just verify it ranks above mid-chain nodes.
    expect(out.get(1)!).toBeGreaterThan(out.get(100)!);
  });

  it("returns ranks normalized to [0, 1] with max == 1", () => {
    const edges = [
      { source: 2, target: 1 },
      { source: 3, target: 1 },
    ];
    const out = computePageRank([1, 2, 3], edges);
    let max = 0;
    for (const r of out.values()) {
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
      if (r > max) max = r;
    }
    expect(max).toBeCloseTo(1.0);
  });
});
