import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import type { Baseline, BaselineOutput } from "./base.ts";
import type { Task, ExpectedAnswer, Location } from "../types.ts";

/**
 * CodeGraph (Jakedismo/codegraph-rust) baseline. Issue sverklo-bench#9.
 *
 * Status: SKELETON. Not enabled in the default baseline list. Requires a real
 * environment to run end-to-end (see prerequisites below). The mapping from
 * bench categories to CodeGraph's 4 consolidated agentic tools is committed
 * so that anyone with the environment can validate or revise it.
 *
 * Methodology fork (the load-bearing decision):
 *
 *   CodeGraph's MCP surface is 4 "agentic" tools (agentic_context,
 *   agentic_impact, agentic_architecture, agentic_quality). Each tool runs
 *   an internal reasoning agent (Rig/ReAct/LATS) that calls an LLM for
 *   planning and synthesis — typically 3-6 internal steps per call. This
 *   means CodeGraph cannot be measured LLM-free the way every other
 *   baseline on this bench is.
 *
 *   Two paths, both honest, both worth running:
 *
 *   Option A — agentic mode (representative of real usage). Configure
 *   CODEGRAPH_AGENT_ARCHITECTURE=rig, point CodeGraph at an LLM
 *   (e.g. claude-haiku-4-5), call the agentic_* tools. The bench
 *   measures the structured output's prediction + the token count of
 *   the rawPayload returned to our scorer. The LLM-side tokens
 *   CodeGraph burns internally are not counted (they happen inside
 *   the tool, not in the agent harness). This is "agentic
 *   CodeGraph vs single-call sverklo" — the comparison most
 *   resembles what a real user would experience.
 *
 *   Option B — non-agentic surface (apples-to-apples with the rest of
 *   the bench). CodeGraph does expose internal graph queries (the
 *   6 graph tools the agent calls) — see the README's "agentic
 *   tools (backed by 6 internal graph analysis tools)". If those
 *   internal tools are exposed as a non-agentic MCP surface, we'd
 *   call those directly and skip the LLM loop. This would isolate
 *   the retrieval-quality question from the agent's reasoning
 *   quality. As of 2026-05-13, the README doesn't document this
 *   surface as user-facing — needs maintainer confirmation.
 *
 *   Default is Option A. Option B is preferable if exposed.
 *
 * Prerequisites (verified against codegraph-rust README, 2026-05-13):
 *
 *   1. Rust toolchain + cargo
 *   2. SurrealDB process running on :3004
 *      surreal start --bind 0.0.0.0:3004 --user root --pass root \
 *                    file://$HOME/.codegraph/surreal.db
 *   3. Schema applied: cd schema && ./apply-schema.sh
 *   4. Index built: codegraph index <rootPath> -r -l rust,typescript,python
 *   5. For LSP-enabled tiers (balanced/full):
 *        rust-analyzer, typescript-language-server, pyright-langserver,
 *        gopls, jdtls, clangd installed on PATH
 *   6. For agentic mode: LLM API key in env
 *      (ANTHROPIC_API_KEY / OPENAI_API_KEY / etc.)
 *   7. CodeGraph binary built: ./install-codegraph-full-features.sh
 *
 * Tool mapping (bench category → CodeGraph agentic tool + focus):
 *
 *   P1 (definition lookup)    → agentic_context     focus="search"
 *   P2 (reference finding)    → agentic_impact      focus="call_chain"
 *   P4 (file dependencies)    → agentic_impact      focus="dependencies"
 *   P5 (dead-code detection)  → agentic_quality     focus="hotspots"
 *
 *   Rationale: agentic_context.search is described as direct symbol
 *   lookup; agentic_impact has the only call-graph surface in the
 *   tool list; agentic_quality.hotspots is the closest analog to
 *   the bench's "dead code" framing (which CodeGraph models as
 *   complexity hotspots + low-coupling islands, not explicit
 *   dead-code detection).
 *
 *   Open question for the maintainer: is hotspots the right P5
 *   mapping, or does CodeGraph have a more direct dead-code
 *   surface I'm missing?
 *
 * Indexing tier choice:
 *
 *   Default to "balanced" for first published numbers (per @Jakedismo's
 *   comment on sverklo-bench#9 and the README's guidance:
 *   "Good agentic results without full cost"). "fast" and "full"
 *   runs published as supplementary rows. The tier is set via env:
 *
 *     CODEGRAPH_INDEX_TIER=balanced (or fast/full)
 *
 * Community-implemented disclosure:
 *
 *   This adapter is community-implemented per the baseline-author
 *   independence convention surfaced on sverklo-bench#3 (no tool's
 *   maintainer authoring or reviewing the integration in our harness).
 *   @Jakedismo declined ongoing maintenance and gave explicit
 *   permission to publish numbers labeled as such. Expect the
 *   adapter to be revised as we learn the actual response shapes
 *   from real runs.
 */

const CODEGRAPH_PROTOCOL_VERSION = "2024-11-05";

export class CodeGraphBaseline implements Baseline {
  name = "codegraph";

  private child: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private root = "";
  private indexCostMs = 0;
  private firstTaskInDataset = true;

  async setupForDataset(d: { name: string; rootPath: string }): Promise<void> {
    this.root = resolve(d.rootPath);
    this.firstTaskInDataset = true;

    // Bail early with a clear error if the env isn't configured. We don't
    // try to auto-install Rust toolchain + SurrealDB + 6 LSPs.
    const bin = process.env.CODEGRAPH_BIN || "codegraph";
    if (!process.env.CODEGRAPH_BENCH_ENABLED) {
      throw new Error(
        "CodeGraph baseline skeleton not enabled. Set CODEGRAPH_BENCH_ENABLED=1 " +
          "and CODEGRAPH_BIN to the codegraph binary path. See file header for the " +
          "full prerequisite list (Rust toolchain, SurrealDB, LSPs, LLM API key).",
      );
    }

    // Index this dataset (cold-start cost). The CLI is fire-and-forget;
    // the long-running MCP server picks up the index from SurrealDB.
    const tier = process.env.CODEGRAPH_INDEX_TIER || "balanced";
    const indexStart = Date.now();
    await new Promise<void>((resolveFn, reject) => {
      const proc = spawn(
        bin,
        ["index", this.root, "-r", "--index-tier", tier],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      proc.on("close", (code) => {
        if (code === 0) resolveFn();
        else reject(new Error(`codegraph index exited ${code}`));
      });
      proc.on("error", reject);
    });
    this.indexCostMs = Date.now() - indexStart;

    // Spawn long-lived MCP server
    this.child = spawn(bin, ["start", "stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEGRAPH_PROJECT_ID: this.root,
        CODEGRAPH_AGENT_ARCHITECTURE: process.env.CODEGRAPH_AGENT_ARCHITECTURE || "rig",
      },
    });

    this.child.stdout!.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      let nl;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const resolveFn = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            resolveFn(msg);
          }
        } catch {
          /* skip non-JSON stderr noise */
        }
      }
    });
    this.child.stderr!.on("data", () => {
      /* CodeGraph logs progress to stderr */
    });

    await this.call("initialize", {
      protocolVersion: CODEGRAPH_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "sverklo-bench", version: "1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  async teardownForDataset(): Promise<void> {
    if (this.child) {
      try {
        this.child.kill();
      } catch {}
      this.child = null;
    }
    this.pending.clear();
    this.buffer = "";
  }

  async run(task: Task): Promise<BaselineOutput> {
    const start = Date.now();
    let payload = "";
    let toolCalls = 0;
    let prediction: ExpectedAnswer;
    let notes: string | undefined;

    try {
      switch (task.category) {
        case "P1": {
          toolCalls++;
          const result = await this.callTool("agentic_context", {
            query: task.query,
            focus: "search",
          });
          payload = stringifyResult(result);
          prediction = { kind: "locations", locations: parseHighlights(payload) };
          notes = extractStepCount(result);
          break;
        }
        case "P2": {
          toolCalls++;
          const result = await this.callTool("agentic_impact", {
            query: task.query,
            focus: "call_chain",
          });
          payload = stringifyResult(result);
          prediction = { kind: "locations", locations: parseHighlights(payload) };
          notes = extractStepCount(result);
          break;
        }
        case "P4": {
          toolCalls++;
          const result = await this.callTool("agentic_impact", {
            query: task.query,
            focus: "dependencies",
          });
          payload = stringifyResult(result);
          prediction = {
            kind: "deps",
            imports: parseDepsImports(payload),
            importers: parseDepsImporters(payload),
          };
          notes = extractStepCount(result);
          break;
        }
        case "P5": {
          toolCalls++;
          const result = await this.callTool("agentic_quality", {
            query: task.query,
            focus: "hotspots",
          });
          payload = stringifyResult(result);
          prediction = { kind: "names", names: parseDeadCodeNames(payload) };
          notes = extractStepCount(result);
          break;
        }
        default:
          prediction = { kind: "names", names: [] };
          notes = `unsupported task category: ${task.category}`;
      }
    } catch (err) {
      prediction =
        task.category === "P4"
          ? { kind: "deps", imports: [], importers: [] }
          : task.category === "P5"
            ? { kind: "names", names: [] }
            : { kind: "locations", locations: [] };
      notes = `error: ${(err as Error).message}`;
    }

    const wallTimeMs = Date.now() - start;
    const coldStartMs = this.firstTaskInDataset ? this.indexCostMs : 0;
    this.firstTaskInDataset = false;

    return {
      prediction,
      rawPayload: payload,
      toolCalls,
      wallTimeMs,
      coldStartMs,
      warmCallMs: wallTimeMs,
      notes,
    };
  }

  // ─── MCP client helpers ────────────────────────────────────────────────

  private call(method: string, params: any, timeoutMs = 120_000): Promise<any> {
    if (!this.child) throw new Error("codegraph MCP server not started");
    const id = this.nextId++;
    return new Promise((resolveFn, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP call timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) {
          reject(new Error(msg.error.message ?? "MCP error"));
        } else {
          resolveFn(msg.result);
        }
      });
      this.child!.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }

  private notify(method: string, params: any): void {
    if (!this.child) return;
    this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  // Agentic tool calls can take 30-90s (3-6 internal LLM steps each).
  // 120s timeout matches the bench's per-task budget.
  private callTool(name: string, args: any, timeoutMs = 120_000): Promise<any> {
    return this.call("tools/call", { name, arguments: args }, timeoutMs);
  }
}

// ─── Response parsing ────────────────────────────────────────────────────
//
// CodeGraph agentic tools return structured_output with file_path/line_number
// pairs inside a "highlights" array. Shape from the README:
//
//   {
//     "analysis_type": "dependency_analysis",
//     "structured_output": {
//       "analysis": "...",
//       "highlights": [
//         { "file_path": "...", "line_number": 42, "snippet": "..." }
//       ],
//       "next_steps": [...]
//     },
//     "steps_taken": "5",
//     "tool_use_count": 5
//   }
//
// We extract highlights for location-shaped tasks (P1/P2). For P4 deps
// we need to inspect the analysis text since "highlights" is location-
// shaped, not import-shaped. For P5 we look for symbol names in the
// hotspot list. All of this is best-effort regex parsing — the actual
// shape may differ until we've run against a real CodeGraph instance.

function stringifyResult(result: any): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  const content = result.content ?? result;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c.text ?? JSON.stringify(c)))
      .join("\n");
  }
  return JSON.stringify(result);
}

function parseHighlights(text: string): Location[] {
  const locs: Location[] = [];
  const seen = new Set<string>();

  // Structured form: "file_path":"x.rs","line_number":42
  const reJson =
    /"file_path"\s*:\s*"([^"]+)"[^}]{0,300}?"line_number"\s*:\s*(\d+)/g;
  let m;
  while ((m = reJson.exec(text)) !== null) {
    const key = `${m[1]}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    locs.push({ file: m[1], line: parseInt(m[2], 10) });
  }

  // Plain file:line form as a fallback
  const rePlain = /([^\s'"]+\.[a-zA-Z]+):(\d+)/g;
  while ((m = rePlain.exec(text)) !== null) {
    const key = `${m[1]}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    locs.push({ file: m[1], line: parseInt(m[2], 10) });
  }

  return locs;
}

function parseDepsImports(text: string): string[] {
  const imports = new Set<string>();
  // Try array-shaped imports first
  const reArr =
    /"(?:imports|dependencies|outgoing|imported_files|depends_on)"\s*:\s*\[([^\]]+)\]/g;
  let block;
  while ((block = reArr.exec(text)) !== null) {
    const items = block[1].match(/"([^"]+)"/g) ?? [];
    for (const it of items) {
      const cleaned = it.slice(1, -1);
      if (cleaned && cleaned.includes(".")) imports.add(cleaned);
    }
  }
  return Array.from(imports);
}

function parseDepsImporters(text: string): string[] {
  const importers = new Set<string>();
  const reArr =
    /"(?:importers|incoming|reverse_dependencies|depended_on_by)"\s*:\s*\[([^\]]+)\]/g;
  let block;
  while ((block = reArr.exec(text)) !== null) {
    const items = block[1].match(/"([^"]+)"/g) ?? [];
    for (const it of items) {
      const cleaned = it.slice(1, -1);
      if (cleaned && cleaned.includes(".")) importers.add(cleaned);
    }
  }
  return Array.from(importers);
}

function parseDeadCodeNames(text: string): string[] {
  const names = new Set<string>();
  // hotspot/symbol/name field
  const reName = /"(?:symbol|name|function|identifier)"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = reName.exec(text)) !== null) names.add(m[1]);
  return Array.from(names);
}

function extractStepCount(result: any): string | undefined {
  if (!result) return undefined;
  const top = typeof result === "object" ? result : null;
  if (top && top.steps_taken) return `steps=${top.steps_taken}`;
  // also try nested in the content payload
  const text = stringifyResult(result);
  const m = /"steps_taken"\s*:\s*"?(\d+)"?/.exec(text);
  if (m) return `steps=${m[1]}`;
  return undefined;
}
