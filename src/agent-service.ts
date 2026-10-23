import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { AgentError, failure, id, now, PUBLIC_SCHEMA_VERSION } from "./core.js";
import { normalizedSpawnRequest, parseToolInput, type ToolName, type SpawnInput, type SendInput, type ReadInput, type ListInput, type WaitInput } from "./agent-schema.js";
import { AgentStore, KeyRegistry, listAgentIds, promptActivity, removedFromQueue, type AgentMeta, type JsonRecord, type StoredRecord } from "./agent-store.js";
import { summarizeAgent, type AgentSummary } from "./agent-state.js";
import { observeProcess, type ProcessIdentity } from "./process.js";
import { validateWorkspace, workspaceBoundaries } from "./filesystem.js";
import { assertQueuedEditInput, preflightWorkspace, preflightAttachments, validateNativeWorkspace, type PreparedWorkspacePlan } from "./workspace.js";
import { validateAttentionResponse, type Attention as NativeAttention } from "./attention.js";

type Status = AgentSummary["status"];
export type View = "result" | "records";
type Cursor = { v: 1; view: View; agent_id: string; after: number; seq: number; offset: number; wake: number; more: boolean; status: Status; prompt_id?: string; fragment?: number };
type ProjectionOptions = { cursor?: string | undefined; prompt_id?: string | undefined; max_chars?: number | undefined; view?: View | undefined };
export type AgentView = JsonRecord & { agent_id: string; status: Status; cursor: string | null; has_more: boolean };
const states = new Set<Status>(["starting", "working", "attention", "ready", "idle", "disconnected", "closed", "unavailable"]);
/** Statuses in which a collaborator runs nothing further without the caller. */
const SETTLED = new Set<Status>(["ready", "idle", "attention", "disconnected", "closed", "unavailable"]);
const CURSOR = "gp1.", LIST_CURSOR = "gp1.list.";
const cursorKeys = ["v", "view", "agent_id", "after", "seq", "offset", "wake", "more", "status", "prompt_id", "fragment"];
const object = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deny(code: string, message: string, action = "Correct the request or inspect this collaborator; no new operation was admitted."): never { throw new AgentError(code, message, action); }
function encode(cursor: Cursor): string { return CURSOR + Buffer.from(JSON.stringify(cursor)).toString("base64url"); }
function decode(value: string, agentId: string, promptId?: string, view?: View): Cursor {
  try {
    if (!value.startsWith(CURSOR) || value.startsWith(LIST_CURSOR)) throw new Error();
    const cursor = JSON.parse(Buffer.from(value.slice(CURSOR.length), "base64url").toString("utf8")) as Cursor;
    if (cursor.v !== 1 || cursor.agent_id !== agentId || !["result", "records"].includes(cursor.view) || !states.has(cursor.status) || typeof cursor.more !== "boolean"
      || ![cursor.after, cursor.seq, cursor.offset, cursor.wake].every(v => Number.isSafeInteger(v) && v >= 0)
      || (cursor.seq === 0) !== (cursor.offset === 0)
      || (cursor.fragment !== undefined && (!Number.isSafeInteger(cursor.fragment) || cursor.fragment <= 0 || cursor.seq === 0 || cursor.fragment <= cursor.after))
      || Object.keys(cursor).some(key => !cursorKeys.includes(key))
      || (cursor.prompt_id !== undefined && (typeof cursor.prompt_id !== "string" || !cursor.prompt_id))
      || (promptId !== undefined && cursor.prompt_id !== promptId)
      || (view !== undefined && cursor.view !== view)) throw new Error();
    return cursor;
  } catch {
    return deny("invalid_cursor", "The cursor is malformed or belongs to another collaborator, prompt filter or view.",
      "Pass the exact returned cursor with its original view and prompt_id, or omit it to read from the beginning.");
  }
}
function publicRecord(row: StoredRecord): JsonRecord {
  // Inputs are retained for native dispatch, not repeated in every caller's
  // history. Sequence/change coordinates are private cursor implementation.
  if (row.type === "operation") {
    const { input: _input, sequence: _sequence, ...value } = row.value;
    return { ...value, type: row.type };
  }
  return { ...row.value, type: row.type };
}
/** Operations the caller must act on: a completed one delivered through turns, side answers or later records. */
const unsettledOperation = new Set(["failed", "not_sent", "outcome_unknown"]);
/** The result view keeps what the caller acts on; the records view keeps everything. */
function inResult(row: StoredRecord): boolean {
  switch (row.type) {
    case "queue": case "native_options": case "native_capabilities": case "elicitation_completion": return false;
    case "attention": return row.value.status !== "resolved";
    case "operation": return unsettledOperation.has(String(row.value.status)) || removedFromQueue(row.value);
    default: return true;
  }
}
function splitEnd(text: string, start: number, budget: number): number {
  let end = Math.min(text.length, start + Math.max(0, budget));
  if (end > start && end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!) && /[\uDC00-\uDFFF]/u.test(text[end]!)) end--;
  return end;
}
/** A text piece that resumes a record mid-way does not start its block. */
function piece(value: JsonRecord, text: string, start: number): JsonRecord {
  const result: JsonRecord = { ...value, text };
  if (start > 0) delete result.block_start;
  return result;
}
const listNames = { attention: "attention", file: "files", issue: "issues", operation: "operations", background: "background" } as const;
/** Group one page by what the caller does with it: each turn's text and outcome first. */
function resultBody(store: AgentStore, records: JsonRecord[], turnFile: (promptId: string) => string | null): JsonRecord {
  const turns = new Map<string, JsonRecord>(), sideAnswers: JsonRecord[] = [];
  const lists: Record<string, JsonRecord[]> = {};
  const turn = (promptId: string): JsonRecord => {
    let entry = turns.get(promptId);
    if (!entry) turns.set(promptId, entry = { prompt_id: promptId });
    return entry;
  };
  for (const { type, ...record } of records) {
    if (type === "content") {
      const entry = turn(String(record.prompt_id));
      const separator = record.block_start === true && Number(record.block_index) > 0 ? "\n\n" : "";
      entry.text = `${String(entry.text ?? "")}${separator}${String(record.text)}`;
    } else if (type === "turn") {
      const entry = turn(String(record.prompt_id));
      const effective = promptActivity(store, record.prompt_id).turn;
      if (effective) {
        entry.status = effective.status;
        if (effective.stop_reason === undefined) delete entry.stop_reason; else entry.stop_reason = effective.stop_reason;
      }
    } else if (type === "side_answer") {
      const last = sideAnswers.at(-1);
      if (last && last.operation_id === record.operation_id) last.text = `${String(last.text)}${String(record.text)}`;
      else sideAnswers.push({ operation_id: record.operation_id, text: record.text });
    } else if (Object.hasOwn(listNames, String(type))) {
      (lists[listNames[type as keyof typeof listNames]] ??= []).push(record);
    }
  }
  const ordered = [...turns.values()].map(entry => {
    const promptId = String(entry.prompt_id), operationId = store.operationForPrompt(promptId);
    if (entry.status === undefined) {
      const current = promptActivity(store, promptId).turn;
      if (current) { entry.status = current.status; if (current.stop_reason !== undefined) entry.stop_reason = current.stop_reason; }
    }
    const { prompt_id, status, stop_reason, text } = entry, file = status === undefined || status === "running" ? null : turnFile(promptId);
    return { prompt_id, ...(operationId ? { operation_id: operationId } : {}), ...(status === undefined ? {} : { status }),
      ...(stop_reason === undefined ? {} : { stop_reason }), ...(text === undefined ? {} : { text }), ...(file ? { text_file: file } : {}) };
  });
  return { ...(ordered.length ? { turns: ordered } : {}), ...(sideAnswers.length ? { side_answers: sideAnswers } : {}), ...lists };
}
function page(summary: AgentSummary, cursor: string | null, more: boolean, compact: boolean, body: JsonRecord): AgentView {
  const { agent_id, status, ...rest } = summary;
  return { agent_id, status, cursor, has_more: more, ...(compact ? {} : rest), ...body };
}

const readEnvelope = (agent: AgentView): JsonRecord => ({ schema_version: PUBLIC_SCHEMA_VERSION, call_status: "ok", agent });
function budgetTooSmall(): never {
  return deny("response_budget_too_small", "The budget cannot carry a compact response with cursor progress.", "Increase max_chars and retry from the same input cursor; no operation was admitted.");
}
/** Fit the exact public JSON, including the caller's read or aggregate-wait envelope.
 * The snapshot freezes database state; each optional derived file is observed only once. */
export function projectAgent(store: AgentStore, options: ProjectionOptions = {}, envelope: (agent: AgentView) => JsonRecord = readEnvelope): AgentView {
  return store.snapshot(() => {
    const summary = summarizeAgent(store), revision = store.revision();
    const prior = options.cursor ? decode(options.cursor, summary.agent_id, options.prompt_id, options.view) : undefined;
    const view: View = prior?.view ?? options.view ?? "result";
    const cursor: Cursor = prior ?? { v: 1, view, agent_id: summary.agent_id, after: 0, seq: 0, offset: 0, wake: 0, more: false, status: summary.status,
      ...(options.prompt_id === undefined ? {} : { prompt_id: options.prompt_id }) };
    if (cursor.after > revision.change || cursor.wake > revision.wake) deny("invalid_cursor", "The cursor is ahead of retained collaborator state.");
    if (cursor.prompt_id !== undefined && !store.hasPrompt(cursor.prompt_id)) deny("prompt_not_found", "The selected native prompt has not been observed for this collaborator.");
    const include = (row: StoredRecord) => view === "records" || inResult(row);
    const scope = cursor.prompt_id === undefined ? {} : { prompt_id: cursor.prompt_id };
    const limit = options.max_chars ?? 32_000;
    const fits = (agent: AgentView) => JSON.stringify(envelope(agent)).length <= limit;
    const files = new Map<string, string | null>();
    const turnFile = (promptId: string) => {
      if (!files.has(promptId)) files.set(promptId, store.turnFile(promptId));
      return files.get(promptId)!;
    };
    const body = (records: JsonRecord[]) => view === "records"
      ? { records: records.map(({ block_start: _start, ...record }) => {
        const file = record.type === "turn" && record.status !== "running" ? turnFile(String(record.prompt_id)) : null;
        return file ? { ...record, text_file: file } : record;
      }) } : resultBody(store, records, turnFile);
    // Drain only omitted records; they consume neither payload budget nor an extra page.
    const following = (after: number): { after: number; more: boolean } => {
      while (true) {
        const rows = store.records({ after, through: revision.change, limit: 128, ...scope });
        if (!rows.length) return { after: revision.change, more: false };
        for (const row of rows) {
          if (include(row)) return { after, more: true };
          after = row.change;
        }
      }
    };
    let after = cursor.after, partial = cursor.seq ? store.record(cursor.seq) : null;
    let reset: string | undefined;
    if (cursor.seq) {
      if (!partial || partial.change > revision.change || (cursor.fragment !== undefined && cursor.fragment > revision.change)
        || (cursor.prompt_id !== undefined && partial.prompt_id !== cursor.prompt_id)) deny("invalid_cursor", "The cursor does not select a retained record.");
      if (cursor.fragment !== undefined && partial.change !== cursor.fragment) {
        // Current-value rows can change. Drop the old representation, then replay from
        // its checkpoint so updates between the two versions cannot be skipped.
        reset = `${cursor.seq}:${cursor.fragment}`; partial = null;
      } else {
        const source = cursor.fragment === undefined ? partial.value.text : JSON.stringify(publicRecord(partial));
        if (partial.change <= after || typeof source !== "string" || cursor.offset >= source.length
          || (cursor.fragment === undefined && !["content", "side_answer"].includes(partial.type))
          || splitEnd(source, 0, cursor.offset) !== cursor.offset) deny("invalid_cursor", "The cursor no longer selects an exact retained Unicode fragment.");
      }
    }
    const frame = (records: JsonRecord[], position: { after: number; more: boolean }, seq = 0, offset = 0,
      fragment?: number, fragments?: JsonRecord[], compact = false): AgentView => {
      const { fragment: _oldFragment, ...base } = cursor;
      const next = encode({ ...base, ...position, seq, offset, ...(fragment === undefined ? {} : { fragment }), wake: revision.wake, status: summary.status });
      return page(summary, next, position.more, compact, { ...(reset === undefined ? {} : { fragment_reset: reset }),
        ...(fragments ? { fragments } : body(records)) });
    };
    // The complete endpoint may have a different cursor/has_more shape. Test it
    // separately; only a fixed partial shape has a monotone prefix size.
    const prefix = (source: string, start: number, build: (end: number) => AgentView): AgentView | null => {
      let low = start + 1, high = source.length - 1, best: AgentView | null = null;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2), end = splitEnd(source, start, middle - start);
        if (end === start) { low = middle + 1; continue; }
        if (fits(build(end))) { best = build(end); low = middle + 1; }
        else high = middle - 1;
      }
      return best;
    };
    const records: JsonRecord[] = [];
    let previous: StoredRecord | undefined;
    const append = (row: StoredRecord, value: JsonRecord): JsonRecord[] => {
      const last = records.at(-1);
      if (row.type === "content" && previous?.type === "content" && row.seq === previous.seq + 1
        && last?.type === "content" && last.prompt_id === value.prompt_id && last.block_index === value.block_index && last.native_message_id === value.native_message_id) {
        return [...records.slice(0, -1), { ...last, text: String(last.text) + String(value.text) }];
      }
      return [...records, value];
    };
    while (true) {
      const rows = partial ? [partial] : store.records({ after, through: revision.change, limit: 128, ...scope });
      if (!rows.length) {
        const result = frame(records, { after: revision.change, more: false });
        if (fits(result)) return result;
        return budgetTooSmall();
      }
      for (const row of rows) {
        if (!include(row)) { after = row.change; partial = null; continue; }
        const value = publicRecord(row), start = partial ? cursor.offset : 0;
        const jsonFragment = partial && cursor.fragment !== undefined;
        const text = !jsonFragment && ["content", "side_answer"].includes(row.type) && typeof value.text === "string" ? value.text : null;
        const remaining = following(row.change);
        if (!jsonFragment) {
          const complete = frame(append(row, text === null ? value : piece(value, text.slice(start), start)), remaining);
          if (fits(complete)) {
            records.splice(0, records.length, ...append(row, text === null ? value : piece(value, text.slice(start), start)));
            after = remaining.after; partial = null; previous = row;
            if (!remaining.more) return complete;
            continue;
          }
          if (text !== null) {
            const result = prefix(text, start, end => frame(append(row, piece(value, text.slice(start, end), start)), { after, more: true }, row.seq, end));
            if (result) return result;
            if (partial) return budgetTooSmall(); // An existing text offset must never become a JSON offset.
          }
        }
        // Do not mix grouped records with a representation fragment. The next
        // call starts this row from the checkpoint, without advancing past it.
        if (records.length) {
          const result = frame(records, { after, more: true });
          if (fits(result)) return result;
          return budgetTooSmall();
        }
        const serialized = JSON.stringify(value), offset = jsonFragment ? start : 0;
        const fragment = (end: number, complete: boolean) => frame([], complete ? remaining : { after, more: true },
          complete ? 0 : row.seq, complete ? 0 : end, complete ? undefined : row.change,
          [{ record_id: `${row.seq}:${row.change}`, record_type: row.type, offset, json: serialized.slice(offset, end), complete }], true);
        const complete = fragment(serialized.length, true);
        if (fits(complete)) return complete;
        const result = prefix(serialized, offset, end => fragment(end, false));
        if (result) return result;
        return budgetTooSmall();
      }
      partial = null;
    }
  });
}
function unavailableSummary(agentId: string, error: unknown): JsonRecord & { agent_id: string; status: "unavailable" } {
  return { agent_id: agentId, cwd: null, worktree: null, execution_cwd: null, worktree_root: null, sandbox_argument: null, created_at: null, status: "unavailable", error: failure(error, "agent_unavailable") };
}
function unavailable(agentId: string, error: unknown, view: View): AgentView {
  const issue = { code: failure(error, "agent_unavailable").code, message: "This target could not be read.", action: "Use grok_read for the complete error; keep this target's input cursor." };
  return { agent_id: agentId, status: "unavailable", cursor: null, has_more: false,
    ...(view === "records" ? { records: [{ type: "issue", ...issue }] } : { issues: [issue] }) };
}
type Admission = { admission: "none" | "confirmed" | "unknown"; agent_id?: string; operation_id?: string };
export class WorkerLaunchError extends Error {
  readonly known_no_child = true;
  constructor(cause: unknown) { super("The worker process was not created.", { cause }); this.name = "WorkerLaunchError"; }
}
export type WorkerLauncher = (agentId: string, meta: AgentMeta, environment: NodeJS.ProcessEnv, launchToken: string) => void | ProcessIdentity | Promise<void | ProcessIdentity>;
function isFile(path: string): boolean { try { return statSync(path).isFile(); } catch { return false; } }
function isExecutable(path: string): boolean { try { accessSync(path, constants.X_OK); return isFile(path); } catch { return false; } }
/** A server runs this bundle's own worker on Node, and a long-running server can outlive both:
 * a host update removes a superseded plugin folder, and a package-manager upgrade removes the
 * versioned executable `process.execPath` resolved to. The server's executable is used while it
 * exists, otherwise the `node` its launcher (`#!/usr/bin/env node`) would find on PATH now. Only
 * absolute PATH entries count, because the worker starts in the collaborator's directory. */
function workerCommand(environment: NodeJS.ProcessEnv): { node: string; entrypoint: string } {
  const entrypoint = fileURLToPath(import.meta.url);
  if (!isFile(entrypoint)) {
    throw new AgentError("worker_unavailable", `This grokpair server's own package file is gone (${entrypoint}), typically because an update replaced the plugin while this server kept running, so it cannot start a worker.`,
      "Start a new session, or restart this host's grokpair server, so it runs the installed package. Existing collaborators stay readable and closable; nothing was admitted.", { entrypoint });
  }
  const node = isExecutable(process.execPath) ? process.execPath
    : (environment.PATH ?? "").split(delimiter).filter(isAbsolute).map(directory => join(directory, "node")).find(isExecutable);
  if (node === undefined) {
    throw new AgentError("worker_unavailable", `The Node executable this grokpair server started from is gone (${process.execPath}), typically removed by an upgrade while this server kept running, and no node is on its PATH to start a worker with.`,
      "Make Node >=24.22.1 available as node on the PATH this host gives grokpair, then start a new session. Existing collaborators stay readable and closable; nothing was admitted.",
      { server_executable: process.execPath });
  }
  return { node, entrypoint };
}
async function launchWorker(agentId: string, meta: AgentMeta, environment: NodeJS.ProcessEnv, launchToken: string): Promise<void | ProcessIdentity> {
  let child;
  try {
    // Resolved again at launch: admission's check cannot remove the race with an update.
    const { node, entrypoint } = workerCommand(environment);
    child = spawn(node, [entrypoint, "internal-worker", agentId, launchToken], {
      cwd: meta.cwd, env: environment, detached: true, stdio: "ignore",
    });
  } catch (error) { throw new WorkerLaunchError(error); }
  const failed = await new Promise<unknown>(resolve => { child.once("error", resolve); child.once("spawn", () => resolve(undefined)); });
  if (child.pid === undefined) throw new WorkerLaunchError(failed);
  child.unref();
  // Whatever the spawn events said, the child's own observation decides: gone before claiming means never launched.
  const observed = observeProcess(child.pid);
  if (observed.status === "observed") return observed.identity;
  if (observed.status === "absent") throw new WorkerLaunchError(failed ?? new Error("The worker exited before claiming its launch."));
}
export class AgentService {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env, private readonly launcher: WorkerLauncher = launchWorker) {}
  async invoke(name: ToolName, input: unknown): Promise<JsonRecord> {
    const admission: Admission = { admission: "none" };
    try {
      let parsed;
      try { parsed = parseToolInput(name, input); }
      catch (error) { throw new AgentError("invalid_input", error instanceof Error ? error.message : String(error), "Correct the tool input before retrying; no operation was admitted."); }
      if ("agent_id" in parsed) admission.agent_id = parsed.agent_id;
      switch (name) {
        case "grok_spawn": return await this.spawn(parsed as SpawnInput, admission);
        case "grok_read": return { schema_version: PUBLIC_SCHEMA_VERSION, call_status: "ok", agent: this.read(parsed as ReadInput) };
        case "grok_wait": return await this.wait(parsed as WaitInput);
        case "grok_list": return this.list(parsed as ListInput);
        case "grok_send": return await this.send(parsed as SendInput, admission);
        default: return this.control(name, parsed as JsonRecord, admission);
      }
    } catch (error) {
      return { schema_version: PUBLIC_SCHEMA_VERSION, call_status: "error", error: { ...failure(error, "call_failed"), ...admission } };
    }
  }
  private read(input: { agent_id: string } & ProjectionOptions, envelope = readEnvelope): AgentView {
    const store = AgentStore.open(input.agent_id, this.environment, { readonly: true });
    try { return projectAgent(store, input, envelope); } finally { store.close(); }
  }
  private summary(agentId: string): JsonRecord {
    let store: AgentStore | undefined;
    try { store = AgentStore.open(agentId, this.environment, { readonly: true }); const opened = store; return opened.snapshot(() => summarizeAgent(opened)); }
    catch (error) { return unavailableSummary(agentId, error); }
    finally { store?.close(); }
  }
  private reserve<T>(store: AgentStore, admission: Admission, effect: (operationId: string) => T): T {
    const operationId = id("operation"); admission.operation_id = operationId; admission.admission = "unknown";
    try { const value = effect(operationId); admission.admission = "confirmed"; return value; }
    catch (error) {
      try {
        admission.admission = store.operation(operationId) ? "confirmed" : "none";
        if (admission.admission === "none") delete admission.operation_id;
      } catch {} throw error;
    }
  }
  private receipt(store: AgentStore, admission: Admission): JsonRecord {
    return { schema_version: PUBLIC_SCHEMA_VERSION, call_status: "admitted", agent_id: store.agentId,
      operation_id: admission.operation_id, agent: store.snapshot(() => summarizeAgent(store)) };
  }
  private async launch(store: AgentStore, launchToken: string): Promise<void> {
    try {
      const identity = await this.launcher(store.agentId, store.meta(), this.environment, launchToken);
      store.setLaunched(launchToken, identity || undefined);
    } catch (error) {
      // A child that claimed before exiting owns the outcome; its absence shows as disconnected.
      if (error instanceof WorkerLaunchError && !store.failLaunch(launchToken, failure(error, "worker_not_launched"))) return;
      throw error;
    }
  }
  private async spawn(input: SpawnInput, admission: Admission): Promise<JsonRecord> {
    const prepare = () => {
      workerCommand(this.environment);
      const workspacePlan = preflightWorkspace(input.cwd, input.worktree, workspaceBoundaries(this.environment));
      if (input.attachments) preflightAttachments(input.attachments);
      return workspacePlan;
    };
    let prepared: ReturnType<typeof prepare> | undefined;
    const admit = () => {
      const workspacePlan = prepared ?? prepare();
      const agentId = id("agent"); admission.agent_id = agentId;
      const store = AgentStore.create({ agent_id: agentId, cwd: input.cwd, worktree: input.worktree, sandbox_argument: input.sandbox ?? null,
        execution_cwd: null, created_at: now(), phase: "opening",
        workspace_plan: workspacePlan, ...(input.key === undefined ? {} : { key: input.key }) }, this.environment);
      try {
        const reserved = this.reserve(store, admission, operationId => store.admitLaunch(input, { operation_id: operationId, resume: false }));
        return { agent_id: agentId, value: { store, token: reserved.launch.token } };
      } catch (error) { store.close(); throw error; }
    };
    let admitted: { store: AgentStore; token: string };
    if (input.key === undefined) admitted = admit().value;
    else {
      // A rejected first spawn must not create a runtime merely to discover
      // that its key has no holder. Existing holders still precede preflight.
      if (!KeyRegistry.holderOf(input.key, this.environment)) prepared = prepare();
      const registry = KeyRegistry.open(this.environment);
      try {
        while (true) {
          const claimed = registry.claim(input.key, agentId => this.isOpen(agentId), admit);
          if (!("holder" in claimed)) { admitted = claimed.value; break; }
          admission.agent_id = claimed.holder;
          let held: AgentStore | undefined;
          let agent: AgentSummary, original: unknown;
          try {
            held = AgentStore.open(claimed.holder, this.environment, { readonly: true });
            const opened = held;
            ({ agent, original } = opened.snapshot(() => ({ agent: summarizeAgent(opened), original: opened.operations()[0]?.input })));
            if (agent.status === "closed") continue;
            original = normalizedSpawnRequest(original);
          } catch {
            throw new AgentError("spawn_key_unverifiable", "The held collaborator's original spawn request cannot be verified; its key remains held.",
              "Inspect the existing collaborator and its store. Do not retry with a new key or infer that missing state authorizes a new launch.", { agent_id: claimed.holder });
          } finally { held?.close(); }
          if (!isDeepStrictEqual(original, normalizedSpawnRequest(input))) {
            throw new AgentError("spawn_key_conflict", "This key holds a collaborator admitted with a different complete spawn request.",
              "Read the existing collaborator. Use grok_send for a changed task or configuration, or close it explicitly when finished; this call launched nothing.",
              { agent_id: claimed.holder, agent });
          }
          return { schema_version: PUBLIC_SCHEMA_VERSION, call_status: "existing", agent_id: claimed.holder, agent };
        }
      } finally { registry.close(); }
    }
    const { store, token } = admitted;
    try {
      await this.launch(store, token);
      return this.receipt(store, admission);
    } finally { store.close(); }
  }
  /** Unknown or missing state holds a key: only explicit closed state releases it. */
  private isOpen(agentId: string): boolean {
    let store: AgentStore | undefined;
    try { store = AgentStore.open(agentId, this.environment, { readonly: true }); const opened = store; return opened.snapshot(() => summarizeAgent(opened)).status !== "closed"; }
    catch { return true; }
    finally { store?.close(); }
  }
  private usable(store: AgentStore): AgentSummary {
    const summary = store.snapshot(() => summarizeAgent(store));
    if (summary.status === "closed") deny("collaborator_closed", "This collaborator is already closed.");
    if (summary.status === "disconnected" || summary.status === "unavailable") deny("collaborator_disconnected", "The resident collaborator is not observably connected.", "Read retained results. Use a new follow_up with resume:true only after exact predecessor absence; never replay uncertain earlier input.");
    return summary;
  }
  private async send(input: SendInput, admission: Admission): Promise<JsonRecord> {
    const store = AgentStore.open(input.agent_id, this.environment);
    try {
      if (input.resume !== true) this.usable(store);
      if (input.action === "edit") this.validateEdit(store, input.prompt_id!);
      if (input.attachments) preflightAttachments(input.attachments);
      if (input.resume === true) {
        workerCommand(this.environment);
        const meta = store.meta(), boundaries = workspaceBoundaries(this.environment);
        validateWorkspace(meta.cwd, boundaries);
        if (meta.worktree && meta.provisioning !== undefined && typeof meta.prepared_cwd !== "string") {
          throw new AgentError("worktree_context_unavailable", "Native provisioning has no validated execution directory; resume cannot create another tree.",
            "Read the retained provisioning outcome and inspect native worktree discovery. Preserve any created work; do not retry uncertain creation.");
        }
        if (typeof meta.prepared_cwd === "string") validateNativeWorkspace(meta.workspace_plan as PreparedWorkspacePlan, meta.prepared_cwd,
          typeof meta.worktree_root === "string" ? meta.worktree_root : undefined, boundaries);
        const reserved = this.reserve(store, admission, operationId => store.admitLaunch(input, { operation_id: operationId, resume: true }));
        await this.launch(store, reserved.launch.token);
      } else this.reserve(store, admission, operationId => store.admit(input.action, input, { operation_id: operationId }));
      return this.receipt(store, admission);
    } finally { store.close(); }
  }
  private validateEdit(store: AgentStore, promptId: string): void {
    const queue = object(store.observation("queue"));
    if (promptActivity(store, promptId).inactive || !array(queue.entries).some(entry => object(entry).id === promptId)) deny("prompt_not_queued", "Edit requires an exact currently queued native prompt_id.");
    assertQueuedEditInput(store.promptInput(promptId));
  }
  private control(name: ToolName, input: JsonRecord, admission: Admission): JsonRecord {
    const store = AgentStore.open(input.agent_id as string, this.environment);
    try {
      if (name === "grok_close") this.reserve(store, admission, operationId => store.admitClose(operationId));
      else {
        this.usable(store);
        if (name === "grok_respond") {
          const pending = store.getAttention(String(input.request_id));
          if (!pending || pending.status !== "pending") deny("attention_not_pending", "This request is not pending in the resident collaborator.");
          validateAttentionResponse(pending as unknown as NativeAttention, input.response);
        }
        this.reserve(store, admission, operationId => store.admit(name === "grok_respond" ? "respond" : "interrupt", input, { operation_id: operationId }));
      }
      return this.receipt(store, admission);
    } finally { store.close(); }
  }
  private async wait(input: WaitInput): Promise<JsonRecord> {
    const deadline = performance.now() + input.timeout_ms;
    const prior: (Cursor | null | Error)[] = input.targets.map(target => {
      try { return target.cursor ? decode(target.cursor, target.agent_id, undefined, input.view) : null; }
      catch (error) { return error instanceof Error ? error : new Error(String(error)); }
    });
    while (true) {
      const result = (agents: AgentView[], status: string): JsonRecord => ({ schema_version: PUBLIC_SCHEMA_VERSION, call_status: status, agents });
      const status = input.until === "change" ? "changed" : "settled";
      const readTarget = (index: number, delivered: AgentView[]): AgentView => {
        const target = input.targets[index]!;
        const envelope = (agent: AgentView) => result([...delivered, agent], status);
        try { return this.read({ ...target, max_chars: input.max_chars, view: input.view }, envelope); }
        catch (error) {
          if (error instanceof AgentError && error.code === "response_budget_too_small") throw error;
          const before = prior[index];
          const agent = unavailable(target.agent_id, error, input.view ?? (before && !(before instanceof Error) ? before.view : "result"));
          if (JSON.stringify(envelope(agent)).length > input.max_chars) return budgetTooSmall();
          return agent;
        }
      };
      // Each candidate is projected and judged from the same frozen observation.
      // Retain the triggering page itself, not a later reconstruction of its state.
      const candidates = input.targets.map((_, index) => {
        try { return readTarget(index, []); }
        catch (error) { if (error instanceof AgentError && error.code === "response_budget_too_small") return null; throw error; }
      });
      // New since the caller's cursor: records it has not read, a meaningful change or a status change.
      const fresh = candidates.map((agent, index) => {
        if (!agent) return false;
        const before = prior[index];
        if (before instanceof Error || !agent.cursor) return true;
        const after = decode(agent.cursor, agent.agent_id);
        if (before) return before.more || after.wake !== before.wake || after.status !== before.status;
        return SETTLED.has(agent.status) || after.wake > 0;
      });
      const trigger = candidates.findIndex((agent, index) => agent && fresh[index] && (input.until === "change" || SETTLED.has(agent.status)));
      if (trigger >= 0 || performance.now() >= deadline) {
        const seed = trigger >= 0 ? trigger : candidates.findIndex(Boolean);
        if (seed < 0) return budgetTooSmall();
        const agents = [candidates[seed]!];
        for (let index = 0; index < input.targets.length; index++) {
          if (index === seed) continue;
          try { agents.push(readTarget(index, agents)); }
          catch (error) { if (!(error instanceof AgentError && error.code === "response_budget_too_small")) throw error; }
        }
        return result(agents, trigger >= 0 ? status : "timeout");
      }
      if (!candidates.some(Boolean)) return budgetTooSmall();
      await pause(Math.min(100, Math.max(1, deadline - performance.now())));
    }
  }
  private list(input: ListInput): JsonRecord {
    type Entry = { agent_id: string; created_at: string; agent: JsonRecord };
    const filter = { include_closed: input.include_closed, ...(input.key === undefined ? {} : { key: input.key }) };
    let after: { agent_id: string; created_at: string } | null = null;
    if (input.cursor) {
      try {
        if (!input.cursor.startsWith(LIST_CURSOR)) throw new Error();
        const value = JSON.parse(Buffer.from(input.cursor.slice(LIST_CURSOR.length), "base64url").toString("utf8")) as JsonRecord;
        if (typeof value.agent_id !== "string" || typeof value.created_at !== "string" || !isDeepStrictEqual(value.filter, filter) || Object.keys(value).length !== 3) throw new Error();
        after = { agent_id: value.agent_id, created_at: value.created_at };
      } catch { deny("invalid_cursor", "The list cursor is invalid or was issued for other filters.", "Repeat the list call with the filters that produced the cursor, or omit the cursor."); }
    }
    // The registry names a key's holder even when its database cannot be read.
    const holder = input.key === undefined ? null : KeyRegistry.holderOf(input.key, this.environment);
    const compare = (a: { created_at: string; agent_id: string }, b: { created_at: string; agent_id: string }) => a.created_at > b.created_at ? -1 : a.created_at < b.created_at ? 1 : a.agent_id.localeCompare(b.agent_id);
    const entries: Entry[] = listAgentIds(this.environment).map(agentId => {
      const agent = this.summary(agentId);
      return { agent_id: agentId, created_at: typeof agent.created_at === "string" ? agent.created_at : "", agent };
    }).filter(entry => (input.include_closed || entry.agent.status !== "closed") && (input.key === undefined || entry.agent.key === input.key || entry.agent_id === holder))
      .sort(compare).filter(entry => !after || compare(entry, after) > 0);
    const selected = entries.slice(0, input.limit), more = entries.length > selected.length, last = selected.at(-1);
    return { schema_version: PUBLIC_SCHEMA_VERSION, call_status: "ok", agents: selected.map(entry => entry.agent), page: { has_more: more,
      ...(more && last ? { next_cursor: LIST_CURSOR + Buffer.from(JSON.stringify({ agent_id: last.agent_id, created_at: last.created_at, filter })).toString("base64url") } : {}) } };
  }
}
