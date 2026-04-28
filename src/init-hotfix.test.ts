import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentsFileTarget, findInstructionFile } from "./init.js";

describe("init — v0.18.1 hotfix (findings 6, 7, 12)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sverklo-init-hotfix-"));
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("Finding 6: findInstructionFile is case-insensitive (Linux Agents.md)", () => {
    writeFileSync(join(tmp, "Agents.md"), "# project rules\n");
    const result = findInstructionFile(tmp, "AGENTS.md");
    expect(result.exists).toBe(true);
    // Returns the actual cased path on disk, not our requested name.
    expect(result.path.endsWith("Agents.md")).toBe(true);
    expect(result.content).toContain("project rules");
  });

  it("Finding 6: returns exists=false when no case-variant exists", () => {
    const result = findInstructionFile(tmp, "AGENTS.md");
    expect(result.exists).toBe(false);
    expect(result.content).toBe("");
  });

  it("Finding 6: handles unreadable directory without throwing", () => {
    const result = findInstructionFile("/nonexistent-path-xyzzy", "AGENTS.md");
    expect(result.exists).toBe(false);
  });

  it("Finding 7: re-running init detects an existing snippet by `## Sverklo` heading even after sentinel removed", () => {
    // User ran sverklo init, then hand-edited the body to remove the
    // explicit `sverklo_search` line — but kept the `## Sverklo` heading.
    const handEditedContent = `# Project rules

## Sverklo — Code Intelligence

(I removed the canned bullets but kept the heading because I want to write my own.)
`;
    const result = resolveAgentsFileTarget({
      projectPath: "/p",
      claudeMd: { exists: true, content: handEditedContent, path: "/p/CLAUDE.md" },
      agentsMd: { exists: false, content: "", path: "/p/AGENTS.md" },
      sentinel: "sverklo_search",
    });
    expect(result.action).toBe("skip");
    if (result.action !== "skip") return;
    expect(result.fileName).toBe("CLAUDE.md");
  });

  it("Finding 7: heading detection only fires on H2 — bare `Sverklo` mention doesn't trigger", () => {
    const result = resolveAgentsFileTarget({
      projectPath: "/p",
      claudeMd: {
        exists: true,
        content: "I love Sverklo!\nUse `sverklo` here and there.\n",
        path: "/p/CLAUDE.md",
      },
      agentsMd: { exists: false, content: "", path: "/p/AGENTS.md" },
      sentinel: "sverklo_search",
    });
    // Should APPEND, not skip — there's no `## Sverklo` heading.
    expect(result.action).toBe("append");
  });

  it("Finding 12: empty AGENTS.md does NOT beat populated CLAUDE.md", () => {
    const result = resolveAgentsFileTarget({
      projectPath: "/p",
      claudeMd: {
        exists: true,
        content: "# Detailed project rules\n\nThis is where I keep instructions.\n",
        path: "/p/CLAUDE.md",
      },
      agentsMd: { exists: true, content: "", path: "/p/AGENTS.md" },
      sentinel: "sverklo_search",
    });
    expect(result.action).toBe("append");
    if (result.action !== "append") return;
    expect(result.fileName).toBe("CLAUDE.md");
  });

  it("Finding 12: whitespace-only AGENTS.md also doesn't beat populated CLAUDE.md", () => {
    const result = resolveAgentsFileTarget({
      projectPath: "/p",
      claudeMd: { exists: true, content: "real instructions\n", path: "/p/CLAUDE.md" },
      agentsMd: { exists: true, content: "   \n\t\n  \n", path: "/p/AGENTS.md" },
      sentinel: "sverklo_search",
    });
    expect(result.action).toBe("append");
    if (result.action !== "append") return;
    expect(result.fileName).toBe("CLAUDE.md");
  });

  it("Finding 12: empty AGENTS.md AND no CLAUDE.md still goes to AGENTS.md (universal default)", () => {
    const result = resolveAgentsFileTarget({
      projectPath: "/p",
      claudeMd: { exists: false, content: "", path: "/p/CLAUDE.md" },
      agentsMd: { exists: true, content: "", path: "/p/AGENTS.md" },
      sentinel: "sverklo_search",
    });
    expect(result.action).toBe("append");
    if (result.action !== "append") return;
    expect(result.fileName).toBe("AGENTS.md");
  });

  it("Finding 12: populated AGENTS.md still wins over populated CLAUDE.md (existing behavior preserved)", () => {
    const result = resolveAgentsFileTarget({
      projectPath: "/p",
      claudeMd: { exists: true, content: "claude rules\n", path: "/p/CLAUDE.md" },
      agentsMd: { exists: true, content: "agents rules\n", path: "/p/AGENTS.md" },
      sentinel: "sverklo_search",
    });
    expect(result.action).toBe("append");
    if (result.action !== "append") return;
    expect(result.fileName).toBe("AGENTS.md");
  });
});
