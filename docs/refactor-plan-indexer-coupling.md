# Refactor Plan: Reduce `Indexer` Fan-In Below F Grade

**Status**: ✅ shipped 2026-05-10 in v0.20.13 (Phases 1-2 complete; Phase 3 deferred — concrete Indexer barrel kept for tests + lifecycle owners)

**Outcome**:
- Concrete `Indexer` fan-in: 60 → 15 (F → B)
- Coupling dimension grade: F → C (max fan-in 28 on index-files.ts)
- Overall audit grade: C → A
- 460 tests green; no behavior change
**Owner**: Nikita Groshin
**Created**: 2026-05-09
**Target metric**: `couplingGrade(maxFanIn) ≤ D` (≤ 50), stretch target `B` (≤ 20)
**Audit source**: `src/server/audit-analysis.ts:60` (`couplingGrade`), `audit-analysis.ts:391-426` (`computeMaxFanIn`)

## Problem

`src/indexer/indexer.ts` reports max fan-in **60** in sverklo's own self-audit. That's the
F-grade ceiling and locks the dogfood-PR coupling grade at F. We can't enable
`fail_on: F` in `.github/workflows/audit-self.yml` until this grade is at least D, and the
PR-comment screenshot + `/mcp/` leaderboard both surface the F.

`Indexer` is a god-object: it constructs every store, owns every mutation entry point
(`index`, `reindexFile`, `clearIndex`, `removeFile`, `close`), and exposes 13 store fields
publicly. 54 source files (60 edges) import the class. 53 of those 54 use `import type`
— meaning they need only the structural shape of `Indexer`, not the constructor.

## Audit grade ladder

From `src/server/audit-analysis.ts:60-66`:

| maxFanIn | Grade |
|---|---|
| `< 10` | A |
| `≤ 20` | B |
| `≤ 35` | C |
| `≤ 50` | D |
| `> 50` | F |

To enable `fail_on: F`: reach D (≤50). To go green on every dogfood comment: reach B (≤20).

## Importer inventory (54 unique files; 60 edges)

Member-access tally across non-test consumers:

```
memoryStore: 48     chunkStore: 33     fileStore: 35     graphStore: 24
rootPath:    19     symbolRefStore: 12 embed:     6      getStatus: 8
conceptStore: 9     handleStore: 6     patternStore: 3   memoryJournal: 3
memoryEmbeddingStore: 5  docEdgeStore: 2  evidenceStore: 2  embeddingStore: 2
close: 4            index: 7           clearIndex: 2     embeddingProviderName: 1
embeddingDimensions: 1   getFreshness: 1
```

Bucketed by access pattern:

| Bucket | Files | What they touch |
|---|---|---|
| **Query-read** (search/lookup/refs/audit-render/wiki/digest) | ~33 | fileStore, chunkStore, graphStore, symbolRefStore, docEdgeStore, embed(), rootPath, getStatus(), getFreshness() |
| **Memory-mutate** (remember/forget/pin/prune/evidence/export/import) | ~9 | memoryStore, memoryEmbeddingStore, memoryJournal, embed(), rootPath |
| **Lifecycle/admin** (bin, mcp-server, http-server, indexer-pool, src/index.ts, init.ts) | ~7 | new Indexer(), index(), clearIndex(), close(), reindexFile(), removeFile() |
| **Tests** (`*.test.ts` in `src/`) | ~5 | full surface |

## Approach: split the type surface, keep one implementation

The `Indexer` class stays as the canonical implementation. Move the **interfaces**
consumers depend on into separate small type files. Most consumers (53/54) only
use `import type` — they migrate trivially to a narrower interface.

### Proposed surface split

| Interface file | Members | Expected importers |
|---|---|---|
| `src/indexer/index-files.ts` (`IndexFiles`) | fileStore, chunkStore, rootPath, getStatus() | ~20 (overview, audit-render, wiki, digest) |
| `src/indexer/index-code.ts` (`IndexCode`) | chunkStore, symbolRefStore, docEdgeStore, embed() | ~20 (search, lookup, refs, ast-grep, refs-related tools) |
| `src/indexer/index-graph.ts` (`IndexGraph`) | graphStore, fileStore | ~12 (deps, impact, audit-graph, search/bundle) |
| `src/indexer/index-memory.ts` (`IndexMemory`) | memoryStore, memoryEmbeddingStore, memoryJournal, conceptStore, handleStore, patternStore, evidenceStore, embed(), rootPath | ~12 (memory tools + memory/* modules) |
| `src/indexer/index-admin.ts` (`IndexAdmin`) | index(), reindexFile(), removeFile(), clearIndex(), close(), invalidateFreshnessCache() | ~7 (bin, mcp-server, http-server, indexer-pool, init) |
| `src/indexer/indexer.ts` (concrete `Indexer`) | unchanged; `implements` all of the above | tests (~5), `registry/indexer-pool.ts` (`new Indexer`), `src/index.ts` (barrel) |

After full migration, fan-in distributes:

- `index-files.ts`: ~20 → B
- `index-code.ts`: ~20 → B
- `index-graph.ts`: ~12 → B
- `index-memory.ts`: ~12 → B
- `index-admin.ts`: ~7 → A
- `indexer.ts` (class): ~7 → A

`maxFanIn` over the project: ~20 → grade **B**. That's the stretch target.

## Phased migration

### Phase 0 — POC (✅ done 2026-05-09)

Define one narrow interface (`IndexFiles`) and migrate exactly one consumer (`overview.ts`).
Verify build + tests pass.

- ✅ Added `src/indexer/index-files.ts` exporting `interface IndexFiles { fileStore, chunkStore, rootPath, getStatus() }`
- ✅ `class Indexer implements IndexFiles`
- ✅ `src/server/tools/overview.ts` imports `IndexFiles` instead of `Indexer`
- ✅ Build passes, tests pass

Expected fan-in delta: 60 → 59 on `indexer.ts`; new edge of 1 on `index-files.ts`.

### Phase 1 — Add remaining interfaces (2-3 h)

Create the rest of the interface files. `Indexer implements …` everything. Zero behavior change.

### Phase 2 — Migrate consumers cluster-by-cluster (4-6 h)

Order, each cluster internally consistent:

1. **Read-only tools** (~20 files in `src/server/tools/*`) → `IndexQuery` / `IndexFiles` / `IndexCode`
2. **Audit renderers + wiki** (`src/server/audit-*.ts`, `src/wiki/wiki-generator.ts`, `src/digest.ts`) → same
3. **Search modules** (`src/search/*.ts`) → same
4. **Memory cluster** (`src/server/tools/{remember,forget,pin}.ts`, `src/memory/*.ts`) → `IndexMemory`
5. **Lifecycle clients** (`src/server/{mcp-server,http-server}.ts`) → `IndexAdmin` for type sites; keep value-import where construction happens

After each cluster, run `npm run build && npm test && sverklo audit .` and commit with the
new fan-in number in the message: `refactor(indexer): migrate read-tools cluster (60 → 41)`.

### Phase 3 — Optional: hide concrete class (1 h)

Drop `export class Indexer` from `src/index.ts` (barrel). Re-export only interfaces +
factory `createIndexer(config: ProjectConfig)`. Skip if it would break the public API.

## Effort estimate

| Phase | Effort (h) |
|---|---|
| 0 — POC (1 interface, 1 consumer) | ✅ 0.5 |
| 1 — All interfaces added | 2-3 |
| 2 — Migrate 53 consumers | 4-6 |
| 3 — Hide concrete class (optional) | 1 |
| **Total to grade B** | **7-11 h** |
| **Minimum to grade D** (Phase 0 + bucket-1 only) | **2-3 h** |

## Risk + rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Interface drift — class adds a method, callers expecting it via interface break | Each interface ends with `// keep in sync with class Indexer`; `tsc` catches gaps | Revert per-cluster commit |
| Tests break (they `new Indexer()` and depend on private fields) | Tests keep importing the concrete class — no change | n/a |
| Audit double-counts because both `index-query.ts` and `indexer.ts` are imported from one file | Migrate exhaustively per file | Revert that file |
| `bin/sverklo.ts` 14 dynamic `await import("../src/indexer/indexer.js")` calls — must stay (need constructor) | Leave as-is; these are the only files we *want* coupled | n/a |
| `audit-self.yml` flips `fail_on: F` prematurely and a later commit re-degrades | Add `fail_on: F` only after 2 consecutive PRs measure D or better | Revert workflow change |

## Verification ladder

After each phase:

1. `npm run build` — TypeScript compile clean
2. `npm test` — vitest green
3. `sverklo audit .` — record max fan-in for `indexer.ts` in commit message
4. `sverklo audit . --format json | jq '.grade'` exits with grade ≤ D before flipping `fail_on: F`

## Out of scope

- Splitting the runtime `Indexer` class itself into multiple objects (the stores already
  exist as separate classes; `Indexer` is just the composition root)
- Removing public store fields (would require API redesign — separate plan)
- Changing the audit's fan-in algorithm to ignore type-only edges (masks coupling, separate
  proposal)
