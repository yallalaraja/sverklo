import type { ParsedChunk, ParseResult, ImportRef } from "../../types/index.js";
import { extractChunk, fallbackChunk, findBraceEnd } from "./_shared.js";

export function parseCSharp(content: string, lines: string[]): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: ImportRef[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    // using directives
    if (/^using\s+/.test(trimmed) && !trimmed.includes("(")) {
      const source = trimmed.match(/using\s+(?:static\s+)?([^;=]+)/)?.[1]?.trim() || "";
      if (source) {
        imports.push({ source, names: [], isRelative: false });
      }
      continue;
    }

    // namespace (block-scoped or file-scoped)
    if (/^namespace\s+([\w.]+)/.test(trimmed)) {
      const name = trimmed.match(/namespace\s+([\w.]+)/)?.[1] || null;
      if (trimmed.includes("{")) {
        const endLine = findBraceEnd(lines, i);
        chunks.push(extractChunk("module", name, lines, i, endLine));
        i = endLine;
      } else {
        // File-scoped namespace (C# 10+): namespace Foo.Bar;
        chunks.push(extractChunk("module", name, lines, i, i));
      }
      continue;
    }

    // class, struct, record, interface, enum
    if (/(?:^|\s)class\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/class\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("class", name, lines, i, endLine));
      i = endLine;
    } else if (/(?:^|\s)struct\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/struct\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("class", name, lines, i, endLine));
      i = endLine;
    } else if (/(?:^|\s)record\s+(?:class\s+|struct\s+)?(\w+)/.test(trimmed)) {
      const name = trimmed.match(/record\s+(?:class\s+|struct\s+)?(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("class", name, lines, i, endLine));
      i = endLine;
    } else if (/(?:^|\s)interface\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/interface\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("interface", name, lines, i, endLine));
      i = endLine;
    } else if (/(?:^|\s)enum\s+(\w+)/.test(trimmed)) {
      const name = trimmed.match(/enum\s+(\w+)/)?.[1] || null;
      const endLine = findBraceEnd(lines, i);
      chunks.push(extractChunk("type", name, lines, i, endLine));
      i = endLine;
    }
    // Methods and constructors: access modifiers + return type + name(
    else {
      const hasModifier = /\b(?:public|private|protected|internal|static|abstract|virtual|override|sealed|async|new|extern)\s/.test(trimmed);
      const hasCall = /(\w+)\s*\(/.test(trimmed);
      const hasAssign = trimmed.includes("=");
      const opensBody = trimmed.includes("{") || trimmed.trimEnd().endsWith(")");
      if (hasModifier && hasCall && !hasAssign && opensBody) {
        const name = trimmed.match(/(\w+)\s*\(/)?.[1] || null;
        if (name && !["if", "for", "while", "switch", "catch", "using", "lock"].includes(name)) {
          const endLine = findBraceEnd(lines, i);
          chunks.push(extractChunk("method", name, lines, i, endLine));
          i = endLine;
        }
      }
    }
  }

  if (chunks.length === 0) chunks.push(...fallbackChunk(content, lines));
  return { chunks, imports };
}
