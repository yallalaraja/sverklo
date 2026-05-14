import type { ParsedChunk, ParseResult, ImportRef } from "../../types/index.js";
import { extractChunk, fallbackChunk, findBraceEnd } from "./_shared.js";

export function parseDart(content: string, lines: string[]): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: ImportRef[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    if (/^import\s+['"]([^'"]+)['"]/.test(trimmed)) {
      const source = trimmed.match(/import\s+['"]([^'"]+)['"]/)?.[1] || "";
      imports.push({ source, names: [], isRelative: source.startsWith(".") });
      continue;
    }

    if (/^(?:abstract\s+)?class\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/class\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("class", name, lines, i, endLine));
      i = endLine;
    } else if (/^mixin\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/mixin\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("class", name, lines, i, endLine));
      i = endLine;
    } else if (/^enum\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/enum\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("type", name, lines, i, endLine));
      i = endLine;
    } else if (/^(?:static\s+|final\s+|@\w+\s+)*(?:void|[\w<>?,\s]+)\s+(\w+)\s*\([^)]*\)\s*(?:async\s*)?\{/.test(trimmed)) {
      const name = trimmed.match(/(\w+)\s*\([^)]*\)\s*(?:async\s*)?\{/)?.[1] || null;
      if (name && !["if", "for", "while", "switch", "catch"].includes(name)) {
        const endLine = findBraceEnd(lines, i);
        chunks.push(extractChunk("function", name, lines, i, endLine));
        i = endLine;
      }
    }
  }

  if (chunks.length === 0) chunks.push(...fallbackChunk(content, lines));
  return { chunks, imports };
}
