import type { ParsedChunk, ParseResult, ImportRef } from "../../types/index.js";
import {
  extractChunk,
  fallbackChunk,
  findBraceEnd,
  findStatementEnd,
} from "./_shared.js";

export function parseKotlin(content: string, lines: string[]): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: ImportRef[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    if (/^import\s+/.test(trimmed)) {
      const source = trimmed.match(/^import\s+([^\s;]+)/)?.[1] || "";
      imports.push({ source, names: [], isRelative: false });
      continue;
    }

    if (/^(?:public\s+|private\s+|internal\s+|protected\s+|inline\s+|suspend\s+|open\s+|override\s+)*fun\s+(?:<[^>]+>\s+)?(?:[\w.]+\.)?(\w+)/.test(trimmed)) {
      const name = trimmed.match(/fun\s+(?:<[^>]+>\s+)?(?:[\w.]+\.)?(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("function", name, lines, i, endLine));
      i = endLine;
    } else if (/^(?:public\s+|private\s+|internal\s+|protected\s+|abstract\s+|open\s+|sealed\s+|data\s+|enum\s+)*class\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/class\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("class", name, lines, i, endLine));
      i = endLine;
    } else if (/^(?:public\s+|private\s+|internal\s+)*object\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/object\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("class", name, lines, i, endLine));
      i = endLine;
    } else if (/^(?:public\s+|private\s+|internal\s+)*interface\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/interface\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("interface", name, lines, i, endLine));
      i = endLine;
    } else if (/^(?:public\s+|private\s+|internal\s+)*typealias\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/typealias\s+(\w+)/)?.[1] || null;
      const endLine = findStatementEnd(lines, i);
      chunks.push(extractChunk("type", name, lines, i, endLine));
      i = endLine;
    }
  }

  if (chunks.length === 0) chunks.push(...fallbackChunk(content, lines));
  return { chunks, imports };
}
