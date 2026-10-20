import type { ContentBlock } from "@agentclientprotocol/sdk";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentError } from "./core.js";
import {
  admitDerivedWorkspaceRoot, admitNativeWorkspaceRoot, assertCanonicalDirectoryPath, assertCanonicalOwnedDirectoryPath, containsPath,
  validateWorkspace, workspaceBoundaries, WorkspaceAdmissionError,
} from "./filesystem.js";
import type { WorkspaceBoundaries } from "./filesystem.js";
import { observeProcess, signalProcess, type ProcessIdentity } from "./process.js";
export { validateWorkspace } from "./filesystem.js";
export type { ContentBlock } from "@agentclientprotocol/sdk";

export type PreparedWorkspacePlan = {
  cwd: string; worktree: boolean; repository?: string; relative_cwd?: string;
};
export type NativeWorkspace = { cwd: string; worktree_root?: string };
export type ProvisionExit = { code: number | null; signal: NodeJS.Signals | null; stderr: string; stderr_truncated: boolean };
export type ProvisionHooks = {
  starting(): void;
  started(identity: ProcessIdentity): void;
  notLaunched(): void;
  returned(path: string): void;
  exited(result: ProvisionExit): void;
  signal?: AbortSignal;
};
function git(cwd: string, args: string[], allowFailure = false): string | null {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" });
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", "-c", "protocol.allow=never", ...args], {
    cwd, env, encoding: "utf8", timeout: 120_000, maxBuffer: Infinity, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    if (allowFailure && !result.error && result.status === 128 && result.stderr.includes("not a git repository")) return null;
    throw new WorkspaceAdmissionError(`Git ${args[0]} failed: ${[result.error?.message, result.stderr].filter(Boolean).join("\n")}`);
  }
  return result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
}
function discoverRepository(cwd: string): { root: string; git_dir: string; common_dir: string } | null {
  const root = git(cwd, ["rev-parse", "--show-toplevel"], true);
  if (root === null) return null;
  if (git(cwd, ["rev-parse", "--is-bare-repository"]) !== "false") throw new WorkspaceAdmissionError("Worktree requires non-bare Git");
  const git_dir = git(cwd, ["rev-parse", "--absolute-git-dir"])!;
  const common_dir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])!;
  for (const path of [root, git_dir, common_dir]) {
    assertCanonicalOwnedDirectoryPath(path, "Git directory");
    if (!lstatSync(path).isDirectory()) throw new WorkspaceAdmissionError("Git discovery must identify existing canonical directories");
  }
  if (!containsPath(root, cwd)) throw new WorkspaceAdmissionError("Git discovery escaped cwd");
  return { root, git_dir, common_dir };
}
function repository(cwd: string, boundaries: WorkspaceBoundaries): ReturnType<typeof discoverRepository> {
  const discovered = discoverRepository(cwd);
  if (discovered) for (const path of [discovered.root, discovered.git_dir, discovered.common_dir]) {
    admitDerivedWorkspaceRoot(path, boundaries, "Git source directory");
  }
  return discovered;
}
/** Ordinary cwd needs no Git; native creation owns source-copy policy. */
export function preflightWorkspace(cwd: string, worktree: boolean,
  boundaries: WorkspaceBoundaries = workspaceBoundaries()): PreparedWorkspacePlan {
  validateWorkspace(cwd, boundaries);
  if (typeof worktree !== "boolean") throw new WorkspaceAdmissionError("worktree must be a boolean");
  if (!worktree) return { cwd, worktree };
  const source = repository(cwd, boundaries);
  if (!source) throw new WorkspaceAdmissionError("Native worktree creation requires an existing Git repository");
  return { cwd, worktree, repository: source.root, relative_cwd: relative(source.root, cwd) };
}

/** Only an admitted native result reaches this route; caller cwd never bypasses admission. */
export function validateNativeWorkspace(plan: PreparedWorkspacePlan, executionCwd: string, worktreeRoot?: string,
  boundaries: WorkspaceBoundaries = workspaceBoundaries()): NativeWorkspace {
  if (!plan.worktree) {
    if (executionCwd !== plan.cwd || worktreeRoot !== undefined) throw new WorkspaceAdmissionError("Execution directory differs from the admitted cwd");
    return { cwd: validateWorkspace(executionCwd, boundaries) };
  }
  if (!plan.repository || typeof plan.relative_cwd !== "string"
      || relative(plan.repository, plan.cwd) !== plan.relative_cwd || !containsPath(plan.repository, plan.cwd)) {
    throw new WorkspaceAdmissionError("Invalid native worktree source plan");
  }
  assertCanonicalOwnedDirectoryPath(executionCwd, "native execution directory");
  if (!lstatSync(executionCwd).isDirectory()) throw new WorkspaceAdmissionError("Native execution directory is missing; preserve the retained worktree reference");
  const native = discoverRepository(executionCwd);
  if (!native) throw new WorkspaceAdmissionError("Native creation returned a non-Git directory");
  if (worktreeRoot !== undefined && native.root !== worktreeRoot) throw new WorkspaceAdmissionError("Retained native worktree root has changed");
  // Native may return the root when its copy policy omitted the caller's suffix.
  if (relative(native.root, executionCwd) !== plan.relative_cwd) throw new WorkspaceAdmissionError("Native creation did not preserve the source-relative cwd; root fallback is not admitted");
  if (containsPath(plan.repository, native.root) || containsPath(native.root, plan.repository)) throw new WorkspaceAdmissionError("Native worktree must remain separate from the source repository");
  // Grok owns native worktrees, including ones under its own protected home.
  // The exception applies only to this observed tree, never arbitrary caller cwd.
  admitNativeWorkspaceRoot(native.root, boundaries);
  for (const path of [native.git_dir, native.common_dir]) {
    if (containsPath(native.root, path)) continue; // Native standalone repository.
    const source = repository(plan.repository, boundaries);
    if (!source || source.root !== plan.repository || !containsPath(source.common_dir, path)) {
      throw new WorkspaceAdmissionError("Native Git metadata does not belong to the returned tree or admitted source repository");
    }
  }
  return { cwd: executionCwd, worktree_root: native.root };
}

/** Run the one native creator under operation custody; never retry, apply or remove its work. */
export async function provisionWorkspace(plan: PreparedWorkspacePlan, sandbox: string | undefined, hooks: ProvisionHooks,
  environment: NodeJS.ProcessEnv = process.env, boundaries: WorkspaceBoundaries = workspaceBoundaries(environment)): Promise<NativeWorkspace> {
  const current = preflightWorkspace(plan.cwd, plan.worktree, boundaries);
  if (current.repository !== plan.repository || current.relative_cwd !== plan.relative_cwd) throw new WorkspaceAdmissionError("Git source changed before native worktree creation");
  if (!plan.worktree) return { cwd: plan.cwd };
  if (sandbox !== undefined && !sandbox.trim()) throw new WorkspaceAdmissionError("sandbox must be a nonempty native profile name");
  hooks.signal?.throwIfAborted();
  hooks.starting();
  let child: ReturnType<typeof spawn>;
  try { child = spawn("grok", ["--cwd", plan.cwd, ...(sandbox === undefined ? [] : ["--sandbox", sandbox]), "worktree", "create"], { cwd: plan.cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { hooks.notLaunched(); throw error; }
  let stdout = "", stderr = Buffer.alloc(0), stderrTruncated = false, returned: string | undefined;
  let identity: ProcessIdentity | undefined, processError: unknown, callbackError: unknown, cancelError: unknown;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const callback = (action: () => void) => { try { action(); } catch (error) { callbackError ??= error; } };
  const retainReturned = () => {
    const path = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
    if (path && path !== returned) { returned = path; callback(() => hooks.returned(path)); }
  };
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (data: string) => { stdout += data; if (stdout.endsWith("\n")) retainReturned(); });
  child.stderr!.on("data", (data: Buffer) => {
    const remaining = 64 * 1024 - stderr.length;
    if (data.length > remaining) stderrTruncated = true;
    if (remaining > 0) stderr = Buffer.concat([stderr, data.subarray(0, remaining)]);
  });
  const cancel = () => {
    if (!identity) { cancelError = new Error("Cannot cancel native creation without an observed process identity"); return; }
    try {
      signalProcess(identity, "SIGTERM");
      killTimer = setTimeout(() => { try { signalProcess(identity!, "SIGKILL"); } catch (error) { cancelError ??= error; } }, 3_000);
    } catch (error) { cancelError = error; }
  };
  const exit = await new Promise<ProvisionExit>(resolveExit => {
    child.once("error", error => {
      processError = error;
      if (child.pid === undefined) callback(() => hooks.notLaunched());
    });
    child.once("close", (code, signal) => {
      clearTimeout(killTimer); hooks.signal?.removeEventListener("abort", cancel); retainReturned();
      resolveExit({ code, signal, stderr: stderr.toString("utf8"), stderr_truncated: stderrTruncated });
    });
    if (child.pid !== undefined) {
      const observed = observeProcess(child.pid);
      if (observed.status === "observed") { identity = observed.identity; callback(() => hooks.started(identity!)); }
      else processError = new Error("Native creation process identity could not be observed");
    }
    hooks.signal?.addEventListener("abort", cancel, { once: true });
    if (hooks.signal?.aborted || callbackError) cancel();
  });
  callback(() => hooks.exited(exit));
  const details = { process: { code: exit.code, signal: exit.signal }, stderr: exit.stderr, stderr_truncated: exit.stderr_truncated,
    ...(returned === undefined ? {} : { returned_cwd: returned }), ...(cancelError ? { cancellation_error: String(cancelError) } : {}) };
  if (processError || callbackError || hooks.signal?.aborted || exit.code !== 0) {
    throw new AgentError("native_worktree_failed", exit.stderr || String(callbackError ?? processError ?? "Native worktree creation did not complete"),
      "Inspect native diagnostics and retained provisioning effects. Preserve any returned directory; do not retry creation or relax the sandbox automatically.", details);
  }
  if (returned === undefined) throw new AgentError("native_worktree_result_unknown", "Native creation exited without a returned directory; creation effects remain unknown",
    "Use native public worktree discovery to reconcile existing work; do not repeat creation blindly.", details);
  try { return validateNativeWorkspace(plan, returned, undefined, boundaries); }
  catch (error) { throw new AgentError("native_worktree_not_admitted", error instanceof Error ? error.message : String(error),
    "Inspect the retained native directory and diagnostic; do not run in the source or a fallback root, recreate or delete the worktree.", details); }
}

export type AttachmentInput = { path: string; kind: "reference" | "image" };
export type PreparedAttachment =
  | { path: string; kind: "reference"; bytes: number }
  | { path: string; kind: "image"; mime_type: string; bytes: number };
export type PreparedAttachments = { blocks: ContentBlock[]; inputs: PreparedAttachment[] };
export class AttachmentError extends AgentError {
  constructor(message: string) { super("attachment_not_admitted", message,
    "Inspect the indexed path/kind and cause; supply an accessible canonical regular file within the brief's authority. For image input supply recognized image bytes, or deliberately choose reference in a new request. Queued references require a new follow_up, not replacement by edit. Preserve already admitted operations and their effects."); this.name = "AttachmentError"; }
}
function fail(message: string): never { throw new AttachmentError(message); }
const imageMimes = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/tiff", "image/x-icon"];
function validPath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && !path.includes("\0")
    && !/[\uD800-\uDFFF]/u.test(path) && isAbsolute(path) && normalize(path) === path && resolve(path) === path;
}
/** This inspects retained metadata only, never current files or replacement input. */
export function assertQueuedEditInput(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !Object.hasOwn(value, "attachments")) fail("Queued edit requires known prepared attachment input");
  const attachments = (value as Record<string, unknown>).attachments;
  if (!Array.isArray(attachments)) fail("Queued edit attachment input is malformed");
  for (const [index, entry] of attachments.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`Queued edit attachments[${index}] is unknown or malformed; use a new follow_up`);
    const record = entry as Record<string, unknown>;
    if (record.kind !== "image") fail(`Queued edit attachments[${index}] path=${JSON.stringify(record.path)} kind=${JSON.stringify(record.kind)} cannot retain non-image or unknown inputs; use a new follow_up`);
    if (Object.keys(record).length !== 4 || !["path", "kind", "mime_type", "bytes"].every(key => Object.hasOwn(record, key))
        || !validPath(record.path) || typeof record.mime_type !== "string" || !imageMimes.includes(record.mime_type)
        || typeof record.bytes !== "number" || !Number.isSafeInteger(record.bytes) || record.bytes < 0) {
      fail(`Queued edit attachments[${index}] path=${JSON.stringify(record.path)} kind="image" has malformed retained metadata; use a new follow_up`);
    }
  }
}
function describeError(input: AttachmentInput, index: number, error: unknown): AttachmentError {
  const cause = error instanceof Error ? error.message : String(error);
  return new AttachmentError(`attachments[${index}] path=${JSON.stringify(input?.path)} kind=${JSON.stringify(input?.kind)}: ${cause}`);
}
function inspectAttachment(input: AttachmentInput): BigIntStats {
  if (!input || (input.kind !== "reference" && input.kind !== "image")) fail("kind must explicitly be reference or image");
  if (!validPath(input.path)) fail("Path must be absolute, normalized, and valid Unicode without NUL or unpaired surrogates");
  assertCanonicalDirectoryPath(dirname(input.path), "attachment parent");
  const named = lstatSync(input.path, { bigint: true });
  if (!named.isFile() || named.isSymbolicLink() || realpathSync(input.path) !== input.path) fail("Attachment must be a canonical regular file without symlinks");
  return named;
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return b.isFile() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function recheck(input: AttachmentInput, before: BigIntStats, current: BigIntStats): void {
  if (!same(before, current) || !same(before, inspectAttachment(input))) fail("File identity or metadata changed during attachment preparation; stabilize the file before a new request");
}
const openFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/** References read no bytes; images must have a recognized signature before admission. */
export function preflightAttachments(inputs: readonly AttachmentInput[]): void {
  for (const [index, input] of inputs.entries()) {
    try {
      const named = inspectAttachment(input);
      const fd = openSync(input.path, openFlags);
      try {
        recheck(input, named, fstatSync(fd, { bigint: true }));
        if (input.kind === "image") {
          const header = Buffer.alloc(14);
          let used = 0;
          while (used < header.length) {
            const count = readSync(fd, header, used, header.length - used, used);
            if (!count) break;
            used += count;
          }
          imageMime(header.subarray(0, used));
          recheck(input, named, fstatSync(fd, { bigint: true }));
        }
      }
      finally { closeSync(fd); }
    } catch (error) { throw describeError(input, index, error); }
  }
}
function imageMime(data: Buffer): string {
  const ascii = (start: number, end: number) => data.subarray(start, end).toString("ascii");
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (data.length >= 14 && ascii(0, 2) === "BM") return "image/bmp";
  if (data.length >= 8 && (data.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) || data.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42])))) return "image/tiff";
  if (data.length >= 6 && data[0] === 0 && data[1] === 0 && data[2] === 1 && data[3] === 0) return "image/x-icon";
  return fail("Unrecognized image bytes; expected PNG, JPEG, WebP, GIF, BMP, TIFF or ICO. No conversion or automatic reference fallback was attempted");
}
/** Reuses one bounded binary buffer. Only base64 text grows; native owns image decoding/conversion. */
async function encodeImage(handle: FileHandle): Promise<{ data: string; mimeType: string }> {
  const buffer = Buffer.allocUnsafe(192 * 1024); // Multiple of three: intermediate base64 chunks need no padding.
  const chunks: string[] = [];
  let mimeType: string | undefined;
  let ended = false;
  while (!ended) {
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) { ended = true; break; }
      used += bytesRead;
    }
    if (mimeType === undefined) mimeType = imageMime(buffer.subarray(0, used));
    if (used) chunks.push(buffer.subarray(0, used).toString("base64"));
  }
  return { data: chunks.join(""), mimeType: mimeType! };
}
function jsonPath(path: string): string {
  return JSON.stringify(path).replace(/[<>&]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
/** Worker preparation is separate from admission. References never read, embed or stage file contents. */
export async function prepareAttachments(paths: readonly AttachmentInput[]): Promise<PreparedAttachments> {
  const inputs: PreparedAttachment[] = [], blocks: ContentBlock[] = [];
  for (const [index, input] of paths.entries()) {
    try {
      const named = inspectAttachment(input);
      const handle = await open(input.path, openFlags);
      try {
        recheck(input, named, await handle.stat({ bigint: true }));
        if (input.kind === "reference") {
          blocks.push({ type: "resource_link", uri: pathToFileURL(input.path).href,
            name: "Local file path (JSON string): " + jsonPath(input.path), _meta: {} });
          inputs.push({ path: input.path, kind: "reference", bytes: Number(named.size) });
        } else {
          const encoded = await encodeImage(handle);
          blocks.push({ type: "image", ...encoded });
          inputs.push({ path: input.path, kind: "image", mime_type: encoded.mimeType, bytes: Number(named.size) });
        }
        recheck(input, named, await handle.stat({ bigint: true }));
      } finally { await handle.close(); }
    } catch (error) { throw describeError(input, index, error); }
  }
  return { blocks, inputs };
}
