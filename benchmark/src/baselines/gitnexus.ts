import { execSync, spawnSync } from "node:child_process";
import { resolve, basename } from "node:path";
import type { Baseline, BaselineOutput } from "./base.ts";
import type { Task, ExpectedAnswer, Location } from "../types.ts";

/**
 * GitNexus baseline. Issue #25 (HaleTom).
 *
 * GitNexus (https://github.com/abhigyanpatwari/GitNexus) is open-core
 * (PolyForm Noncommercial OSS) with a CLI we can drive directly.
 *
 *   P1 — symbol definition lookup → gitnexus context <name>
 *   P2 — reference finding         → gitnexus impact <name>
 *   P4 — file dependencies          → gitnexus cypher (graph query)
 *   P5 — dead code                  → gitnexus cypher (functions with no callers)
 *
 * Setup: `gitnexus analyze <root>` once per dataset (cold-start cost).
 * Per-task: spawn one subprocess per query, parse JSON stdout.
 */
export class GitNexusBaseline implements Baseline {
  name = "gitnexus";

  private root = "";
  private repoName = "";
  private indexCostMs = 0;
  private firstTaskInDataset = true;

  async setupForDataset(d: { name: string; rootPath: string }): Promise<void> {
    this.root = resolve(d.rootPath);
    this.repoName = basename(this.root).replace(/-\d+\.\d+\.\d+$/, "");
    this.firstTaskInDataset = true;

    // Ensure gitnexus is on PATH; bail loudly if not
    try {
      execSync("gitnexus --version", { stdio: "pipe", timeout: 5000 });
    } catch {
      throw new Error("gitnexus not found on PATH; install with `npm i -g gitnexus`");
    }

    // Analyze (index) the dataset root. Cold-start cost.
    const t0 = Date.now();
    try {
      execSync("gitnexus analyze", {
        cwd: this.root,
        stdio: "pipe",
        timeout: 600_000,
        encoding: "utf-8",
      });
    } catch (err) {
      console.warn(`  gitnexus analyze failed: ${(err as Error).message}`);
    }
    this.indexCostMs = Date.now() - t0;
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
          // gitnexus context <name> → returns symbol with filePath/startLine
          toolCalls++;
          payload = this.runCli(["context", task.query, "--repo", this.repoName]);
          prediction = { kind: "locations", locations: parseContextLocation(payload) };
          break;
        }
        case "P2": {
          // gitnexus impact <name> → blast-radius info; "affected" set ≈ refs
          toolCalls++;
          payload = this.runCli(["impact", task.query, "--repo", this.repoName]);
          prediction = { kind: "locations", locations: parseImpactLocations(payload) };
          break;
        }
        case "P4": {
          // file deps via cypher: GitNexus property name is `filePath`.
          // We capture the two halves separately so the parser can handle
          // each markdown table independently.
          toolCalls++;
          const importsQ = `MATCH (f:File {filePath: '${escapeCypher(task.query)}'})-[:IMPORTS]->(t:File) RETURN t.filePath AS filePath`;
          const importsOut = this.runCli(["cypher", importsQ, "--repo", this.repoName]);

          toolCalls++;
          const importersQ = `MATCH (s:File)-[:IMPORTS]->(t:File {filePath: '${escapeCypher(task.query)}'}) RETURN s.filePath AS filePath`;
          const importersOut = this.runCli(["cypher", importersQ, "--repo", this.repoName]);

          payload = importsOut + "\n---\n" + importersOut;

          prediction = {
            kind: "deps",
            imports: parseCypherColumn(importsOut, "filePath"),
            importers: parseCypherColumn(importersOut, "filePath"),
          };
          break;
        }
        case "P5": {
          // dead code: functions with no incoming :CALLS edges.
          // Note: GitNexus's call graph may not capture CommonJS
          // module.exports as a use site (same blind spot as
          // jcodemunch — flagged in the writeup).
          toolCalls++;
          const q = `MATCH (f:Function) WHERE NOT (()-[:CALLS]->(f)) RETURN f.name AS name LIMIT 500`;
          payload = this.runCli(["cypher", q, "--repo", this.repoName]);
          prediction = { kind: "names", names: parseCypherColumn(payload, "name") };
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
      notes = `error: ${(err as Error).message.slice(0, 200)}`;
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

  private runCli(args: string[]): string {
    const result = spawnSync("gitnexus", args, {
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    // Strip stderr noise (FTS index warnings, timing logs) and return stdout.
    // Many gitnexus subcommands emit a "[gitnexus] ..." prefix on stderr.
    return result.stdout || "";
  }
}

// ─── parsers ──────────────────────────────────────────────────────────────

function escapeCypher(s: string): string {
  return s.replace(/'/g, "\\'");
}

function parseContextLocation(text: string): Location[] {
  // gitnexus context output:
  // {"status":"found","symbol":{"filePath":"lib/x.js","startLine":36,...}}
  try {
    const obj = JSON.parse(text);
    if (obj?.symbol?.filePath && typeof obj.symbol.startLine === "number") {
      return [{ file: obj.symbol.filePath, line: obj.symbol.startLine }];
    }
  } catch {
    /* fall through to regex */
  }
  // Fallback regex
  const m = /"filePath"\s*:\s*"([^"]+)"[^}]{0,300}?"startLine"\s*:\s*(\d+)/.exec(text);
  if (m) return [{ file: m[1], line: parseInt(m[2], 10) }];
  return [];
}

function parseImpactLocations(text: string): Location[] {
  // gitnexus impact output has:
  //   affected_processes: [...]
  //   affected_modules: [{ name, filePath, ...}]
  //   byDepth: { 1: [...], 2: [...] }
  // Harvest all filePath occurrences (best-effort; impact is module-level).
  const locs: Location[] = [];
  const seen = new Set<string>();

  const reFilePath = /"filePath"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = reFilePath.exec(text)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      // No line info from impact — use line 1 as a placeholder. The
      // bench scorer uses file-level recall when line info is missing.
      locs.push({ file: m[1], line: 1 });
    }
  }
  return locs;
}

/**
 * Parse a single column out of gitnexus's cypher output. The CLI
 * returns:
 *   { "markdown": "| col |\n| --- |\n| val1 |\n| val2 |", "row_count": N }
 * We extract the markdown field, drop the header + separator rows,
 * and return the value column. `wantedCol` lets callers tolerate
 * multi-column responses (we just take the named column's index).
 */
function parseCypherColumn(text: string, wantedCol: string): string[] {
  const out: string[] = [];
  let md: string | null = null;
  try {
    const obj = JSON.parse(text);
    if (obj?.markdown && typeof obj.markdown === "string") md = obj.markdown;
  } catch {
    md = text; // raw markdown sometimes returned bare
  }
  if (!md) return out;

  const lines = md.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) return out; // header + separator + at least one row

  // Header row like "| filePath |" — find the wanted column index.
  const headerCells = lines[0]
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((s) => s.trim());
  const colIdx = headerCells.indexOf(wantedCol);
  if (colIdx < 0) return out;

  for (let i = 2; i < lines.length; i++) {
    // Skip the |---| separator row if it shows up later (unlikely but cheap).
    if (/^\|\s*-+\s*\|/.test(lines[i])) continue;
    const cells = lines[i]
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((s) => s.trim());
    const v = cells[colIdx];
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}
