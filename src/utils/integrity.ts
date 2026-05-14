import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Integrity verification for bytes downloaded on first run. Reads
 * models.lock.json from the package root and compares SHA-256 of the
 * fetched buffer against the recorded hash.
 *
 * Why: sverklo claims "code never leaves the machine," but the bytes
 * that INTERPRET your code (the ONNX embedding model + every
 * tree-sitter grammar WASM) are downloaded from third-party CDNs on
 * first run. A CDN compromise or DNS hijack at install time would
 * land attacker bytes into onnxruntime / web-tree-sitter. Architectural
 * review 2026-05-13 (Tier 3.2) flagged this as a HIGH severity gap.
 *
 * The 4-byte WASM magic check that grammars-install.ts already had is
 * a shape check, not an authenticity check — a malicious WASM still
 * starts with `\0asm`.
 */

interface ModelLock {
  version: number;
  model: Record<string, { url: string; sha256: string; bytes?: number }>;
  grammars: Record<string, { url: string; sha256: string }>;
}

let cachedLock: ModelLock | null = null;

/** Locate models.lock.json relative to this file. */
function findLockFile(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // dev: src/utils/integrity.ts → models.lock.json at ../../
  // prod: dist/src/utils/integrity.js → models.lock.json at ../../../
  const candidates = [
    join(here, "..", "..", "models.lock.json"),
    join(here, "..", "..", "..", "models.lock.json"),
    join(here, "..", "..", "..", "..", "models.lock.json"),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

export function loadModelLock(): ModelLock | null {
  if (cachedLock) return cachedLock;
  const path = findLockFile();
  if (!path) return null;
  try {
    cachedLock = JSON.parse(readFileSync(path, "utf-8")) as ModelLock;
    return cachedLock;
  } catch {
    return null;
  }
}

/**
 * Compute SHA-256 of a buffer, hex-encoded lowercase.
 */
export function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Verify downloaded bytes match the recorded hash. Throws on mismatch
 * with a clear, user-actionable remediation message.
 *
 * If the lock file isn't present (dev checkout, mis-packaged install)
 * this is a soft warning, not a refusal — but we log a one-liner to
 * stderr so the gap is visible.
 */
export function verifyArtifact(
  category: "model" | "grammars",
  filename: string,
  buf: Buffer | Uint8Array,
  options: { strict?: boolean; allowMissingLock?: boolean } = {},
): void {
  const lock = loadModelLock();
  if (!lock) {
    if (options.allowMissingLock !== false) {
      process.stderr.write(
        `[sverklo] integrity: models.lock.json not found; cannot verify ${filename}. ` +
          `Reinstall sverklo if you want integrity-checked artifact downloads.\n`,
      );
      return;
    }
    throw new Error(
      `models.lock.json not found; refusing to write ${filename} without integrity check`,
    );
  }

  const section = lock[category];
  const entry = section?.[filename];
  if (!entry) {
    if (options.strict) {
      throw new Error(
        `models.lock.json has no entry for ${category}/${filename}; refusing to write`,
      );
    }
    process.stderr.write(
      `[sverklo] integrity: no lock entry for ${category}/${filename} — writing unverified\n`,
    );
    return;
  }

  const actual = sha256Hex(buf);
  if (actual !== entry.sha256) {
    throw new Error(
      `Integrity check FAILED for ${filename}.\n` +
        `  Expected sha256: ${entry.sha256}\n` +
        `  Got sha256:      ${actual}\n` +
        `  Source URL:      ${entry.url}\n` +
        `\nThe downloaded bytes do not match the recorded hash. This means either:\n` +
        `  1. The upstream artifact was updated — file an issue at github.com/sverklo/sverklo so we can re-pin.\n` +
        `  2. The download was tampered with — CDN compromise, MITM, or DNS hijack.\n` +
        `\nRefusing to write ${filename} to disk.`,
    );
  }
}
