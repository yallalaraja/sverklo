// Workspace name validation. Must be a single-segment identifier — no path
// separators, no `..`, no leading `.`, conservative character class.
//
// Why this lives in src/utils/ rather than alongside one of the workspace
// modules: there are two parallel workspace systems (legacy JSON in
// src/workspace.ts, newer YAML in src/workspace/workspace-config.ts) plus
// the workspace-scoped memory store in src/workspace/memory.ts. Each one
// flows `name` from CLI argv / MCP tool args into a path-join. v0.20.20
// hardened only the JSON side; the YAML and memory sides regressed
// because the validator wasn't shared. Architectural review on
// 2026-05-13 flagged both paths as CRITICAL path-escape vulnerabilities
// reachable from user input.
//
// Centralizing here so a future workspace surface (e.g. workspace memory
// scopes, workspace import/export) inherits the same rule by import,
// not by copy-paste.

export const WORKSPACE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidWorkspaceName(name: string): boolean {
  return WORKSPACE_NAME_RE.test(name);
}

export function validateWorkspaceName(name: string): void {
  if (!isValidWorkspaceName(name)) {
    throw new Error(
      `Invalid workspace name "${name}". Must be 1-64 chars, [a-zA-Z0-9_-] only ` +
        `(no path separators, no dots, no spaces).`,
    );
  }
}
