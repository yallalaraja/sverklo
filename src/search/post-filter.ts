// Stateless primitives that operate on the text output of a prior tool call.
// They let the host agent iteratively refine without burning another retrieval
// round-trip. Scoped intentionally tight — a full handle/slice architecture is
// P1-8, these are the cheap stand-ins.

/**
 * Split a rendered tool response into result blocks. Blocks are delimited by
 * `## path:lines` or `## path (…)` headers — the convention used by every
 * search-family tool. Anything before the first `##` is treated as preamble
 * (header text, result count) and preserved verbatim.
 */
export function splitBlocks(text: string): { preamble: string; blocks: string[]; trailer: string } {
  const lines = text.split("\n");
  const blocks: string[] = [];
  const pre: string[] = [];
  let current: string[] | null = null;
  let trailerStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Trailing footer-only lines (hints, warnings) — keep them separate so
    // post-filter doesn't accidentally drop them.
    if (current && (line.startsWith("⚠") || line.startsWith("_"))) {
      // Stop block accumulation at first trailer line; subsequent content is
      // footer and stays put.
      if (/^\s*$/.test(lines[i - 1] ?? "") && trailerStart === -1) {
        trailerStart = i;
        break;
      }
    }

    if (/^## /.test(line)) {
      if (current) blocks.push(current.join("\n"));
      current = [line];
      continue;
    }
    if (current) {
      current.push(line);
    } else {
      pre.push(line);
    }
  }
  if (current) blocks.push(current.join("\n"));

  const trailer = trailerStart >= 0 ? lines.slice(trailerStart).join("\n") : "";
  return { preamble: pre.join("\n"), blocks, trailer };
}

// ReDoS guardrails (Dogfood security review 2026-05-13, finalized 2026-05-14).
// Without these, an agent-supplied pattern like `(a+)+$` hangs the
// indexer thread because Node's V8 regex has no built-in timeout.
// Reachable from sverklo_grep_results args — a poisoned prompt or
// adversarial agent test can wedge the server.
const MAX_PATTERN_LENGTH = 256;

/**
 * Static-shape check for catastrophic-backtracking patterns. Catches
 * the obvious ReDoS shapes without pulling in `safe-regex2`. False
 * positives are acceptable here because the fallback is a literal
 * substring search — the user still gets results, just not regex.
 */
function looksDangerous(pattern: string): boolean {
  // Nested unbounded quantifiers: (a+)+, (a*)*, (a+)*, (.*)+ etc.
  // The classic ReDoS shape. Match `quantified-group quantifier` where
  // both parts use unbounded modifiers.
  if (/\([^)]*[*+][^)]*\)[*+]/.test(pattern)) return true;
  // Alternation followed by unbounded quantifier with overlap potential:
  // (a|aa)+, (.|.)+. Heuristic — looks for `|` inside parens then `*` or `+`.
  if (/\([^)]*\|[^)]*\)[*+]/.test(pattern)) return true;
  return false;
}

/**
 * Keep only blocks whose body matches the given regex. Returns the rebuilt
 * text plus a one-line "filtered N→K" footer.
 */
export function grepResults(text: string, pattern: string): { text: string; kept: number; total: number } {
  const { preamble, blocks, trailer } = splitBlocks(text);
  if (blocks.length === 0) return { text, kept: 0, total: 0 };

  // Input-length cap. A 500-char regex is either a probe or an
  // accident; either way, refuse early.
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return {
      text: `${preamble}\n\n_pattern rejected: regex longer than ${MAX_PATTERN_LENGTH} chars._`.trim(),
      kept: 0,
      total: blocks.length,
    };
  }

  // Static-shape check for ReDoS. Fall through to literal substring
  // search on rejection so the call still returns something useful.
  if (looksDangerous(pattern)) {
    return grepLiteral(text, pattern);
  }

  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    // Invalid regex — fall back to literal substring search.
    return grepLiteral(text, pattern);
  }

  const kept = blocks.filter((b) => re.test(b));
  const out = rejoin(preamble, kept, trailer);
  const footer = `_filtered ${blocks.length} → ${kept.length} via /${pattern}/_`;
  return {
    text: kept.length === 0 ? `${preamble}\n\nNo blocks matched /${pattern}/.`.trim() : `${out}\n${footer}`,
    kept: kept.length,
    total: blocks.length,
  };
}

function grepLiteral(text: string, substr: string): { text: string; kept: number; total: number } {
  const { preamble, blocks, trailer } = splitBlocks(text);
  const kept = blocks.filter((b) => b.includes(substr));
  const out = rejoin(preamble, kept, trailer);
  const footer = `_filtered ${blocks.length} → ${kept.length} via literal "${substr}"_`;
  return {
    text: kept.length === 0 ? `${preamble}\n\nNo blocks contained "${substr}".`.trim() : `${out}\n${footer}`,
    kept: kept.length,
    total: blocks.length,
  };
}

/**
 * Keep only the first N blocks. No-op when N >= total.
 */
export function headResults(text: string, n: number): { text: string; kept: number; total: number } {
  if (n <= 0) return { text: "", kept: 0, total: 0 };
  const { preamble, blocks, trailer } = splitBlocks(text);
  if (blocks.length <= n) return { text, kept: blocks.length, total: blocks.length };
  const kept = blocks.slice(0, n);
  const out = rejoin(preamble, kept, trailer);
  const footer = `_showing top ${n} of ${blocks.length} — pass head:${blocks.length} or a higher value for more._`;
  return { text: `${out}\n${footer}`, kept: n, total: blocks.length };
}

/**
 * Byte-slice into a single block (by zero-based index). Returns the slice plus
 * the header line for context.
 */
export function ctxPeek(
  text: string,
  hitIndex: number,
  offset: number,
  len: number
): { text: string; found: boolean } {
  const { blocks } = splitBlocks(text);
  const block = blocks[hitIndex];
  if (!block) return { text: `No block at index ${hitIndex}. Total: ${blocks.length}.`, found: false };

  const header = block.split("\n", 1)[0];
  const body = block.slice(header.length + 1);
  const slice = body.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, len));
  return {
    text: `${header}\n\`\`\`\n${slice}\n\`\`\`\n_peek offset=${offset} len=${slice.length} of ${body.length} bytes_`,
    found: true,
  };
}

function rejoin(preamble: string, blocks: string[], trailer: string): string {
  const parts: string[] = [];
  if (preamble.trim()) parts.push(preamble);
  if (blocks.length > 0) parts.push(blocks.join("\n\n"));
  if (trailer.trim()) parts.push(trailer);
  return parts.join("\n");
}
