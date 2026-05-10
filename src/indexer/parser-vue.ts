import type { ParsedChunk, ParseResult, ImportRef } from "../types/index.js";

// Vue SFCs need to parse the <script> block as TS/JS, but a static
// `import { parseTSJS } from "./parser.js"` creates a cycle (parser.ts
// dispatches .vue files back to parseVue). The cycle is harmless in
// ESM (live bindings + function-local use), but static analysis flags
// it. Inject parseTSJS as a parameter — caller (parser.ts) passes it
// in. Tests pass parseTSJS imported directly from parser.ts.
export type ParseTSJSFn = (content: string, lines: string[]) => ParseResult;

// Vue Single File Component (SFC) parser. Issue #21 (alnaggar-dev).
//
// .vue files have three structural blocks:
//   <template>   — markup with component refs and directives
//   <script>     — TS or JS module-level code (the symbol-bearing part)
//   <style>      — CSS (irrelevant for the symbol graph)
//
// Strategy:
//   1. Extract each block by regex (Vue SFCs are well-formed enough
//      that regex parsing is reliable for the outer structure; the
//      inner script content is then handed off to the proper TS/JS
//      parser).
//   2. Parse the <script> block with the existing TS/JS parser, then
//      remap chunk line numbers back to positions in the .vue source
//      so sverklo_impact / sverklo_refs / sverklo_lookup report the
//      .vue file with correct line numbers.
//   3. Walk the <template> block for PascalCase tags — those are
//      Vue component references — and emit them as relative imports
//      so PageRank captures the .vue → child-component edge.
//   4. Skip the <style> block for symbol extraction.
//
// Notes:
//   - Both Composition API (<script setup>) and Options API
//     (export default { ... }) work because the TS/JS parser
//     handles function/class/const declarations the same way.
//   - When both <script> and <script setup> exist, prefer setup
//     (it's the canonical Vue 3 form).
//   - Component refs in templates can't always be resolved to a
//     specific source file from the template alone (auto-import
//     plugins, global registration), so we emit them as
//     `./<Name>` relative imports — the graph builder is responsible
//     for resolving these against the file table.

interface SFCBlock {
  /** 1-indexed line number where the block's content starts. */
  startLine: number;
  /** 1-indexed line number where the block's content ends. */
  endLine: number;
  content: string;
  lang?: string;
  setup?: boolean;
}

interface SFCBlocks {
  template: SFCBlock | null;
  /** The block we treat as canonical for symbol extraction (setup if both exist). */
  script: SFCBlock | null;
  /** The "other" script block when both `<script>` and `<script setup>` exist.
   *  We extract imports from BOTH so vue-extras setups (where one block holds
   *  metadata like defineOptions and the other holds reactive logic) keep all
   *  their dependency edges. Symbol extraction still only runs on `script`. */
  scriptSecondary: SFCBlock | null;
  style: SFCBlock | null;
  /** Custom top-level blocks like <i18n>, <route>, <docs> — captured
   *  for full-text search indexing. Vue ecosystem libraries
   *  (vite-plugin-pages, vue-i18n, unplugin-vue-router) put real
   *  configuration data in these blocks; ignoring them makes that
   *  data invisible to sverklo_search. Finding 8. */
  customBlocks: Array<SFCBlock & { tagName: string }>;
}

const BLOCK_RE = /<(template|script|style)([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
const CUSTOM_BLOCK_RE = /<([a-z][a-z0-9-]*)([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
const KNOWN_TAGS = new Set(["template", "script", "style"]);
const LANG_ATTR_RE = /\blang\s*=\s*["']([^"']+)["']/i;
const SETUP_ATTR_RE = /\bsetup\b/i;
const COMPONENT_TAG_RE = /<([A-Z][A-Za-z0-9]*)\b/g;

export function parseSFCBlocks(content: string): SFCBlocks {
  const result: SFCBlocks = {
    template: null,
    script: null,
    scriptSecondary: null,
    style: null,
    customBlocks: [],
  };

  // Track newline positions once so we can map character offsets to
  // 1-indexed line numbers without splitting the whole string per match.
  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") lineStarts.push(i + 1);
  }
  const lineOf = (charIdx: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= charIdx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1; // 1-indexed
  };

  BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_RE.exec(content)) !== null) {
    const tagName = m[1].toLowerCase() as "template" | "script" | "style";
    const attrs = m[2] || "";
    const blockContent = m[3];
    // Index of the first character of the block's INNER content.
    const innerStart = m.index + m[0].indexOf(">") + 1;
    const innerEnd = innerStart + blockContent.length;
    // The content typically begins with a newline immediately after
    // the opening tag (`<template>\n  <h1>…`). The user's mental model
    // is "content starts on the line below the opening tag," so skip
    // that leading newline when reporting startLine.
    let firstNonNewline = innerStart;
    while (firstNonNewline < innerEnd && content[firstNonNewline] === "\n") {
      firstNonNewline++;
    }

    const block: SFCBlock = {
      startLine: lineOf(firstNonNewline),
      endLine: lineOf(Math.max(innerStart, innerEnd - 1)),
      content: blockContent,
      lang: LANG_ATTR_RE.exec(attrs)?.[1]?.toLowerCase(),
      setup: SETUP_ATTR_RE.test(attrs),
    };

    if (tagName === "script") {
      // Vue allows one regular <script> AND one <script setup>. Prefer
      // setup as the canonical block for symbol extraction, but keep
      // both so we can union their import lists later (Finding 3).
      if (!result.script) {
        result.script = block;
      } else if (block.setup && !result.script.setup) {
        result.scriptSecondary = result.script;
        result.script = block;
      } else if (!block.setup && result.script.setup) {
        result.scriptSecondary = block;
      }
    } else if (tagName === "template" && !result.template) {
      result.template = block;
    } else if (tagName === "style" && !result.style) {
      result.style = block;
    }
  }

  // Second pass: capture top-level custom blocks (<i18n>, <route>,
  // <docs>, <preview>, etc.) that aren't template/script/style.
  // Skip blocks nested inside template/script/style — those are HTML
  // children, not SFC siblings. We use the rough heuristic that a
  // top-level custom block sits OUTSIDE the regions covered by
  // template/script/scriptSecondary/style content.
  const occupied: Array<{ start: number; end: number }> = [];
  for (const blk of [result.template, result.script, result.scriptSecondary, result.style]) {
    if (!blk) continue;
    // We don't have stored char offsets; reconstruct via indexOf on the
    // raw content. Cheap because each SFC is small.
    const idx = content.indexOf(blk.content);
    if (idx >= 0) occupied.push({ start: idx, end: idx + blk.content.length });
  }
  CUSTOM_BLOCK_RE.lastIndex = 0;
  let cm: RegExpExecArray | null;
  while ((cm = CUSTOM_BLOCK_RE.exec(content)) !== null) {
    const tagName = cm[1].toLowerCase();
    if (KNOWN_TAGS.has(tagName)) continue;
    const innerStart = cm.index + cm[0].indexOf(">") + 1;
    const innerEnd = innerStart + cm[3].length;
    const insideKnownBlock = occupied.some(
      (r) => innerStart >= r.start && innerEnd <= r.end
    );
    if (insideKnownBlock) continue;
    let firstNonNewline = innerStart;
    while (firstNonNewline < innerEnd && content[firstNonNewline] === "\n") {
      firstNonNewline++;
    }
    result.customBlocks.push({
      startLine: lineOf(firstNonNewline),
      endLine: lineOf(Math.max(innerStart, innerEnd - 1)),
      content: cm[3],
      lang: LANG_ATTR_RE.exec(cm[2] || "")?.[1]?.toLowerCase(),
      tagName,
    });
  }

  return result;
}

export function extractComponentRefs(template: string): string[] {
  // Strip places where a `<PascalCase>` substring appears but isn't a
  // real component usage:
  //   - HTML comments: `<!-- TODO: <NewWidget /> -->`
  //   - Attribute values: `tooltip="Show <Profile /> here"`
  //   - Mustache interpolations: `{{ 'Render <Widget />' }}`
  // Without this, every false-positive becomes a phantom import edge
  // that pollutes PageRank.
  const cleaned = template
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/="[^"]*"/g, '=""')
    .replace(/='[^']*'/g, "=''")
    .replace(/\{\{[\s\S]*?\}\}/g, "");

  const refs = new Set<string>();
  let m: RegExpExecArray | null;
  COMPONENT_TAG_RE.lastIndex = 0;
  while ((m = COMPONENT_TAG_RE.exec(cleaned)) !== null) {
    refs.add(m[1]);
  }
  return [...refs];
}

// Vue 3 Composition API reactive helpers that wrap a value into a
// reactive primitive. A top-level `const X = ref(...)` declaration is
// the canonical Vue idiom for "module-level binding worth indexing,"
// so we treat them as first-class symbols.
const REACTIVE_HELPERS = [
  "ref",
  "shallowRef",
  "computed",
  "reactive",
  "shallowReactive",
  "readonly",
  "shallowReadonly",
  "toRef",
  "toRefs",
  "customRef",
  "defineProps",
  "defineEmits",
  "defineExpose",
  "defineSlots",
  "defineModel",
];
const REACTIVE_RE = new RegExp(
  `^(?:export\\s+)?(?:const|let|var)\\s+(\\w+)\\s*(?::\\s*[^=]+)?\\s*=\\s*(${REACTIVE_HELPERS.join("|")})\\s*[(<]`,
);

function extractReactiveSymbols(
  scriptLines: string[],
  offset: number,
  seenNames: Set<string>,
  chunks: ParsedChunk[]
): void {
  for (let i = 0; i < scriptLines.length; i++) {
    const trimmed = scriptLines[i].trimStart();
    const m = REACTIVE_RE.exec(trimmed);
    if (!m) continue;
    const name = m[1];
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    chunks.push({
      type: "function",
      name,
      signature: trimmed.replace(/[\s\S]*$/m, "").trim() || null,
      startLine: i + 1 + offset,
      endLine: i + 1 + offset,
      content: scriptLines[i],
    });
  }
}

export function parseVue(
  content: string,
  _lines: string[],
  parseTSJS: ParseTSJSFn
): ParseResult {
  const blocks = parseSFCBlocks(content);
  const chunks: ParsedChunk[] = [];
  const imports: ImportRef[] = [];

  if (blocks.script) {
    // Strip leading newlines so parseTSJS's line 1 corresponds to the
    // first real line of script (which is .vue line `block.startLine`).
    // Without this, parseTSJS sees a leading blank line as line 1 and
    // every chunk's reported .vue line is off by one.
    let scriptContent = blocks.script.content;
    while (scriptContent.startsWith("\n")) {
      scriptContent = scriptContent.slice(1);
    }
    const scriptLines = scriptContent.split("\n");
    const scriptResult = parseTSJS(scriptContent, scriptLines);
    const offset = blocks.script.startLine - 1;
    for (const chunk of scriptResult.chunks) {
      chunks.push({
        ...chunk,
        startLine: chunk.startLine + offset,
        endLine: chunk.endLine + offset,
      });
    }
    imports.push(...scriptResult.imports);

    // Vue Composition API: detect top-level reactive bindings as
    // first-class symbols. `const total = computed(() => ...)` is the
    // canonical Vue equivalent of a function declaration in terms of
    // what users ask "find references to" — without this, every
    // `ref`/`computed`/`reactive` is invisible to sverklo_lookup and
    // sverklo_refs.
    const seenNames = new Set(scriptResult.chunks.map((c) => c.name).filter(Boolean) as string[]);
    extractReactiveSymbols(scriptLines, offset, seenNames, chunks);
  }

  // Finding 3: when both <script> and <script setup> exist, the user
  // typically puts metadata (defineOptions, name) in the plain block
  // and reactive logic in setup. Imports from BOTH blocks are real
  // dependencies; dropping the secondary block's imports broke
  // PageRank edges for any file that did this.
  if (blocks.scriptSecondary) {
    let secondaryContent = blocks.scriptSecondary.content;
    while (secondaryContent.startsWith("\n")) {
      secondaryContent = secondaryContent.slice(1);
    }
    const secondaryLines = secondaryContent.split("\n");
    const secondaryResult = parseTSJS(secondaryContent, secondaryLines);
    imports.push(...secondaryResult.imports);
  }

  if (blocks.template) {
    // PascalCase tags in templates are component references. Emit as
    // relative imports so the graph builder can resolve them against
    // the file table (./UserCard → UserCard.vue at depth-1).
    // Finding 11: skip refs that already appear as script imports —
    // otherwise PageRank double-counts the edge weight.
    const importedNames = new Set<string>();
    for (const imp of imports) {
      for (const name of imp.names) importedNames.add(name);
      // Also catch `./UserCard.vue` import → `<UserCard />` template usage.
      const baseFromSource = imp.source.split("/").pop()?.replace(/\.(vue|tsx?|jsx?|mjs|cjs)$/, "");
      if (baseFromSource) importedNames.add(baseFromSource);
    }
    const componentRefs = extractComponentRefs(blocks.template.content);
    for (const ref of componentRefs) {
      if (importedNames.has(ref)) continue;
      imports.push({
        source: `./${ref}`,
        names: [ref],
        isRelative: true,
      });
    }
    // Emit the template as a `block` chunk so it's searchable as
    // free text. Useful for queries like "where do we render the
    // user-card avatar" — the template often contains the only
    // copy of class names, slots, and prop bindings.
    chunks.push({
      type: "block",
      name: "template",
      signature: null,
      startLine: blocks.template.startLine,
      endLine: blocks.template.endLine,
      content: blocks.template.content,
    });
  }

  // Custom blocks (<i18n>, <route>, <docs>, ...): emit each as a
  // generic block chunk so its content is searchable. No symbol
  // extraction — these blocks hold config data, not code.
  for (const cb of blocks.customBlocks) {
    chunks.push({
      type: "block",
      name: cb.tagName,
      signature: cb.lang ? `lang=${cb.lang}` : null,
      startLine: cb.startLine,
      endLine: cb.endLine,
      content: cb.content,
    });
  }

  // Style block intentionally skipped — no symbol surface, and
  // including it as a block chunk would dilute search relevance.

  if (chunks.length === 0) {
    // Fallback: emit the whole file as a single chunk so it remains
    // searchable even if SFC parsing finds nothing recognizable.
    return {
      chunks: [
        {
          type: "block",
          name: "vue",
          signature: null,
          startLine: 1,
          endLine: content.split("\n").length,
          content,
        },
      ],
      imports: [],
    };
  }

  return { chunks, imports };
}
