import type { ParsedChunk, ParseResult } from "../types/index.js";
import { parseMarkdown } from "./parser-md.js";
import { parseIpynb } from "./parser-ipynb.js";
import { parseVue } from "./parser-vue.js";
import { fallbackChunk } from "./parsers/_shared.js";
import { parseTSJS } from "./parsers/tsjs.js";
import { parsePython } from "./parsers/python.js";
import { parseGo } from "./parsers/go.js";
import { parseRust } from "./parsers/rust.js";
import { parseJava } from "./parsers/java.js";
import { parseCSharp } from "./parsers/csharp.js";
import { parseCCpp } from "./parsers/ccpp.js";
import { parseRuby } from "./parsers/ruby.js";
import { parsePHP } from "./parsers/php.js";
import { parseKotlin } from "./parsers/kotlin.js";
import { parseScala } from "./parsers/scala.js";
import { parseSwift } from "./parsers/swift.js";
import { parseDart } from "./parsers/dart.js";
import { parseElixir } from "./parsers/elixir.js";
import { parseLua } from "./parsers/lua.js";
import { parseZig } from "./parsers/zig.js";
import { parseHaskell } from "./parsers/haskell.js";
import { parseClojure } from "./parsers/clojure.js";
import { parseOCaml } from "./parsers/ocaml.js";

// Re-export so existing call-sites (`import { parseTSJS } from "./parser.js"`)
// in parser-imports.test.ts, parser-vue.test.ts, and parser-vue-hotfix.test.ts
// keep working after the per-language file split.
export { parseTSJS };

// Regex-based parser for MVP. Fast, no native dependencies.
// Handles the top languages well enough. Tree-sitter upgrade path for v2.
//
// Tree-sitter opt-in (v0.17): set SVERKLO_PARSER=tree-sitter and the
// parser will try to use a WASM grammar from ~/.sverklo/grammars/ for
// the file's language. If the grammar isn't installed (or the runtime
// isn't available), the regex path runs unchanged. The async dispatch
// in parseFileAsync() exists for callers who want to wait for the
// tree-sitter result; the sync parseFile() always returns the regex
// result (used by hot paths that can't be async). Indexer.ts uses
// the async path during the file walk.

export function parseFile(
  content: string,
  language: string
): ParseResult {
  const result = parseFileInner(content, language);
  // File-level header comment (Q1 v0.15-rc.1+): most missed eval tasks
  // were files where the answer was in the leading docstring/comment
  // block, which lived between imports and the first symbol and never
  // entered any chunk. Inject a synthetic module chunk holding that prose.
  const headerChunk = extractFileHeader(content.split("\n"), language);
  if (headerChunk) {
    // De-dup: don't emit the header chunk if a parsed chunk already
    // covers the same line range (e.g. parseMarkdown emits doc_section
    // chunks at the top of the file).
    const overlap = result.chunks.some(
      (c) => c.startLine <= headerChunk.startLine && c.endLine >= headerChunk.endLine
    );
    if (!overlap) {
      return { chunks: [headerChunk, ...result.chunks], imports: result.imports };
    }
  }
  return result;
}

function parseFileInner(
  content: string,
  language: string
): ParseResult {
  const lines = content.split("\n");

  switch (language) {
    case "typescript":
    case "javascript":
      return parseTSJS(content, lines);
    case "python":
      return parsePython(content, lines);
    case "go":
      return parseGo(content, lines);
    case "rust":
      return parseRust(content, lines);
    case "java":
      return parseJava(content, lines);
    case "c":
    case "cpp":
      return parseCCpp(content, lines);
    case "ruby":
      return parseRuby(content, lines);
    case "php":
      return parsePHP(content, lines);
    case "kotlin":
      return parseKotlin(content, lines);
    case "scala":
      return parseScala(content, lines);
    case "swift":
      return parseSwift(content, lines);
    case "dart":
      return parseDart(content, lines);
    case "elixir":
      return parseElixir(content, lines);
    case "lua":
      return parseLua(content, lines);
    case "zig":
      return parseZig(content, lines);
    case "haskell":
      return parseHaskell(content, lines);
    case "clojure":
      return parseClojure(content, lines);
    case "csharp":
      return parseCSharp(content, lines);
    case "ocaml":
      return parseOCaml(content, lines);
    case "vue":
      return parseVue(content, lines, parseTSJS);
    case "markdown":
      return parseMarkdown(content, lines);
    case "notebook":
      return parseIpynb(content, lines);
    default:
      return { chunks: fallbackChunk(content, lines), imports: [] };
  }
}

/**
 * Extract the leading documentation block from a file. Returns a synthetic
 * `module` chunk when the prologue is rich enough to be worth indexing
 * (≥ 2 comment lines), null otherwise. Comment style is inferred from the
 * language; languages without a known style (notebook, markdown, etc.)
 * return null — those have their own structural docs.
 */
function extractFileHeader(lines: string[], language: string): ParsedChunk | null {
  if (lines.length === 0) return null;
  if (language === "markdown" || language === "notebook") return null;

  const style = commentStyle(language);
  if (!style) return null;

  // Walk from the top, skipping blank lines and tolerating leading
  // imports/use/package directives — many files put a header AFTER the
  // first import block (see git-state.ts in our own repo).
  const prologueLines: string[] = [];
  let firstCommentIdx = -1;
  let lastCommentIdx = -1;
  const importPrefix = importPrefixFor(language);

  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    const line = lines[i];
    const trimmed = line.trim();
    // Skip blanks and import/use/package preludes.
    if (trimmed === "") continue;
    if (importPrefix.some((p) => trimmed.startsWith(p))) continue;

    if (isCommentLine(trimmed, style)) {
      if (firstCommentIdx < 0) firstCommentIdx = i;
      lastCommentIdx = i;
      prologueLines.push(stripCommentMarkers(trimmed, style));
      continue;
    }

    // Found a non-comment, non-import line — prologue ends here.
    break;
  }

  if (prologueLines.length < 2) return null;

  // Guard against trivial license/copyright headers — too short to be
  // useful as retrievable prose.
  const text = prologueLines.join(" ").trim();
  if (text.length < 60) return null;

  return {
    type: "module",
    name: "_module",
    signature: null,
    startLine: firstCommentIdx + 1,
    endLine: lastCommentIdx + 1,
    content: lines.slice(firstCommentIdx, lastCommentIdx + 1).join("\n"),
  };
}

type CommentStyle = "slash" | "hash" | "dash" | "semicolon";

function commentStyle(language: string): CommentStyle | null {
  switch (language) {
    case "typescript":
    case "javascript":
    case "go":
    case "rust":
    case "java":
    case "c":
    case "cpp":
    case "swift":
    case "kotlin":
    case "scala":
    case "dart":
    case "zig":
    case "php":
    case "csharp":
      return "slash";
    case "python":
    case "ruby":
    case "elixir":
      return "hash";
    case "lua":
    case "haskell":
    case "ocaml":
      return "dash";
    case "clojure":
      return "semicolon";
    default:
      return null;
  }
}

function importPrefixFor(language: string): string[] {
  switch (language) {
    case "typescript":
    case "javascript":
      return ["import ", "export ", "require(", 'require "', "use strict"];
    case "python":
      return ["import ", "from "];
    case "go":
      return ["package ", "import "];
    case "rust":
      return ["use ", "extern ", "mod ", "#[", "#!["];
    case "java":
      return ["package ", "import "];
    case "c":
    case "cpp":
      return ["#include", "#define", "#pragma", "#ifndef", "#ifdef"];
    case "ruby":
      return ["require ", "require_relative ", "module ", "class "];
    case "php":
      return ["<?php", "namespace ", "use "];
    case "kotlin":
    case "scala":
      return ["package ", "import "];
    case "swift":
      return ["import "];
    case "dart":
      return ["import ", "library ", "part "];
    case "elixir":
      return ["defmodule ", "use ", "import ", "alias "];
    case "csharp":
      return ["using ", "namespace "];
    case "clojure":
      return ["(ns "];
    default:
      return [];
  }
}

function isCommentLine(line: string, style: CommentStyle): boolean {
  switch (style) {
    case "slash":
      return line.startsWith("//") || line.startsWith("/*") || line.startsWith("*") || line.startsWith("*/");
    case "hash":
      return line.startsWith("#");
    case "dash":
      return line.startsWith("--");
    case "semicolon":
      return line.startsWith(";");
  }
}

function stripCommentMarkers(line: string, style: CommentStyle): string {
  switch (style) {
    case "slash":
      return line.replace(/^\/\/+\s?|^\/\*+\s?|^\*\/?\s?/, "").trim();
    case "hash":
      return line.replace(/^#+\s?/, "").trim();
    case "dash":
      return line.replace(/^--+\s?/, "").trim();
    case "semicolon":
      return line.replace(/^;+\s?/, "").trim();
  }
}

/**
 * Async parse path. When SVERKLO_PARSER=tree-sitter is set AND the
 * web-tree-sitter dep is installed AND a grammar for the language is
 * present at ~/.sverklo/grammars/, returns the tree-sitter result.
 * Otherwise falls back to the regex parser. The fallback is silent —
 * we never want a missing grammar to break indexing.
 */
export async function parseFileAsync(
  content: string,
  language: string
): Promise<ParseResult> {
  if (process.env.SVERKLO_PARSER !== "tree-sitter") {
    return parseFile(content, language);
  }
  try {
    const { tryParseTreeSitter } = await import("./parser-tree-sitter.js");
    const ts = await tryParseTreeSitter(content, language);
    if (ts) return ts;
  } catch { /* keep going — regex result below */ }
  return parseFile(content, language);
}
