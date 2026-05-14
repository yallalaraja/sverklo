import { describe, it, expect } from "vitest";
import { validateWorkspaceName, isValidWorkspaceName } from "./workspace-name.js";

describe("workspace-name validator", () => {
  describe("rejects path-escape attempts", () => {
    it("rejects `..`", () => {
      expect(() => validateWorkspaceName("..")).toThrow();
      expect(isValidWorkspaceName("..")).toBe(false);
    });

    it("rejects `.`", () => {
      expect(() => validateWorkspaceName(".")).toThrow();
    });

    it("rejects strings containing `..`", () => {
      expect(() => validateWorkspaceName("foo..bar")).toThrow();
      expect(() => validateWorkspaceName("../etc")).toThrow();
      expect(() => validateWorkspaceName("../../tmp")).toThrow();
    });

    it("rejects leading `.`", () => {
      expect(() => validateWorkspaceName(".hidden")).toThrow();
    });

    it("rejects path separators", () => {
      expect(() => validateWorkspaceName("foo/bar")).toThrow();
      expect(() => validateWorkspaceName("foo\\bar")).toThrow();
    });

    it("rejects shell metacharacters", () => {
      expect(() => validateWorkspaceName("foo;rm")).toThrow();
      expect(() => validateWorkspaceName("foo`cmd`")).toThrow();
      expect(() => validateWorkspaceName("foo$bar")).toThrow();
      expect(() => validateWorkspaceName("foo bar")).toThrow();
    });

    it("rejects empty string", () => {
      expect(() => validateWorkspaceName("")).toThrow();
    });

    it("rejects strings >64 chars", () => {
      expect(() => validateWorkspaceName("a".repeat(65))).toThrow();
    });
  });

  describe("accepts well-formed names", () => {
    it("accepts simple alphanumeric", () => {
      expect(isValidWorkspaceName("team-platform")).toBe(true);
      expect(isValidWorkspaceName("api_v2")).toBe(true);
      expect(isValidWorkspaceName("ProjectName123")).toBe(true);
    });

    it("accepts a 1-char name", () => {
      expect(isValidWorkspaceName("a")).toBe(true);
    });

    it("accepts a 64-char name", () => {
      expect(isValidWorkspaceName("a".repeat(64))).toBe(true);
    });

    it("validateWorkspaceName does not throw on valid input", () => {
      expect(() => validateWorkspaceName("ok-name")).not.toThrow();
    });
  });
});
