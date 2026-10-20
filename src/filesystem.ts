import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { AgentError } from "./core.js";

export class WorkspaceAdmissionError extends AgentError {
  constructor(message: string) { super("workspace_not_admitted", message,
    "Choose an existing absolute canonical directory within the delegated authority, outside protected state and exact home; do not bypass the boundary using an alias or a broader Git root."); this.name = "WorkspaceAdmissionError"; }
}
export type WorkspaceBoundaries = Readonly<{
  user_home: string;
  protected_roots: readonly Readonly<{ path: string; label: string }>[];
}>;
function accountHome(): string { return realpathSync(userInfo().homedir); }
/** The one owner of the grokpair store base, identical for every calling harness. */
export function stateHome(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.GROKPAIR_HOME ?? join(accountHome(), ".local", "state", "grokpair");
}
/** Agent homes hold credentials, configuration and conversations; none is a workspace. Each is
 * protected at its default location and wherever its variable points, so no host's environment
 * narrows the boundary. */
export function workspaceBoundaries(environment: NodeJS.ProcessEnv = process.env): WorkspaceBoundaries {
  const home = accountHome();
  const homes: [string | undefined, string, string][] = [
    [environment.CODEX_HOME, join(home, ".codex"), "Codex state"],
    [environment.CLAUDE_CONFIG_DIR, join(home, ".claude"), "Claude Code state"],
    [environment.GROK_HOME, join(home, ".grok"), "Grok state"],
    [environment.PI_CODING_AGENT_DIR, join(home, ".pi"), "Pi state"],
    [environment.GROKPAIR_HOME, stateHome({}), "grokpair state"],
  ];
  return { user_home: home, protected_roots: homes.flatMap(([configured, fallback, label]) =>
    [...new Set([fallback, ...(configured ? [configured] : [])])].map(path => ({ path, label }))) };
}
export function containsPath(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}
function normalized(path: string, label: string): string {
  if (!path || path.includes("\0") || !isAbsolute(path) || normalize(path) !== path || resolve(path) !== path) {
    throw new WorkspaceAdmissionError(`${label} must be an absolute normalized path without traversal`);
  }
  return path;
}
function prefixes(path: string): string[] {
  const result = [path];
  while (dirname(result[0]!) !== result[0]) result.unshift(dirname(result[0]!));
  return result;
}
/** Protected roots can be absent or addressed through existing aliases. */
function aliases(path: string, label: string): string[] {
  normalized(path, label);
  let ancestor = path;
  while (true) {
    try {
      const stat = lstatSync(ancestor);
      if (!stat.isDirectory() && !stat.isSymbolicLink()) throw new WorkspaceAdmissionError(`${label} has a non-directory ancestor`);
      return [...new Set([path, join(realpathSync(ancestor), relative(ancestor, path))])];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { if (lstatSync(ancestor).isSymbolicLink()) throw new WorkspaceAdmissionError(`${label} has a dangling alias`); }
      catch (nested) { if ((nested as NodeJS.ErrnoException).code !== "ENOENT") throw nested; }
      if (dirname(ancestor) === ancestor) throw new WorkspaceAdmissionError(`${label} cannot be resolved`);
      ancestor = dirname(ancestor);
    }
  }
}
export function assertCanonicalOwnedDirectoryPath(path: string, label: string): string {
  normalized(path, label);
  if (path === parse(path).root) throw new WorkspaceAdmissionError(`Filesystem root cannot be ${label}`);
  return assertCanonicalDirectoryPath(path, label);
}
/** Canonical directory ancestry, including root as a file's parent; grants no workspace ownership. */
export function assertCanonicalDirectoryPath(path: string, label: string): string {
  normalized(path, label);
  for (const prefix of prefixes(path)) {
    try {
      const stat = lstatSync(prefix);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(prefix) !== prefix) {
        throw new WorkspaceAdmissionError(`${label} must not traverse a symlink or non-directory`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
      throw error;
    }
  }
  return path;
}
export function materializeCanonicalOwnedDirectory(path: string, label: string): string {
  assertCanonicalOwnedDirectoryPath(path, label);
  for (const prefix of prefixes(path).slice(1)) {
    assertCanonicalOwnedDirectoryPath(prefix, label);
    try { mkdirSync(prefix, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    assertCanonicalOwnedDirectoryPath(prefix, label);
  }
  return path;
}
function directory(path: string, label: string): string {
  assertCanonicalOwnedDirectoryPath(path, label);
  try { if (!lstatSync(path).isDirectory()) throw new Error("not a directory"); }
  catch { throw new WorkspaceAdmissionError(`${label} must be an existing canonical directory`); }
  return path;
}
export function validateWorkspace(requested: string, boundaries: WorkspaceBoundaries = workspaceBoundaries()): string {
  const path = directory(requested, "cwd");
  if (aliases(boundaries.user_home, "user home").includes(path)) throw new WorkspaceAdmissionError("The exact user home cannot be cwd");
  for (const root of boundaries.protected_roots) {
    if (aliases(root.path, root.label).some((base) => containsPath(base, path))) {
      throw new WorkspaceAdmissionError(`${root.label} and its descendants cannot be cwd`);
    }
  }
  return path;
}
export const admitWorkspace = validateWorkspace;
export function admitDerivedWorkspaceRoot(path: string, boundaries: WorkspaceBoundaries, label = "Git repository root"): string {
  directory(path, label);
  if (aliases(boundaries.user_home, "user home").some((home) => containsPath(path, home))) {
    throw new WorkspaceAdmissionError(`${label} cannot contain the user home`);
  }
  for (const root of boundaries.protected_roots) {
    if (aliases(root.path, root.label).some((base) => containsPath(base, path) || containsPath(path, base))) {
      throw new WorkspaceAdmissionError(`${label} cannot overlap ${root.label}`);
    }
  }
  return path;
}
/** Native creation alone may admit a tree inside Grok state, never a tree
 * containing a configured or resolved Grok home. All other boundaries remain. */
export function admitNativeWorkspaceRoot(path: string, boundaries: WorkspaceBoundaries): string {
  directory(path, "Native worktree root");
  for (const root of boundaries.protected_roots) {
    if (root.label === "Grok state" && aliases(root.path, root.label).some(base => containsPath(path, base))) {
      throw new WorkspaceAdmissionError("Native worktree root cannot contain the Grok state home");
    }
  }
  return admitDerivedWorkspaceRoot(path, {
    ...boundaries, protected_roots: boundaries.protected_roots.filter(root => root.label !== "Grok state"),
  }, "Native worktree root");
}
