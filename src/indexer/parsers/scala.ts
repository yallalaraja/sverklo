import type { ParsedChunk, ParseResult, ImportRef } from "../../types/index.js";
import {
  extractChunk,
  fallbackChunk,
  findBraceEnd,
  findStatementEnd,
} from "./_shared.js";

export function parseScala(content: string, lines: string[]): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: ImportRef[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    if (/^import\s+/.test(trimmed)) {
      const source = trimmed.match(/^import\s+([^\s;]+)/)?.[1] || "";
      imports.push({ source, names: [], isRelative: false });
      continue;
    }

    if (/^(?:private\s+|protected\s+|override\s+|implicit\s+|final\s+)*def\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/def\s+(\w+)/)?.[1] || null;
      const endLine = trimmed.includes("{") ? findBraceEnd(lines, i) : findStatementEnd(lines, i);
      chunks.push(extractChunk("function", name, lines, i, endLine));
      i = endLine;
    } else if (/^(?:abstract\s+|final\s+|sealed\s+|case\s+)*class\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/class\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("class", name, lines, i, endLine));
      i = endLine;
    } else if (/^(?:case\s+)?object\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/object\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("class", name, lines, i, endLine));
      i = endLine;
    } else if (/^(?:sealed\s+)?trait\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/trait\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("interface", name, lines, i, endLine));
      i = endLine;
    }
  }

  if (chunks.length === 0) chunks.push(...fallbackChunk(content, lines));
  return { chunks, imports };
}
