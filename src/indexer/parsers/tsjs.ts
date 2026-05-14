import type { ParsedChunk, ParseResult, ImportRef } from "../../types/index.js";
import {
  extractChunk,
  fallbackChunk,
  findBraceEnd,
  findStatementEnd,
} from "./_shared.js";

export function parseTSJS(content: string, lines: string[]): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: ImportRef[] = [];

  // Extract imports. Several real-world cases the original anchor missed:
  //   - Indented script blocks in Vue SFCs (`  import …`) — the `^`
  //     anchor without leading-whitespace tolerance dropped 99.8% of
  //     imports on Vuetify (1080 .vue files, 451 imports, 1 captured).
  //   - `import type { X } from 'y'` and `import type X from 'y'` —
  //     TS type-only edges were absent from the dependency graph.
  //   - `import { type X, Y } from 'z'` — inline mixed form. Without
  //     stripping `type ` from individual names, the symbol got
  //     stored as "type X" and sverklo_lookup couldn't find it.
  //   - `import X, { Y } from 'z'` — default + named combo (React's
  //     `import React, { useState }` pattern). Pre-existing miss.
  const importRe =
    /^[ \t]*import\s+(?:type\s+)?(?:(\w+)\s*,\s*\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]|\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]|(\w+)\s+from\s+['"]([^'"]+)['"]|['"]([^'"]+)['"])/gm;
  let m;
  while ((m = importRe.exec(content)) !== null) {
    // Match groups, by branch:
    //   default + named:  m[1]=default name, m[2]=named-list, m[3]=source
    //   named only:       m[4]=named-list, m[5]=source
    //   default only:     m[6]=name, m[7]=source
    //   bare:             m[8]=source
    const names: string[] = [];
    if (m[1] && m[2]) {
      names.push(m[1]);
      for (const n of m[2].split(",")) {
        const cleaned = n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
        if (cleaned) names.push(cleaned);
      }
    } else if (m[4]) {
      for (const n of m[4].split(",")) {
        const cleaned = n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
        if (cleaned) names.push(cleaned);
      }
    } else if (m[6]) {
      names.push(m[6]);
    }
    const source = m[3] || m[5] || m[7] || m[8] || "";
    imports.push({
      source,
      names,
      isRelative: source.startsWith("."),
    });
  }

  // Re-export forms: `export * from "./foo"`, `export { X } from "./foo"`,
  // `export * as Bar from "./foo"`, `export { X as Y } from "./foo"`.
  // These create real dependency edges that the import regex above
  // misses. Without them, barrel files (src/index.ts re-exporting
  // everything) and central composition roots reached via barrels
  // (e.g. mcp-server.ts) have NO importers visible in sverklo_deps.
  // Architectural review 2026-05-13 (Dogfood T3) flagged this as a
  // graph-builder gap that hid the most-central files in the audit.
  const reexportRe =
    /^[ \t]*export\s+(?:\*\s+(?:as\s+\w+\s+)?from\s+['"]([^'"]+)['"]|\{([^}]+)\}\s+from\s+['"]([^'"]+)['"])/gm;
  while ((m = reexportRe.exec(content)) !== null) {
    const source = m[1] || m[3] || "";
    if (!source) continue;
    const names: string[] = [];
    if (m[2]) {
      for (const n of m[2].split(",")) {
        // `{ A as B }` → record the LOCAL binding name (B) so symbol
        // lookups via the barrel still resolve.
        const cleaned = n
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)
          .pop()!
          .trim();
        if (cleaned) names.push(cleaned);
      }
    }
    imports.push({
      source,
      names,
      isRelative: source.startsWith("."),
    });
  }

  // require() imports — same leading-whitespace tolerance.
  const requireRe = /^[ \t]*(?:const|let|var)\s+(?:{([^}]+)}|(\w+))\s*=\s*require\(['"]([^'"]+)['"]\)/gm;
  while ((m = requireRe.exec(content)) !== null) {
    const names = m[1]
      ? m[1].split(",").map((s) => s.trim())
      : m[2]
        ? [m[2]]
        : [];
    imports.push({
      source: m[3],
      names,
      isRelative: m[3].startsWith("."),
    });
  }

  // Parse structural elements using brace matching
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      continue;
    }

    let chunk: ParsedChunk | null = null;

    // Export/function declarations
    if (/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/function\*?\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunk = extractChunk("function", name, lines, i, endLine);
    }
    // Arrow functions assigned to const/let/var
    else if (
      /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*(?::\s*[^=]+)?\s*=>/.test(
        trimmed
      )
    ) {
      const name = trimmed.match(/(?:const|let|var)\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i) || findStatementEnd(lines, i);
      chunk = extractChunk("function", name, lines, i, endLine);
    }
    // CommonJS function expressions: var foo = function (...) { ... }
    // Express uses this everywhere; missing it leaves whole files unchunked.
    else if (
      /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function\*?\s*(?:\w+\s*)?\(/.test(
        trimmed
      )
    ) {
      const name = trimmed.match(/(?:const|let|var)\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunk = extractChunk("function", name, lines, i, endLine);
    }
    // CommonJS prototype methods: Foo.prototype.bar = function (...) { ... }
    // The bread and butter of Express, Mongoose, and most pre-class JS libs.
    else if (
      /^(\w+)\.prototype\.(\w+)\s*=\s*(?:async\s+)?function\*?\s*(?:\w+\s*)?\(/.test(trimmed)
    ) {
      const m2 = trimmed.match(/^(\w+)\.prototype\.(\w+)/);
      const name = m2 ? `${m2[1]}.${m2[2]}` : null;
      const endLine = findBraceEnd(lines, i);
      chunk = extractChunk("method", name, lines, i, endLine);
    }
    // Bare receiver methods at column 0: proto.foo = function () { ... }
    // Requires the line to start at column 0 (line === trimmed) so we don't
    // accidentally chunk inner-function callback assignments. Catches Express's
    // `var proto = module.exports = function(){}; proto.handle = function(){}`
    // pattern where the receiver is an aliased prototype.
    // Excludes `module.X` and `exports.X` (handled by dedicated branches above).
    else if (
      line === trimmed &&
      /^([a-z_]\w*)\.(\w+)\s*=\s*(?:async\s+)?function\*?\s*(?:\w+\s*)?\(/.test(trimmed) &&
      !/^(?:module|exports)\./.test(trimmed)
    ) {
      const m2 = trimmed.match(/^(\w+)\.(\w+)/);
      const name = m2 ? `${m2[1]}.${m2[2]}` : null;
      const endLine = findBraceEnd(lines, i);
      chunk = extractChunk("method", name, lines, i, endLine);
    }
    // CommonJS exports: module.exports = function name(...) { ... }
    //                   exports.foo = function (...) { ... }
    else if (
      /^module\.exports\s*=\s*(?:async\s+)?function\*?\s+(\w+)\s*\(/.test(trimmed)
    ) {
      const name = trimmed.match(/function\*?\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunk = extractChunk("function", name, lines, i, endLine);
    }
    else if (
      /^(?:module\.)?exports\.(\w+)\s*=\s*(?:async\s+)?function\*?\s*(?:\w+\s*)?\(/.test(trimmed)
    ) {
      const name = trimmed.match(/exports\.(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunk = extractChunk("function", name, lines, i, endLine);
    }
    // Class declarations
    else if (/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/class\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunk = extractChunk("class", name, lines, i, endLine);
    }
    // Interface declarations
    else if (/^(?:export\s+)?interface\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/interface\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunk = extractChunk("interface", name, lines, i, endLine);
    }
    // Type declarations
    else if (/^(?:export\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=/.test(trimmed)) {
      const name = trimmed.match(/type\s+(\w+)/)?.[1] || null;
      const endLine = findStatementEnd(lines, i);
      chunk = extractChunk("type", name, lines, i, endLine);
    }

    if (chunk && chunk.content.length > 10) {
      chunks.push(chunk);
      // Issue #16: chunk.endLine is 1-indexed (set by extractChunk),
      // but this loop's `i` is 0-indexed. Assigning the 1-indexed
      // value meant the for-loop's `i++` skipped one line past the
      // chunk. On a file with two adjacent top-level functions like
      //   function helper() { return 1; }
      //   export function run() { ... }
      // that skipped line was the `function run` declaration, and
      // every subsequent top-level function was missing from the
      // index entirely. Every other language parser in this file
      // correctly uses the 0-indexed `endLine` local. Subtract 1 so
      // the next iteration's `i++` lands exactly on the line after
      // the chunk.
      i = chunk.endLine - 1;
    }
  }

  // If no chunks found, fall back to whole-file chunk
  if (chunks.length === 0) {
    chunks.push(...fallbackChunk(content, lines));
  }

  return { chunks, imports };
}
