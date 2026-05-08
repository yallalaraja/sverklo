#!/usr/bin/env node
// Measure JSON-tokens of sverklo's tools/list at each SVERKLO_PROFILE level.
// Reproduces the numbers in https://sverklo.com/blog/we-already-shipped-mcp-code-mode/.
//
// Usage:
//   node scripts/measure-profiles.mjs [path/to/indexed/repo]
//
// Defaults to the sverklo repo itself if no path given.

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SVERKLO_BIN = resolve(REPO_ROOT, "dist", "bin", "sverklo.js");
const PROJECT_PATH = resolve(process.argv[2] ?? REPO_ROOT);

const PROFILES = ["full", "core", "nav", "lean", "research", "review"];

// Match sverklo's own utils/tokens.ts heuristic.
function estimateTokens(text) {
  return Math.ceil(text.length / 3.5);
}

function measureProfile(profile) {
  return new Promise((resolveResult) => {
    const env = { ...process.env, SVERKLO_PROFILE: profile, SVERKLO_DEBUG: "" };
    const child = spawn("node", [SVERKLO_BIN, PROJECT_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    let buf = "";
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { child.kill(); } catch {}
        resolveResult({ profile, error: "timeout" });
      }
    }, 30000);

    child.stdout.on("data", (data) => {
      buf += data.toString();
      const lines = buf.split("\n");
      buf = lines[lines.length - 1];
      for (const line of lines.slice(0, -1)) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2 && msg.result?.tools && !resolved) {
            resolved = true;
            clearTimeout(timer);
            const tools = msg.result.tools;
            const json = JSON.stringify(tools, null, 0);
            const sverkloTools = tools.filter(t => t.name.startsWith("sverklo_")).length;
            try { child.kill(); } catch {}
            resolveResult({
              profile,
              total_tools: tools.length,
              sverklo_tools: sverkloTools,
              json_chars: json.length,
              tokens: estimateTokens(json),
            });
            return;
          }
        } catch {
          /* not JSON-RPC, skip */
        }
      }
    });

    child.stderr.on("data", () => { /* swallow */ });
    child.on("error", (e) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolveResult({ profile, error: e.message });
      }
    });

    setTimeout(() => {
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "measure-profiles", version: "1" },
        },
      }) + "\n");
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", method: "notifications/initialized",
      }) + "\n");
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
      }) + "\n");
    }, 500);
  });
}

const results = [];
for (const profile of PROFILES) {
  const r = await measureProfile(profile);
  results.push(r);
}

console.log("");
console.log("SVERKLO_PROFILE  tools  chars   tokens  reduction");
console.log("---------------- -----  ------  ------  ---------");
const full = results.find((r) => r.profile === "full");
for (const r of results) {
  if (r.error) {
    console.log(`${r.profile.padEnd(16)} ERROR: ${r.error}`);
    continue;
  }
  const reduction = full && r.tokens
    ? `${((1 - r.tokens / full.tokens) * 100).toFixed(1)}%`
    : "—";
  console.log(
    `${r.profile.padEnd(16)} ${String(r.sverklo_tools).padStart(3)}    ` +
    `${String(r.json_chars).padStart(6)}  ${String(r.tokens).padStart(6)}  ${reduction.padStart(8)}`
  );
}
console.log("");
console.log(`Indexed project: ${PROJECT_PATH}`);
console.log(`Sverklo bin:     ${SVERKLO_BIN}`);
