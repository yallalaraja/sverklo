import type { ParsedChunk, ParseResult, ImportRef } from "../../types/index.js";
import { extractChunk, fallbackChunk, findBraceEnd } from "./_shared.js";

export function parseSwift(content: string, lines: string[]): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: ImportRef[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    if (/^import\s+/.test(trimmed)) {
      const source = trimmed.match(/^import\s+(\S+)/)?.[1] || "";
      imports.push({ source, names: [], isRelative: false });
      continue;
    }

    if (/^(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+|static\s+|override\s+|final\s+|@\w+\s+)*func\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/func\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("function", name, lines, i, endLine));
      i = endLine;
    } else if (/^(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+|final\s+)*class\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/class\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("class", name, lines, i, endLine));
      i = endLine;
    } else if (/^(?:public\s+|private\s+|internal\s+|fileprivate\s+)*struct\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/struct\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("type", name, lines, i, endLine));
      i = endLine;
    } else if (/^(?:public\s+|private\s+|internal\s+|fileprivate\s+|indirect\s+)*enum\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/enum\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("type", name, lines, i, endLine));
      i = endLine;
    } else if (/^(?:public\s+|private\s+|internal\s+|fileprivate\s+)*protocol\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/protocol\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("interface", name, lines, i, endLine));
      i = endLine;
    }
  }

  if (chunks.length === 0) chunks.push(...fallbackChunk(content, lines));
  return { chunks, imports };
}
