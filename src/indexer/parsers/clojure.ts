import type { ParsedChunk, ParseResult, ImportRef, ChunkType } from "../../types/index.js";
import { extractChunk, fallbackChunk, findParenEnd } from "./_shared.js";

export function parseClojure(content: string, lines: string[]): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: ImportRef[] = [];

  // Match (require '...) and (:require [...]) and (:use ...)
  const requireRe = /\(:?require\s+(?:'?([\w.\-/]+)|\[([\w.\-/]+))/g;
  let m;
  while ((m = requireRe.exec(content)) !== null) {
    const source = m[1] || m[2] || "";
    if (source) imports.push({ source, names: [], isRelative: false });
  }
  const useRe = /\(:?use\s+(?:'?([\w.\-/]+)|\[([\w.\-/]+))/g;
  while ((m = useRe.exec(content)) !== null) {
    const source = m[1] || m[2] || "";
    if (source) imports.push({ source, names: [], isRelative: false });
  }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    const defMatch = trimmed.match(/^\((defn-?|def|defmacro|defprotocol|defmulti|defmethod|defrecord|deftype)\s+(\S+)/);
    if (defMatch) {
      const kind = defMatch[1];
      const name = defMatch[2];
      const endLine = findParenEnd(lines, i);
      const type: ChunkType =
        kind === "defprotocol" ? "interface" :
        kind === "defrecord" || kind === "deftype" ? "type" :
        kind === "def" ? "variable" : "function";
      chunks.push(extractChunk(type, name, lines, i, endLine));
      i = endLine;
    }
  }

  if (chunks.length === 0) chunks.push(...fallbackChunk(content, lines));
  return { chunks, imports };
}
