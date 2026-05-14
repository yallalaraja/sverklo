import type { ParsedChunk, ParseResult, ImportRef } from "../../types/index.js";
import { fallbackChunk, findIndentEnd } from "./_shared.js";

export function parsePython(content: string, lines: string[]): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: ImportRef[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // Imports
    if (/^(?:from\s+(\S+)\s+)?import\s+(.+)$/.test(trimmed)) {
      const m = trimmed.match(/^(?:from\s+(\S+)\s+)?import\s+(.+)$/);
      if (m) {
        const rawSource = m[1] || m[2].split(",")[0].trim();
        const isRelative = (m[1] || "").startsWith(".");
        // Python relative imports use leading dots:
        //   `from .X import Y`        → current package + X        → ./X
        //   `from ..X import Y`       → parent package + X         → ../X
        //   `from ...X import Y`      → grandparent + X            → ../../X
        //   `from .X.Y import Z`      → current package . X . Y    → ./X/Y
        // Convert to Node-style relative paths so graph-builder's
        // resolveImport() can join() them with fromDir correctly.
        // Without this, `from .adapters` was being join()'d as
        // `src/requests/.adapters` (literal), which doesn't resolve.
        let source = rawSource;
        if (isRelative) {
          const dotMatch = rawSource.match(/^(\.+)(.*)$/);
          if (dotMatch) {
            const dots = dotMatch[1];
            const rest = dotMatch[2].replace(/\./g, "/");
            // 1 dot = current dir = "./", 2 dots = "../", 3 = "../../", ...
            const upLevels = dots.length - 1;
            const prefix = upLevels === 0 ? "./" : "../".repeat(upLevels);
            source = prefix + rest;
          }
        }
        imports.push({
          source,
          names: m[2].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]),
          isRelative,
        });
      }
      continue;
    }

    // Functions
    if (/^(?:async\s+)?def\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/def\s+(\w+)/)?.[1] || null;
      const endLine = findIndentEnd(lines, i, indent);
      const sig = trimmed.replace(/:$/, "");
      chunks.push({
        type: "function",
        name,
        signature: sig,
        startLine: i + 1,
        endLine: endLine + 1,
        content: lines.slice(i, endLine + 1).join("\n"),
      });
      i = endLine;
    }
    // Classes
    else if (/^class\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/class\s+(\w+)/)?.[1] || null;
      const endLine = findIndentEnd(lines, i, indent);
      chunks.push({
        type: "class",
        name,
        signature: trimmed.replace(/:$/, ""),
        startLine: i + 1,
        endLine: endLine + 1,
        content: lines.slice(i, endLine + 1).join("\n"),
      });
      i = endLine;
    }
  }

  if (chunks.length === 0) chunks.push(...fallbackChunk(content, lines));
  return { chunks, imports };
}
