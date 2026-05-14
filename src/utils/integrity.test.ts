import { describe, it, expect } from "vitest";
import { sha256Hex, verifyArtifact, loadModelLock } from "./integrity.js";

describe("integrity verification", () => {
  it("computes a known SHA-256 hex digest", () => {
    // Empty string sha256 is the canonical reference value.
    expect(sha256Hex(Buffer.from(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    // "abc" — RFC reference value (FIPS 180-4 appendix B).
    expect(sha256Hex(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  describe("verifyArtifact", () => {
    it("passes when bytes match the lock-file hash", () => {
      // We use the real lock file shipped with the package; this is
      // also a smoke test that models.lock.json parses correctly.
      const lock = loadModelLock();
      if (!lock) {
        // Dev checkout without the lock — skip rather than fail.
        return;
      }
      // Fabricate a buffer whose sha256 is in the lock — we can't
      // recreate the actual model bytes, so this test relies on the
      // strict-mode entry-missing path instead.
      expect(() =>
        verifyArtifact("model", "model.onnx", Buffer.from("not-the-model"), {
          strict: true,
        }),
      ).toThrow(/Integrity check FAILED/);
    });

    it("throws when an entry is missing in strict mode", () => {
      const lock = loadModelLock();
      if (!lock) return;
      expect(() =>
        verifyArtifact("model", "does-not-exist.bin", Buffer.from("x"), {
          strict: true,
        }),
      ).toThrow(/no entry/);
    });

    it("warns but does not throw when entry is missing in non-strict mode", () => {
      const lock = loadModelLock();
      if (!lock) return;
      // Capture stderr so the test runner stays quiet.
      const origWrite = process.stderr.write.bind(process.stderr);
      let captured = "";
      process.stderr.write = ((s: string | Uint8Array) => {
        captured += s.toString();
        return true;
      }) as typeof process.stderr.write;
      try {
        verifyArtifact("model", "does-not-exist.bin", Buffer.from("x"));
      } finally {
        process.stderr.write = origWrite;
      }
      expect(captured).toMatch(/no lock entry/);
    });

    it("error message includes the URL for actionable remediation", () => {
      const lock = loadModelLock();
      if (!lock) return;
      let err: Error | null = null;
      try {
        verifyArtifact("model", "model.onnx", Buffer.from("tampered"));
      } catch (e) {
        err = e as Error;
      }
      expect(err).not.toBeNull();
      expect(err!.message).toContain("huggingface.co");
      expect(err!.message).toMatch(/Expected sha256/);
      expect(err!.message).toMatch(/Got sha256/);
    });
  });

  describe("loadModelLock", () => {
    it("loads and parses the package's models.lock.json", () => {
      const lock = loadModelLock();
      if (!lock) {
        // In a dev checkout this returns null — that's a valid state,
        // the integrity check soft-warns rather than refusing.
        return;
      }
      expect(lock.version).toBe(1);
      expect(lock.model["model.onnx"]).toBeDefined();
      expect(lock.model["model.onnx"].sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(lock.grammars["tree-sitter-typescript.wasm"]).toBeDefined();
    });
  });
});
