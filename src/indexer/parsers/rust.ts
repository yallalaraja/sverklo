import type { ParsedChunk, ParseResult, ImportRef } from "../../types/index.js";
import { extractChunk, fallbackChunk, findBraceEnd } from "./_shared.js";

export function parseRust(content: string, lines: string[]): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: ImportRef[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    if (/^use\s+/.test(trimmed)) {
      const source = trimmed.match(/^use\s+([^;{]+)/)?.[1]?.trim() || "";
      imports.push({ source, names: [], isRelative: source.startsWith("crate") });
      continue;
    }

    if (/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/fn\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("function", name, lines, i, endLine));
      i = endLine;
    } else if (/^(?:pub\s+)?struct\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/struct\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("type", name, lines, i, endLine));
      i = endLine;
    } else if (/^(?:pub\s+)?enum\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/enum\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("type", name, lines, i, endLine));
      i = endLine;
    } else if (/^(?:pub\s+)?trait\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/trait\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("interface", name, lines, i, endLine));
      i = endLine;
    } else if (/^impl\s+/.test(trimmed)) {
      const name = trimmed.match(/impl\s+(?:<[^>]+>\s+)?(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("class", name, lines, i, endLine));
      i = endLine;
    }
  }

  if (chunks.length === 0) chunks.push(...fallbackChunk(content, lines));
  return { chunks, imports };
}
