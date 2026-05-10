// Per-tool invocation stats — JSON file with atomic-debounced flush.
//
// Why a second telemetry surface (activity-log already exists):
//
// activity-log.ts writes JSONL — every tool.call appends one line. Great
// for chronological audit trails, terrible for "give me the per-tool
// counts over the last 30 days." That recall question requires a full
// scan + parse + aggregate every time, which is what `sverklo profile
// suggest` does today on activity.jsonl.
//
// This file ships a parallel surface: a structured JSON document that
// the MCP server updates in place during tool dispatch. `sverklo profile
// suggest` reads it directly — no scan, no parse loop, just one JSON.parse.
//
// Pattern is borrowed from pi-mcp-adapter (Ineersa, 2026, MIT) —
// stats.ts:148-171 specifically: atomic write via tmp+rename, debounced
// flush via setTimeout(...).unref() so the timer doesn't block exit,
// dispose() flushes synchronously on shutdown. Conversation that prompted
// the borrow: r/mcp thread with DistanceAlert5706 (memory:
// feedback_distancealert_thread.md).

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

export interface ToolCallEvent {
  tool: string;
  durationMs: number;
  outcome: "ok" | "error" | "timeout";
  errorCode?: string;
}

export interface ToolStat {
  calls: number;
  success: number;
  errors: number;
  errorCodes: Record<string, number>;
  lastCalledAt: number;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  totalDurationMs: number;
}

export interface ToolStatsDoc {
  version: 1;
  startedAt: number;
  updatedAt: number;
  totalCalls: number;
  tools: Record<string, ToolStat>;
}

const FLUSH_DELAY_MS_DEFAULT = 750;

function statsDir(projectPath: string): string {
  // Mirror activity-log's hashing scheme so per-project stats land next
  // to per-project activity.jsonl in ~/.sverklo/<name>-<hash>/.
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
  const name = basename(projectPath) || "unknown";
  return join(homedir(), ".sverklo", `${name}-${hash}`);
}

function statsFilePath(projectPath: string): string {
  return join(statsDir(projectPath), "tool-stats.json");
}

function emptyDoc(): ToolStatsDoc {
  const now = Date.now();
  return {
    version: 1,
    startedAt: now,
    updatedAt: now,
    totalCalls: 0,
    tools: {},
  };
}

function emptyTool(): ToolStat {
  return {
    calls: 0,
    success: 0,
    errors: 0,
    errorCodes: {},
    lastCalledAt: 0,
    lastSuccessAt: null,
    lastErrorAt: null,
    totalDurationMs: 0,
  };
}

/**
 * Per-process writer. One instance per project path. Loads existing
 * stats from disk on construction; subsequent record() calls update
 * the in-memory doc and schedule a debounced atomic flush. dispose()
 * is the synchronous escape hatch — call from process shutdown.
 */
export class ToolStatsWriter {
  private filePath: string;
  private doc: ToolStatsDoc;
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushDelayMs: number;

  constructor(projectPath: string, opts: { flushDelayMs?: number } = {}) {
    this.flushDelayMs = opts.flushDelayMs ?? FLUSH_DELAY_MS_DEFAULT;
    const dir = statsDir(projectPath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Directory creation best-effort; flush will retry.
    }
    this.filePath = statsFilePath(projectPath);
    this.doc = this.loadOrInit();
  }

  private loadOrInit(): ToolStatsDoc {
    if (!existsSync(this.filePath)) return emptyDoc();
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as ToolStatsDoc;
      if (parsed && parsed.version === 1 && parsed.tools) {
        return parsed;
      }
    } catch {
      // Corrupt or unreadable file — start fresh. The previous data is
      // preserved on disk until the first successful flush overwrites it.
    }
    return emptyDoc();
  }

  /**
   * Record a single tool-call event. Updates the in-memory doc and
   * schedules a debounced flush. Never throws.
   */
  record(event: ToolCallEvent): void {
    try {
      const tool = event.tool;
      if (!tool) return;
      const stat = this.doc.tools[tool] ?? emptyTool();
      const ts = Date.now();
      stat.calls += 1;
      stat.lastCalledAt = ts;
      stat.totalDurationMs += Math.max(0, event.durationMs || 0);
      if (event.outcome === "ok") {
        stat.success += 1;
        stat.lastSuccessAt = ts;
      } else {
        stat.errors += 1;
        stat.lastErrorAt = ts;
        const code = event.errorCode || event.outcome; // "error" or "timeout"
        stat.errorCodes[code] = (stat.errorCodes[code] || 0) + 1;
      }
      this.doc.tools[tool] = stat;
      this.doc.totalCalls += 1;
      this.doc.updatedAt = ts;
      this.dirty = true;
      this.scheduleFlush();
    } catch {
      // Never let stats logging take down the parent process.
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushSync();
    }, this.flushDelayMs);
    // Don't keep the event loop alive just for the stats flush.
    if (typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }
  }

  /**
   * Flush in-memory doc to disk atomically. Used by both the debounced
   * timer and dispose(). Atomicity via tmp+rename so concurrent readers
   * (sverklo profile suggest) never see a half-written file.
   */
  flushSync(): void {
    if (!this.dirty) return;
    try {
      const dir = dirname(this.filePath);
      mkdirSync(dir, { recursive: true });
      const tmp = this.filePath + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.doc, null, 2), "utf-8");
      renameSync(tmp, this.filePath);
      this.dirty = false;
    } catch {
      // Mirror activity-log's posture: stats are best-effort. A failed
      // flush leaves dirty=true, so the next scheduled flush retries.
      try {
        appendFileSync(
          join(homedir(), ".sverklo", "tool-stats-flush-errors.log"),
          `${new Date().toISOString()} flush failed for ${this.filePath}\n`
        );
      } catch {
        /* nothing more we can do */
      }
    }
  }

  /**
   * Synchronous flush + cancel pending timer. Call from process shutdown
   * paths so the last in-memory updates land on disk before exit.
   */
  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushSync();
  }

  /** Path the writer flushes to. Useful for tests + the read API below. */
  getFilePath(): string {
    return this.filePath;
  }
}

/**
 * Read the structured tool-stats doc for a project. Returns null if no
 * stats have been recorded yet — callers fall back to scanning
 * activity.jsonl in that case.
 */
export function readToolStats(projectPath: string): ToolStatsDoc | null {
  const path = statsFilePath(projectPath);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as ToolStatsDoc;
    if (parsed && parsed.version === 1 && parsed.tools) return parsed;
  } catch {
    return null;
  }
  return null;
}
