import type { ParsedChunk, ParseResult, ImportRef } from "../../types/index.js";
import { extractChunk, fallbackChunk, findBraceEnd } from "./_shared.js";

export function parsePHP(content: string, lines: string[]): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: ImportRef[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    if (/^(?:use|require|include|require_once|include_once)\s+/.test(trimmed)) {
      const source = trimmed.match(/['"]([^'"]+)['"]/)?.[1] || trimmed.split(/\s+/)[1]?.replace(";", "") || "";
      imports.push({ source, names: [], isRelative: source.startsWith(".") });
      continue;
    }

    if (/(?:public|private|protected|static|\s)*function\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/function\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("function", name, lines, i, endLine));
      i = endLine;
    } else if (/^(?:abstract\s+)?class\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/class\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("class", name, lines, i, endLine));
      i = endLine;
    }
  }

  if (chunks.length === 0) chunks.push(...fallbackChunk(content, lines));
  return { chunks, imports };
}
