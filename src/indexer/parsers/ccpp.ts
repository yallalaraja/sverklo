import type { ParsedChunk, ParseResult, ImportRef } from "../../types/index.js";
import { extractChunk, fallbackChunk, findBraceEnd } from "./_shared.js";

export function parseCCpp(content: string, lines: string[]): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: ImportRef[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    if (/^#include\s+[<"]([^>"]+)[>"]/.test(trimmed)) {
      const source = trimmed.match(/#include\s+[<"]([^>"]+)[>"]/)?.[1] || "";
      imports.push({ source, names: [], isRelative: trimmed.includes('"') });
      continue;
    }

    // Function definitions (simplified)
    if (/^\w[\w:*&<>\s]+\s+(\w+)\s*\([^)]*\)\s*\{/.test(trimmed)) {
      const name = trimmed.match(/(\w+)\s*\(/)?.[1] || null;
      if (name && !["if", "for", "while", "switch"].includes(name)) {
        const endLine = findBraceEnd(lines, i);
        chunks.push(extractChunk("function", name, lines, i, endLine));
        i = endLine;
      }
    } else if (/^(?:class|struct)\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/(?:class|struct)\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("class", name, lines, i, endLine));
      i = endLine;
    }
  }

  if (chunks.length === 0) chunks.push(...fallbackChunk(content, lines));
  return { chunks, imports };
}
