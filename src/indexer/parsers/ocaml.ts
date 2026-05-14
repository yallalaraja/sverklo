import type { ParsedChunk, ParseResult, ImportRef } from "../../types/index.js";
import { extractChunk, fallbackChunk, findOCamlBlockEnd } from "./_shared.js";

export function parseOCaml(content: string, lines: string[]): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: ImportRef[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const indent = lines[i].length - trimmed.length;

    if (/^open\s+([\w.]+)/.test(trimmed)) {
      const source = trimmed.match(/^open\s+([\w.]+)/)?.[1] || "";
      imports.push({ source, names: [], isRelative: false });
      continue;
    }

    if (/^let\s+(?:rec\s+)?(\w+)/.test(trimmed)) {
      const name = trimmed.match(/^let\s+(?:rec\s+)?(\w+)/)?.[1] || null;
      const endLine = findOCamlBlockEnd(lines, i, indent);
      chunks.push(extractChunk("function", name, lines, i, endLine));
      i = endLine;
    } else if (/^module\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/^module\s+(\w+)/)?.[1] || null;
      const endLine = findOCamlBlockEnd(lines, i, indent);
      chunks.push(extractChunk("module", name, lines, i, endLine));
      i = endLine;
    } else if (/^type\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/^type\s+(\w+)/)?.[1] || null;
      const endLine = findOCamlBlockEnd(lines, i, indent);
      chunks.push(extractChunk("type", name, lines, i, endLine));
      i = endLine;
    }
  }

  if (chunks.length === 0) chunks.push(...fallbackChunk(content, lines));
  return { chunks, imports };
}
