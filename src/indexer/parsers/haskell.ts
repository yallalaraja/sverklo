import type { ParsedChunk, ParseResult, ImportRef } from "../../types/index.js";
import { extractChunk, fallbackChunk, findHaskellBlockEnd } from "./_shared.js";

export function parseHaskell(content: string, lines: string[]): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: ImportRef[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const indent = lines[i].length - trimmed.length;

    if (/^import\s+(?:qualified\s+)?([\w.]+)/.test(trimmed)) {
      const source = trimmed.match(/^import\s+(?:qualified\s+)?([\w.]+)/)?.[1] || "";
      imports.push({ source, names: [], isRelative: false });
      continue;
    }

    // Type signatures: foo :: Int -> Int
    if (/^([a-z_]\w*)\s*::/.test(trimmed)) {
      const name = trimmed.match(/^([a-z_]\w*)\s*::/)?.[1] || null;
      const endLine = findHaskellBlockEnd(lines, i, indent);
      chunks.push(extractChunk("function", name, lines, i, endLine));
      i = endLine;
    } else if (/^data\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/data\s+(\w+)/)?.[1] || null;
      const endLine = findHaskellBlockEnd(lines, i, indent);
      chunks.push(extractChunk("type", name, lines, i, endLine));
      i = endLine;
    } else if (/^newtype\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/newtype\s+(\w+)/)?.[1] || null;
      const endLine = findHaskellBlockEnd(lines, i, indent);
      chunks.push(extractChunk("type", name, lines, i, endLine));
      i = endLine;
    } else if (/^type\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/type\s+(\w+)/)?.[1] || null;
      const endLine = findHaskellBlockEnd(lines, i, indent);
      chunks.push(extractChunk("type", name, lines, i, endLine));
      i = endLine;
    } else if (/^class\s+/.test(trimmed)) {
      const name = trimmed.match(/class\s+(?:\([^)]*\)\s*=>\s*)?(\w+)/)?.[1] || null;
      const endLine = findHaskellBlockEnd(lines, i, indent);
      chunks.push(extractChunk("interface", name, lines, i, endLine));
      i = endLine;
    }
  }

  if (chunks.length === 0) chunks.push(...fallbackChunk(content, lines));
  return { chunks, imports };
}
