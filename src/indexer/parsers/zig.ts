import type { ParsedChunk, ParseResult, ImportRef } from "../../types/index.js";
import { extractChunk, fallbackChunk, findBraceEnd } from "./_shared.js";

export function parseZig(content: string, lines: string[]): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: ImportRef[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    const importMatch = trimmed.match(/const\s+(\w+)\s*=\s*@import\(\s*"([^"]+)"\s*\)/);
    if (importMatch) {
      imports.push({
        source: importMatch[2],
        names: [importMatch[1]],
        isRelative: importMatch[2].startsWith(".") || importMatch[2].endsWith(".zig"),
      });
      continue;
    }

    if (/^(?:pub\s+)?(?:export\s+)?(?:inline\s+)?fn\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/fn\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("function", name, lines, i, endLine));
      i = endLine;
    } else if (/^(?:pub\s+)?const\s+(\w+)\s*=\s*(?:packed\s+|extern\s+)?struct\b/.test(trimmed)) {
      const name = trimmed.match(/const\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("type", name, lines, i, endLine));
      i = endLine;
    } else if (/^(?:pub\s+)?const\s+(\w+)\s*=\s*(?:extern\s+)?enum\b/.test(trimmed)) {
      const name = trimmed.match(/const\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("type", name, lines, i, endLine));
      i = endLine;
    } else if (/^(?:pub\s+)?const\s+(\w+)\s*=\s*union\b/.test(trimmed)) {
      const name = trimmed.match(/const\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("type", name, lines, i, endLine));
      i = endLine;
    }
  }

  if (chunks.length === 0) chunks.push(...fallbackChunk(content, lines));
  return { chunks, imports };
}
