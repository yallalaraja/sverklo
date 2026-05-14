import type { ParsedChunk, ParseResult, ImportRef } from "../../types/index.js";
import { extractChunk, fallbackChunk, findEndKeyword } from "./_shared.js";

export function parseRuby(content: string, lines: string[]): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: ImportRef[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const indent = lines[i].length - trimmed.length;

    if (/^require\s+['"]([^'"]+)['"]/.test(trimmed)) {
      const source = trimmed.match(/require\s+['"]([^'"]+)['"]/)?.[1] || "";
      imports.push({ source, names: [], isRelative: source.startsWith(".") });
      continue;
    }

    if (/^def\s+(\w+[!?=]?)/.test(trimmed)) {
      const name = trimmed.match(/def\s+(\w+[!?=]?)/)?.[1] || null;
      const endLine = findEndKeyword(lines, i, indent);
      chunks.push(extractChunk("function", name, lines, i, endLine));
      i = endLine;
    } else if (/^class\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/class\s+(\w+)/)?.[1] || null;
      const endLine = findEndKeyword(lines, i, indent);
      chunks.push(extractChunk("class", name, lines, i, endLine));
      i = endLine;
    } else if (/^module\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/module\s+(\w+)/)?.[1] || null;
      const endLine = findEndKeyword(lines, i, indent);
      chunks.push(extractChunk("module", name, lines, i, endLine));
      i = endLine;
    }
  }

  if (chunks.length === 0) chunks.push(...fallbackChunk(content, lines));
  return { chunks, imports };
}
