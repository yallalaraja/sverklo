import { describe, it, expect } from "vitest";
import { grepResults, headResults, ctxPeek, splitBlocks } from "./post-filter.js";

const sample = [
  "## src/auth/middleware.ts:10-45 (function: authenticate)",
  "```ts",
  "export function authenticate(req, res, next) {",
  "  const token = req.headers.authorization;",
  "}",
  "```",
  "",
  "## src/api/routes.ts:1-20 (function: registerRoutes)",
  "```ts",
  "export function registerRoutes(app) {",
  "  app.get('/ping', ok);",
  "}",
  "```",
  "",
  "## src/auth/session.ts:30-60 (function: createSession)",
  "```ts",
  "export function createSession(user) {",
  "  return jwt.sign({ id: user.id }, secret);",
  "}",
  "```",
  "",
].join("\n");

describe("splitBlocks", () => {
  it("finds three blocks in the sample", () => {
    const { blocks } = splitBlocks(sample);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toContain("authenticate");
    expect(blocks[2]).toContain("createSession");
  });
});

describe("grepResults", () => {
  it("keeps only blocks matching the pattern", () => {
    const { text, kept, total } = grepResults(sample, "authent|createSession");
    expect(total).toBe(3);
    expect(kept).toBe(2);
    expect(text).toContain("authenticate");
    expect(text).toContain("createSession");
    expect(text).not.toContain("registerRoutes");
  });

  it("falls back to literal search for invalid regex", () => {
    const { kept } = grepResults(sample, "(unclosed");
    expect(kept).toBe(0); // literal substring "(unclosed" is nowhere
  });

  it("emits a structured empty-result message when nothing matches", () => {
    const { text, kept } = grepResults(sample, "nothing_matches_this_xyz");
    expect(kept).toBe(0);
    expect(text.toLowerCase()).toContain("no blocks");
  });
});

describe("headResults", () => {
  it("keeps only the first N blocks", () => {
    const { text, kept, total } = headResults(sample, 1);
    expect(total).toBe(3);
    expect(kept).toBe(1);
    expect(text).toContain("authenticate");
    expect(text).not.toContain("registerRoutes");
    expect(text).toContain("showing top 1");
  });

  it("is a no-op when N >= total", () => {
    const { text, kept } = headResults(sample, 99);
    expect(kept).toBe(3);
    expect(text).toBe(sample);
  });
});

describe("ctxPeek", () => {
  it("slices into a specific hit", () => {
    const { text, found } = ctxPeek(sample, 1, 0, 40);
    expect(found).toBe(true);
    expect(text).toContain("registerRoutes");
    expect(text).toContain("peek offset=0");
  });

  it("reports not-found for out-of-range index", () => {
    const { text, found } = ctxPeek(sample, 99, 0, 10);
    expect(found).toBe(false);
    expect(text).toContain("No block at index 99");
  });
});

// ReDoS regression tests. Dogfood security review 2026-05-14 flagged
// `grepResults` as a hang surface: an agent-supplied pattern like
// `(a+)+$` against a 50-char string took >8s and had to be SIGKILL'd.
// Reachable from sverklo_grep_results — a poisoned prompt or
// adversarial agent could wedge the indexer thread. We pre-validate
// for ReDoS-shaped patterns and refuse oversize inputs.
describe("grepResults ReDoS guardrails", () => {
  const sampleText = sample;

  it("refuses oversize patterns (>256 chars)", () => {
    const huge = "a".repeat(300);
    const result = grepResults(sampleText, huge);
    expect(result.kept).toBe(0);
    expect(result.text).toMatch(/regex longer than 256/);
  });

  it("rejects nested unbounded quantifier (a+)+ within 1s", () => {
    const start = Date.now();
    grepResults(sampleText, "(a+)+$");
    const elapsed = Date.now() - start;
    // Before the guardrail this took >5s. With the guardrail it falls
    // through to literal substring search, which is instant.
    expect(elapsed).toBeLessThan(1000);
  });

  it("rejects nested unbounded quantifier (a*)*", () => {
    const start = Date.now();
    grepResults(sampleText, "(a*)*b");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });

  it("rejects alternation-with-overlap quantifier (a|aa)+", () => {
    const start = Date.now();
    grepResults(sampleText, "(a|aa)+b");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });

  it("still accepts safe patterns", () => {
    const result = grepResults(sampleText, "authenticate");
    expect(result.total).toBeGreaterThan(0);
    expect(result.kept).toBeGreaterThan(0);
  });
});
