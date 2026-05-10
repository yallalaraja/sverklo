import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolStatsWriter, readToolStats } from "./tool-stats.js";

// Behaviour we want to lock in:
//   - record() updates per-tool counters in memory
//   - flushSync() writes the document atomically (tmp+rename)
//   - dispose() flushes on shutdown even if a debounce timer is still pending
//   - readToolStats() returns null cleanly when the file is absent
//   - error events bucket by errorCode
//
// These regressions matter because the writer runs on every tool dispatch
// in the MCP server hot path. A regression here means either silent data
// loss (sverklo profile suggest gets wrong recommendations) or process
// crashes during shutdown (worse).

describe("ToolStatsWriter", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sverklo-stats-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("records and persists tool calls round-trip", () => {
    const writer = new ToolStatsWriter(tmp, { flushDelayMs: 1 });
    writer.record({ tool: "sverklo_lookup", durationMs: 12, outcome: "ok" });
    writer.record({ tool: "sverklo_lookup", durationMs: 8, outcome: "ok" });
    writer.record({ tool: "sverklo_search", durationMs: 22, outcome: "ok" });
    writer.dispose();

    const doc = readToolStats(tmp);
    expect(doc).not.toBeNull();
    expect(doc!.totalCalls).toBe(3);
    expect(Object.keys(doc!.tools).length).toBe(2);
    expect(doc!.tools.sverklo_lookup.calls).toBe(2);
    expect(doc!.tools.sverklo_lookup.success).toBe(2);
    expect(doc!.tools.sverklo_lookup.errors).toBe(0);
    expect(doc!.tools.sverklo_search.calls).toBe(1);
  });

  it("buckets errors by errorCode", () => {
    const writer = new ToolStatsWriter(tmp, { flushDelayMs: 1 });
    writer.record({
      tool: "sverklo_audit",
      durationMs: 1500,
      outcome: "error",
      errorCode: "TimeoutError",
    });
    writer.record({
      tool: "sverklo_audit",
      durationMs: 200,
      outcome: "error",
      errorCode: "TimeoutError",
    });
    writer.record({
      tool: "sverklo_audit",
      durationMs: 50,
      outcome: "error",
      errorCode: "ValidationError",
    });
    writer.dispose();

    const doc = readToolStats(tmp);
    expect(doc!.tools.sverklo_audit.errors).toBe(3);
    expect(doc!.tools.sverklo_audit.success).toBe(0);
    expect(doc!.tools.sverklo_audit.errorCodes.TimeoutError).toBe(2);
    expect(doc!.tools.sverklo_audit.errorCodes.ValidationError).toBe(1);
  });

  it("returns null from readToolStats when no file exists yet", () => {
    expect(readToolStats(tmp)).toBeNull();
  });

  it("preserves cumulative counts across writer instances (loadOrInit)", () => {
    const w1 = new ToolStatsWriter(tmp, { flushDelayMs: 1 });
    w1.record({ tool: "sverklo_lookup", durationMs: 5, outcome: "ok" });
    w1.dispose();

    const w2 = new ToolStatsWriter(tmp, { flushDelayMs: 1 });
    w2.record({ tool: "sverklo_lookup", durationMs: 5, outcome: "ok" });
    w2.dispose();

    const doc = readToolStats(tmp);
    expect(doc!.totalCalls).toBe(2);
    expect(doc!.tools.sverklo_lookup.calls).toBe(2);
  });

  it("dispose() flushes pending state even with a long debounce", () => {
    // 60s debounce — without dispose() the data would never reach disk in
    // this test's lifetime.
    const writer = new ToolStatsWriter(tmp, { flushDelayMs: 60_000 });
    writer.record({ tool: "sverklo_search", durationMs: 1, outcome: "ok" });
    writer.dispose();

    const doc = readToolStats(tmp);
    expect(doc).not.toBeNull();
    expect(doc!.tools.sverklo_search.calls).toBe(1);
  });

  it("ignores malformed/missing tool names without throwing", () => {
    const writer = new ToolStatsWriter(tmp, { flushDelayMs: 1 });
    // @ts-expect-error — deliberately invalid input
    writer.record({ tool: "", durationMs: 5, outcome: "ok" });
    // @ts-expect-error — deliberately invalid input
    writer.record({ durationMs: 5, outcome: "ok" });
    writer.record({ tool: "sverklo_lookup", durationMs: 5, outcome: "ok" });
    writer.dispose();

    const doc = readToolStats(tmp);
    expect(doc!.totalCalls).toBe(1);
    expect(doc!.tools.sverklo_lookup.calls).toBe(1);
  });

  it("writes via tmp+rename — no .tmp file should remain after flush", () => {
    const writer = new ToolStatsWriter(tmp, { flushDelayMs: 1 });
    writer.record({ tool: "sverklo_lookup", durationMs: 5, outcome: "ok" });
    writer.dispose();

    expect(existsSync(writer.getFilePath())).toBe(true);
    expect(existsSync(writer.getFilePath() + ".tmp")).toBe(false);
  });
});
