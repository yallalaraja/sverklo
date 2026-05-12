/**
 * FastAPI ground-truth generator (modern Python web framework dataset).
 *
 * `tiangolo/fastapi` 0.115.0 adds dependency-injection-heavy + Pydantic
 * coverage to the primitive bench. Issue: sverklo-bench#7.
 *
 * Complements requests (plain Python module) and flask (decorator-heavy
 * + LocalProxy globals) by exercising patterns specific to modern,
 * type-hint-driven Python:
 *
 *   - `Depends()` injection — structural pattern most retrievers handle
 *     poorly because the wiring is implicit in function signatures
 *   - Pydantic field-info classes (`Body`, `Query`, `Path`, `Header`,
 *     `Cookie`, `File`, `Form`) that look like values but act as types
 *   - Security backends (`OAuth2PasswordBearer`, `APIKeyHeader`) that
 *     extend a multi-level inheritance chain
 *   - Pure helper functions (`jsonable_encoder`) alongside classes —
 *     a mix that breaks parsers that special-case one or the other
 *
 * Methodology mirrors flask.gen.ts / requests.gen.ts:
 *
 *   P1 (definition lookup): 10 public symbols with hand-verified line
 *     numbers at FastAPI 0.115.0. Mix of classes and one helper function
 *     (`jsonable_encoder`), distributed across 9 files.
 *     Verification command:
 *       grep -nE "^(def|class) <name>\b" fastapi/<file>
 *
 *   P2 (reference finding): the same 10 names, references resolved at
 *     run-time via grep against `fastapi/`.
 *
 *   P4 (file dependencies): 5 files spanning the FastAPI app class,
 *     the routing layer, the dependency-injection internals, the
 *     parameter classes, and the OAuth2 security backend.
 *
 *   P5 (dead code): empty-expected pattern, same as flask + requests.
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Task, Location } from "../../types.ts";

// Hand-verified line numbers in fastapi/ for FastAPI 0.115.0.
// Verified 2026-05-12 against
// https://github.com/tiangolo/fastapi/tree/0.115.0. Re-run grep if the
// pinned ref changes.
const P1_DEFINITIONS: { name: string; file: string; line: number }[] = [
  { name: "FastAPI", file: "fastapi/applications.py", line: 48 },
  { name: "APIRouter", file: "fastapi/routing.py", line: 593 },
  { name: "Depends", file: "fastapi/params.py", line: 760 },
  { name: "BackgroundTasks", file: "fastapi/background.py", line: 9 },
  { name: "HTTPException", file: "fastapi/exceptions.py", line: 9 },
  { name: "UploadFile", file: "fastapi/datastructures.py", line: 30 },
  { name: "jsonable_encoder", file: "fastapi/encoders.py", line: 102 },
  { name: "OAuth2PasswordBearer", file: "fastapi/security/oauth2.py", line: 391 },
  { name: "APIKeyHeader", file: "fastapi/security/api_key.py", line: 114 },
  { name: "Query", file: "fastapi/params.py", line: 221 },
];

const P2_SYMBOLS: string[] = [
  "FastAPI",
  "APIRouter",
  "Depends",
  "BackgroundTasks",
  "HTTPException",
  "UploadFile",
  "jsonable_encoder",
  "OAuth2PasswordBearer",
  "APIKeyHeader",
  "Query",
];

// 5 files exercising different shapes of the FastAPI package.
const P4_FILES: string[] = [
  "fastapi/applications.py",         // top-level FastAPI(Starlette) application class
  "fastapi/routing.py",              // APIRouter + route dispatch + endpoint decoration
  "fastapi/dependencies/utils.py",   // dependency-injection resolution internals
  "fastapi/params.py",               // parameter classes (Depends, Body, Query, Path, ...)
  "fastapi/security/oauth2.py",      // OAuth2 security backends
];

export function generateFastapiTasks(rootPath: string): Task[] {
  if (!existsSync(rootPath)) {
    throw new Error(`fastapi checkout missing: ${rootPath}`);
  }
  const tasks: Task[] = [];

  // P1
  for (let i = 0; i < P1_DEFINITIONS.length; i++) {
    const { name, file, line } = P1_DEFINITIONS[i];
    tasks.push({
      id: `fa-p1-${pad(i + 1)}`,
      category: "P1",
      dataset: "fastapi",
      query: name,
      expected: { kind: "locations", locations: [{ file, line }] },
    });
  }

  // P2
  for (let i = 0; i < P2_SYMBOLS.length; i++) {
    const name = P2_SYMBOLS[i];
    const refs = findReferencesInFastapi(rootPath, name);
    tasks.push({
      id: `fa-p2-${pad(i + 1)}`,
      category: "P2",
      dataset: "fastapi",
      query: name,
      expected: { kind: "locations", locations: refs },
    });
  }

  // P4
  for (let i = 0; i < P4_FILES.length; i++) {
    const file = P4_FILES[i];
    const abs = join(rootPath, file);
    let imports: string[] = [];
    let importers: string[] = [];
    try {
      const content = readFileSync(abs, "utf-8");
      imports = extractPythonImports(content, file);
    } catch {}
    importers = findImportersInFastapi(rootPath, file);
    tasks.push({
      id: `fa-p4-${pad(i + 1)}`,
      category: "P4",
      dataset: "fastapi",
      query: file,
      expected: { kind: "deps", imports, importers },
    });
  }

  // P5
  for (let i = 0; i < 5; i++) {
    tasks.push({
      id: `fa-p5-${pad(i + 1)}`,
      category: "P5",
      dataset: "fastapi",
      query: "",
      expected: { kind: "names", names: [] },
    });
  }

  return tasks;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function extractPythonImports(content: string, file: string): string[] {
  const out = new Set<string>();
  const fileDir = file.replace(/\/[^/]+$/, "");
  const re = /^from\s+(\.[\w.]*)\s+import/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    const dotted = m[1];
    if (dotted === ".") continue;
    const rel = dotted.slice(1).replace(/\./g, "/");
    if (!rel) continue;
    const resolved = `${fileDir}/${rel}.py`;
    out.add(resolved);
  }
  return [...out];
}

function findReferencesInFastapi(root: string, name: string): Location[] {
  const out = grep(root, `\\b${escapeRe(name)}\\b`, ["fastapi"]);
  const defRe = new RegExp(
    `^\\s*(def|class)\\s+${escapeRe(name)}\\b|^\\s*${escapeRe(name)}\\s*:`,
  );
  return out
    .filter((h) => !defRe.test(h.snippet ?? ""))
    .map((h) => ({ file: h.file, line: h.line }));
}

function findImportersInFastapi(root: string, file: string): string[] {
  const baseName = file.replace(/^.*\//, "").replace(/\.py$/, "");
  if (!baseName) return [];
  const out = new Set<string>();
  try {
    const cmd = `grep -rln --include='*.py' --exclude-dir=__pycache__ ${shellQuote(`from \\.\\.\\?${baseName} import\\|from \\.\\.\\?[a-zA-Z_]\\+\\.${baseName} import`)} fastapi/ 2>/dev/null || true`;
    const result = execSync(cmd, {
      cwd: root,
      encoding: "utf-8",
      timeout: 30000,
      maxBuffer: 5 * 1024 * 1024,
      shell: "/bin/bash",
    });
    for (const line of result.split("\n")) {
      const p = line.trim();
      if (!p || p === file) continue;
      out.add(p);
    }
  } catch {}
  return [...out];
}

interface Hit {
  file: string;
  line: number;
  snippet?: string;
}

function grep(root: string, pattern: string, paths: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const p of paths) {
    const target = join(root, p);
    if (!existsSync(target)) continue;
    try {
      const out = execSync(
        `grep -rnE --include='*.py' --exclude-dir=__pycache__ ${shellQuote(pattern)} ${shellQuote(p)} 2>/dev/null || true`,
        {
          cwd: root,
          encoding: "utf-8",
          timeout: 60000,
          maxBuffer: 20 * 1024 * 1024,
          shell: "/bin/bash",
        },
      );
      for (const line of out.split("\n")) {
        if (!line) continue;
        const m = line.match(/^(.+?):(\d+):(.*)$/);
        if (m) hits.push({ file: m[1], line: parseInt(m[2], 10), snippet: m[3] });
      }
    } catch {}
  }
  return hits;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
