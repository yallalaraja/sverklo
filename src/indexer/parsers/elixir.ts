import type { ParsedChunk, ParseResult, ImportRef } from "../../types/index.js";
import {
  extractChunk,
  fallbackChunk,
  findEndKeyword,
  findStatementEnd,
} from "./_shared.js";

export function parseElixir(content: string, lines: string[]): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: ImportRef[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const indent = lines[i].length - trimmed.length;

    if (/^(?:import|alias|require|use)\s+([\w.]+)/.test(trimmed)) {
      const source = trimmed.match(/^(?:import|alias|require|use)\s+([\w.]+)/)?.[1] || "";
      imports.push({ source, names: [], isRelative: false });
      continue;
    }

    if (/^defmodule\s+([\w.]+)/.test(trimmed)) {
      const name = trimmed.match(/defmodule\s+([\w.]+)/)?.[1] || null;
      const endLine = findEndKeyword(lines, i, indent);
      chunks.push(extractChunk("module", name, lines, i, endLine));
      i = endLine;
    } else if (/^defp?\s+(\w+[!?]?)/.test(trimmed)) {
      const name = trimmed.match(/^defp?\s+(\w+[!?]?)/)?.[1] || null;
      const endLine = trimmed.includes(", do:") || /\sdo:\s/.test(trimmed)
        ? i
        : findEndKeyword(lines, i, indent);
      chunks.push(extractChunk("function", name, lines, i, endLine));
      i = endLine;
    } else if (/^defstruct\b/.test(trimmed)) {
      const endLine = findStatementEnd(lines, i);
      chunks.push(extractChunk("type", null, lines, i, endLine));
      i = endLine;
    }
  }

  if (chunks.length === 0) chunks.push(...fallbackChunk(content, lines));
  return { chunks, imports };
}
