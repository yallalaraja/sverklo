import type { ParsedChunk, ParseResult, ImportRef } from "../../types/index.js";
import { extractChunk, fallbackChunk, findLuaEnd } from "./_shared.js";

export function parseLua(content: string, lines: string[]): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: ImportRef[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const indent = lines[i].length - trimmed.length;

    const reqMatch = trimmed.match(/require\s*\(?\s*['"]([^'"]+)['"]/);
    if (reqMatch) {
      imports.push({ source: reqMatch[1], names: [], isRelative: reqMatch[1].startsWith(".") });
    }

    if (/^(?:local\s+)?function\s+([\w.:]+)/.test(trimmed)) {
      const name = trimmed.match(/function\s+([\w.:]+)/)?.[1] || null;
      const endLine = findLuaEnd(lines, i, indent);
      chunks.push(extractChunk("function", name, lines, i, endLine));
      i = endLine;
    } else if (/^(?:local\s+)?(\w+)\s*=\s*function/.test(trimmed)) {
      const name = trimmed.match(/^(?:local\s+)?(\w+)\s*=\s*function/)?.[1] || null;
      const endLine = findLuaEnd(lines, i, indent);
      chunks.push(extractChunk("function", name, lines, i, endLine));
      i = endLine;
    }
  }

  if (chunks.length === 0) chunks.push(...fallbackChunk(content, lines));
  return { chunks, imports };
}
