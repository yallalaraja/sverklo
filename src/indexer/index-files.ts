import type { FileStore } from "../storage/file-store.js";
import type { ChunkStore } from "../storage/chunk-store.js";
import type { IndexStatus } from "../types/index.js";

/**
 * Read-only file/chunk surface of the Indexer.
 *
 * Why this interface exists:
 *
 *   sverklo's own audit reports max fan-in 60 on src/indexer/indexer.ts —
 *   54 files import the Indexer class. That's an F coupling grade and
 *   blocks `fail_on: F` in audit-self.yml.
 *
 *   53 of those 54 importers use `import type` (they need the structural
 *   shape of Indexer, not the constructor). Splitting the type surface
 *   into narrower interfaces lets consumers depend on the slice they
 *   actually use, dropping per-file fan-in below the F threshold.
 *
 * What this interface covers:
 *
 *   The "list files and their chunks" slice — used by the codebase-overview
 *   path (sverklo_overview), audit renderers, the wiki generator, and the
 *   digest command. Read-only; no mutation.
 *
 * Keep in sync with `class Indexer` in indexer.ts. The class implements
 * this interface explicitly, so a method removed there breaks consumers
 * at compile time. Full plan: docs/refactor-plan-indexer-coupling.md.
 */
export interface IndexFiles {
  readonly fileStore: FileStore;
  readonly chunkStore: ChunkStore;
  readonly rootPath: string;
  getStatus(): IndexStatus;
}
