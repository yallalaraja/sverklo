import type { ParsedChunk, ParseResult, ImportRef } from "../../types/index.js";
import { extractChunk, fallbackChunk, findBraceEnd } from "./_shared.js";

export function parseGo(content: string, lines: string[]): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: ImportRef[] = [];

  // Extract imports
  const importBlockRe = /^import\s*\(\s*\n([\s\S]*?)\n\s*\)/gm;
  let m;
  while ((m = importBlockRe.exec(content)) !== null) {
    for (const line of m[1].split("\n")) {
      const pkgMatch = line.match(/["']([^"']+)["']/);
      if (pkgMatch) {
        imports.push({
          source: pkgMatch[1],
          names: [],
          isRelative: pkgMatch[1].startsWith("."),
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    if (/^func\s+/.test(trimmed)) {
      const name =
        trimmed.match(/^func\s+(?:\([^)]+\)\s+)?(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("function", name, lines, i, endLine));
      i = endLine;
    } else if (/^type\s+(\w+)\s+struct\b/.test(trimmed)) {
      const name = trimmed.match(/type\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("type", name, lines, i, endLine));
      i = endLine;
    } else if (/^type\s+(\w+)\s+interface\b/.test(trimmed)) {
      const name = trimmed.match(/type\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("interface", name, lines, i, endLine));
      i = endLine;
    }
  }

  if (chunks.length === 0) chunks.push(...fallbackChunk(content, lines));
  return { chunks, imports };
}
