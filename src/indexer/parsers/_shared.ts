import type { ParsedChunk, ChunkType } from "../../types/index.js";

// Helpers shared across per-language parsers. Extracted from parser.ts
// during the 2026-05-13 file-split refactor. Behaviour is identical to
// the originals — see git blame on parser.ts for the design notes that
// led to each helper's current shape (especially findBraceEnd, which
// has accumulated several bug-fix layers).

export function extractChunk(
  type: ChunkType,
  name: string | null,
  lines: string[],
  startLine: number,
  endLine: number
): ParsedChunk {
  const content = lines.slice(startLine, endLine + 1).join("\n");
  const signature = lines[startLine].trim();
  return {
    type,
    name,
    signature,
    startLine: startLine + 1, // 1-indexed
    endLine: endLine + 1,
    content,
  };
}

export function findBraceEnd(lines: string[], startIdx: number): number {
  // String/regex/comment-aware brace counter. Without this, JS files
  // with `{` or `}` inside string literals (e.g. lodash.js's
  // `'{\n/* [wrapped with '` template at line 6301) make the depth
  // counter run away and the chunk swallow the rest of the file.
  // Tracks: ' " ` strings (with backslash escapes), // line comments,
  // /* */ block comments, and / regex literals.
  let depth = 0;
  let foundOpen = false;
  // Paren depth lets us distinguish the function-body brace from braces
  // that appear inside the parameter list (TS generic types like
  // `Array<{...}>`, default-value object literals, decorator
  // factories, etc.). Without this guard, `function f(x: Array<{a:
  // number}>): void {...}` truncates the chunk at the `}>` of the
  // type — we'd return after line 1 of a 200-line function. Issue
  // #34 surfaced this: 21% of functions in src/search/* were
  // mis-chunked, causing the orphan-detection in audit to flag
  // their internal helpers as dead code.
  let parenDepth = 0;
  let inBlockComment = false;
  let inTemplate = false;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    let inLineComment = false;
    let inSingle = false;
    let inDouble = false;
    let inRegex = false;
    // `prevSig` is the last non-whitespace char before the current
    // position — used to disambiguate `/` (regex vs division).
    let prevSig = "(";
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const next = line[j + 1] ?? "";
      // Skip the body of any active suppressor.
      if (inLineComment) continue;
      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          j++;
        }
        continue;
      }
      if (inTemplate) {
        if (ch === "\\") {
          j++;
          continue;
        }
        if (ch === "`") {
          inTemplate = false;
        }
        // Note: ${...} interpolations can contain real braces; we
        // intentionally don't recurse into them here (rare in
        // function bodies and over-engineering for this fix).
        continue;
      }
      if (inSingle) {
        if (ch === "\\") {
          j++;
          continue;
        }
        if (ch === "'") inSingle = false;
        continue;
      }
      if (inDouble) {
        if (ch === "\\") {
          j++;
          continue;
        }
        if (ch === '"') inDouble = false;
        continue;
      }
      if (inRegex) {
        if (ch === "\\") {
          j++;
          continue;
        }
        if (ch === "/") inRegex = false;
        if (ch === "[") {
          // character class — skip until ]
          while (j + 1 < line.length && line[j + 1] !== "]") {
            j++;
            if (line[j] === "\\") j++;
          }
        }
        continue;
      }
      // Not in any string/comment — open one if applicable.
      if (ch === "/" && next === "/") {
        inLineComment = true;
        continue;
      }
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        j++;
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        continue;
      }
      if (ch === "`") {
        inTemplate = true;
        continue;
      }
      // Regex literal: `/` is a regex iff prevSig is one of the chars
      // that precede expressions (operators, brackets, etc.) — not
      // an identifier or numeric literal (where `/` means division).
      if (ch === "/" && /[=,([{!&|?:;+\-*%~^<>]/.test(prevSig)) {
        inRegex = true;
        continue;
      }
      // Real code char.
      if (ch === "(") {
        parenDepth++;
      } else if (ch === ")") {
        if (parenDepth > 0) parenDepth--;
      } else if (ch === "{") {
        // Only braces OUTSIDE the parameter list belong to the
        // function body. Braces inside parens are type-annotation
        // objects, default-value literals, or decorator-factory
        // arguments — they must not start the body chunk.
        if (parenDepth === 0) {
          depth++;
          foundOpen = true;
        }
      } else if (ch === "}") {
        if (parenDepth === 0) {
          depth--;
          if (foundOpen && depth === 0) return i;
        }
      }
      if (!/\s/.test(ch)) prevSig = ch;
    }
  }
  return Math.min(startIdx + 50, lines.length - 1);
}

export function findIndentEnd(
  lines: string[],
  startIdx: number,
  baseIndent: number
): number {
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue; // skip blank lines
    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent) return i - 1;
  }
  return lines.length - 1;
}

export function findEndKeyword(
  lines: string[],
  startIdx: number,
  baseIndent: number
): number {
  for (let i = startIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const indent = lines[i].length - trimmed.length;
    if (trimmed === "end" && indent <= baseIndent) return i;
  }
  return Math.min(startIdx + 100, lines.length - 1);
}

export function findStatementEnd(lines: string[], startIdx: number): number {
  // Find the end of a statement (semicolon or empty line)
  let depth = 0;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      if (ch === "}" || ch === ")" || ch === "]") depth--;
    }
    if (depth <= 0 && (lines[i].trimEnd().endsWith(";") || lines[i].trim() === "")) {
      return i;
    }
  }
  return Math.min(startIdx + 20, lines.length - 1);
}

export function findLuaEnd(lines: string[], startIdx: number, baseIndent: number): number {
  // Lua uses `end` to close functions, but also for `if`/`for`/`while`.
  // Track depth via simple keyword counting.
  let depth = 0;
  const openRe = /\b(function|if|for|while|do)\b/g;
  const closeRe = /\bend\b/g;
  const elseRe = /\b(elseif|else)\b/g;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].replace(/--.*$/, "");
    let opens = 0;
    let closes = 0;
    let m;
    while ((m = openRe.exec(line)) !== null) opens++;
    openRe.lastIndex = 0;
    while ((m = closeRe.exec(line)) !== null) closes++;
    closeRe.lastIndex = 0;
    // elseif/else are not opens or closes
    while ((m = elseRe.exec(line)) !== null) {
      // no-op
    }
    elseRe.lastIndex = 0;
    depth += opens - closes;
    if (i > startIdx && depth <= 0) return i;
  }
  return Math.min(startIdx + 100, lines.length - 1);
}

export function findHaskellBlockEnd(lines: string[], startIdx: number, baseIndent: number): number {
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent) return i - 1;
  }
  return lines.length - 1;
}

export function findOCamlBlockEnd(lines: string[], startIdx: number, baseIndent: number): number {
  // OCaml top-level definitions end at the next top-level keyword at same or less indent
  const topRe = /^(let|module|type|open|exception|val|class|and|in)\b/;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent && topRe.test(line.trimStart()) && !/^and\b/.test(line.trimStart())) {
      return i - 1;
    }
  }
  return Math.min(startIdx + 100, lines.length - 1);
}

export function findParenEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let foundOpen = false;
  let inString = false;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '"' && line[j - 1] !== "\\") inString = !inString;
      if (inString) continue;
      if (ch === ";") break; // line comment
      if (ch === "(") {
        depth++;
        foundOpen = true;
      } else if (ch === ")") {
        depth--;
        if (foundOpen && depth === 0) return i;
      }
    }
  }
  return Math.min(startIdx + 50, lines.length - 1);
}

export function fallbackChunk(content: string, lines: string[]): ParsedChunk[] {
  // For unsupported languages or files with no recognized structures,
  // chunk by blocks of ~50 lines
  const chunks: ParsedChunk[] = [];
  const chunkSize = 50;
  for (let i = 0; i < lines.length; i += chunkSize) {
    const end = Math.min(i + chunkSize - 1, lines.length - 1);
    chunks.push({
      type: "block",
      name: null,
      signature: null,
      startLine: i + 1,
      endLine: end + 1,
      content: lines.slice(i, end + 1).join("\n"),
    });
  }
  return chunks;
}
