# Diff Review: `cc763bc^..cc763bc`

**6 files changed** (8 added, 5 removed, 4 modified)

## Changed files
- **M** `.gitignore` +6 -0 · 🟡 risk 32 (medium)
- **M** `src/indexer/grammars-install.ts` +5 -0 (PR 1.00) · 🟡 risk 32 (medium)
- **A** `src/indexer/parser-csharp.test.ts` +379 -0 (PR 1.00) · 🟡 risk 40 (medium)
- **M** `src/indexer/parser-tree-sitter.ts` +29 -0 (PR 1.00) · 🟡 risk 34 (medium)
- **M** `src/indexer/parser.ts` +85 -0 (PR 1.00) ← 1 importer · 🟡 risk 35 (medium)
- **M** `src/types/index.ts` +1 -0 (PR 1.00) ← 4 importers · 🟠 risk 55 (high)

## ⚠️ Highest-risk files
_Risk score combines: untested, security-sensitive paths, fan-in, caller count, dangling refs, churn._
- 🟠 risk 55 (high) `src/types/index.ts`
  _no matching tests; touches security-sensitive surface_

## Removed symbols
- ✓ `initFn` (function) @ src/indexer/parser-tree-sitter.ts:119 — 0 dangling refs (safe to remove)
- ⚠️ `parseJava` (function) @ src/indexer/parser.ts:600 — **2 dangling references** in 1 file
    · src/indexer/parser.ts
- ⚠️ `parseRuby` (function) @ src/indexer/parser.ts:669 — **2 dangling references** in 1 file
    · src/indexer/parser.ts
- ⚠️ `parseSwift` (function) @ src/indexer/parser.ts:828 — **2 dangling references** in 1 file
    · src/indexer/parser.ts
- ⚠️ `parseElixir` (function) @ src/indexer/parser.ts:919 — **2 dangling references** in 1 file
    · src/indexer/parser.ts

**⚠️ 4 removed symbols have remaining references — review carefully.**

## Added symbols
- `_module` (module) @ src/indexer/grammars-install.ts:1
- `dedent` (function) @ src/indexer/parser-csharp.test.ts:4
- `parse` (function) @ src/indexer/parser-csharp.test.ts:14
- `Baz` (class) @ src/indexer/parser-csharp.test.ts:25
- `Baz` (class) @ src/indexer/parser-csharp.test.ts:38
- `_module` (module) @ src/indexer/parser-tree-sitter.ts:1
- `_module` (module) @ src/indexer/parser.ts:6
- `parseCSharp` (function) @ src/indexer/parser.ts:639

### ⚠️ Possible duplicates
- **_module** added in `src/indexer/grammars-install.ts` — already exists in:
    · benchmark/benchmark.ts:1
    · benchmark/src/baselines/base.ts:3
    · benchmark/src/baselines/naive-grep.ts:7
- **_module** added in `src/indexer/parser-tree-sitter.ts` — already exists in:
    · benchmark/benchmark.ts:1
    · benchmark/src/baselines/base.ts:3
    · benchmark/src/baselines/naive-grep.ts:7
- **_module** added in `src/indexer/parser.ts` — already exists in:
    · benchmark/benchmark.ts:1
    · benchmark/src/baselines/base.ts:3
    · benchmark/src/baselines/naive-grep.ts:7

## High-impact modifications
_These files are imported by many others — changes cascade widely._
- `src/types/index.ts` ← 4 importers

## ⚠️ Structural warnings
_These are heuristic matches over the diff text. Some may be false positives; each finding carries a short explanation so you can triage quickly._
### unguarded-stream-call (11)
- 🟡 `src/indexer/parser-csharp.test.ts:14` — New call inside a stream pipeline with no visible try-catch in the hunk. A single RuntimeException on one element will abort the entire pipeline — on a production read path this is an outage. Wrap the lambda body in try-catch or pre-filter elements that could throw.
    `function parse(cs: string) {`
- 🟡 `src/indexer/parser-csharp.test.ts:191` — New call inside a stream pipeline with no visible try-catch in the hunk. A single RuntimeException on one element will abort the entire pipeline — on a production read path this is an outage. Wrap the lambda body in try-catch or pre-filter elements that could throw.
    `expect(methods).toHaveLength(0);`
- 🟡 `src/indexer/parser-csharp.test.ts:213` — New call inside a stream pipeline with no visible try-catch in the hunk. A single RuntimeException on one element will abort the entire pipeline — on a production read path this is an outage. Wrap the lambda body in try-catch or pre-filter elements that could throw.
    `expect(names).not.toContain("if");`
- 🟡 `src/indexer/parser-csharp.test.ts:227` — New call inside a stream pipeline with no visible try-catch in the hunk. A single RuntimeException on one element will abort the entire pipeline — on a production read path this is an outage. Wrap the lambda body in try-catch or pre-filter elements that could throw.
    `expect(methods).toHaveLength(0);`
- 🟡 `src/indexer/parser-csharp.test.ts:236` — New call inside a stream pipeline with no visible try-catch in the hunk. A single RuntimeException on one element will abort the entire pipeline — on a production read path this is an outage. Wrap the lambda body in try-catch or pre-filter elements that could throw.
    `expect(methods).toHaveLength(0);`
- 🟡 `src/indexer/parser-csharp.test.ts:245` — New call inside a stream pipeline with no visible try-catch in the hunk. A single RuntimeException on one element will abort the entire pipeline — on a production read path this is an outage. Wrap the lambda body in try-catch or pre-filter elements that could throw.
    `expect(methods).toHaveLength(0);`
  _...and 5 more_

## Suggested next checks
- Run `sverklo_impact symbol:"parseJava"` to see all callers of removed symbols
- Run `sverklo_diff_search query:"..."` to search semantically within these files
- For exact-match checks, fall back to `grep -r 'symbol' .`
