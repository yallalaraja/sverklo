import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { validateWorkspaceName } from "./utils/workspace-name.js";

export interface WorkspaceConfig {
  name: string;
  repos: {
    path: string;
    alias?: string;
  }[];
}

const WORKSPACE_DIR = join(homedir(), ".sverklo", "workspaces");

function getWorkspacePath(name: string): string {
  validateWorkspaceName(name);
  return join(WORKSPACE_DIR, name + ".json");
}

// Repo-path validation. `resolve()` alone is lexical — it doesn't follow
// symlinks, so a symlinked `repo` inside a "safe" parent escapes naive
// prefix checks. We use realpathSync to canonicalize, then refuse paths
// inside well-known sensitive directories. The path must also exist;
// non-existent paths can't be indexed and are usually typos worth
// surfacing as errors at registration time.
// Computed lazily so tests can stub HOME. Both the raw `join(home, ...)`
// form AND the realpath-canonicalized form are returned, because on
// macOS `/tmp` resolves to `/private/tmp` via symlink — a sensitive dir
// under a symlinked HOME would fail to match if we only compared one form.
function sensitivePrefixes(): string[] {
  const home = homedir();
  const homeReal = (() => {
    try {
      return realpathSync(home);
    } catch {
      return home;
    }
  })();
  const dirs = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".sverklo"];
  const out = new Set<string>();
  for (const d of dirs) {
    out.add(join(home, d));
    out.add(join(homeReal, d));
  }
  return [...out];
}

function validateRepoPath(repoPath: string): string {
  let realPath: string;
  try {
    realPath = realpathSync(resolve(repoPath));
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === "ENOENT") {
      throw new Error(`Repo path does not exist: ${repoPath}`);
    }
    throw new Error(`Failed to resolve repo path "${repoPath}": ${e.message ?? String(err)}`);
  }
  for (const sensitive of sensitivePrefixes()) {
    if (realPath === sensitive || realPath.startsWith(sensitive + sep)) {
      throw new Error(
        `Refusing to register a workspace repo inside ${sensitive}. ` +
          `If this was intentional, file an issue — we'd rather get a request than leak credentials.`
      );
    }
  }
  return realPath;
}

export function listWorkspaces(): string[] {
  if (!existsSync(WORKSPACE_DIR)) return [];
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  return readdirSync(WORKSPACE_DIR)
    .filter((f: string) => f.endsWith(".json"))
    .map((f: string) => f.replace(/\.json$/, ""));
}

export function loadWorkspace(name: string): WorkspaceConfig | null {
  const path = getWorkspacePath(name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as WorkspaceConfig;
  } catch {
    return null;
  }
}

export function saveWorkspace(config: WorkspaceConfig): void {
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  writeFileSync(getWorkspacePath(config.name), JSON.stringify(config, null, 2) + "\n");
}

export function createWorkspace(name: string, repoPaths: string[]): WorkspaceConfig {
  validateWorkspaceName(name);
  const config: WorkspaceConfig = {
    name,
    repos: repoPaths.map((p) => ({ path: validateRepoPath(p) })),
  };
  saveWorkspace(config);
  return config;
}

export function addRepoToWorkspace(name: string, repoPath: string, alias?: string): WorkspaceConfig {
  validateWorkspaceName(name);
  let config = loadWorkspace(name);
  if (!config) {
    config = { name, repos: [] };
  }
  const absPath = validateRepoPath(repoPath);
  if (!config.repos.some((r) => r.path === absPath)) {
    config.repos.push({ path: absPath, alias });
    saveWorkspace(config);
  }
  return config;
}

export function removeRepoFromWorkspace(name: string, repoPath: string): WorkspaceConfig | null {
  validateWorkspaceName(name);
  const config = loadWorkspace(name);
  if (!config) return null;
  // For removal, use lexical resolve (the user may want to remove a path
  // that no longer exists on disk). validateRepoPath would refuse that.
  const absPath = resolve(repoPath);
  config.repos = config.repos.filter((r) => r.path !== absPath);
  saveWorkspace(config);
  return config;
}
