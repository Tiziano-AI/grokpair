import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { currentProcessIdentity, processIdentityStatus, type ProcessIdentity } from "./process.js";
import { AgentError, failure } from "./core.js";
import { attentionToolCallId } from "./attention.js";
import { stateHome } from "./filesystem.js";

export type JsonRecord = Record<string, unknown>;
export type AgentMeta = JsonRecord & { agent_id: string; cwd: string; worktree: boolean; sandbox_argument: string | null; execution_cwd: string | null; created_at: string; phase: "opening" | "ready" | "stopping" | "disconnected" | "closed" };
export type OperationStatus = "admitted" | "started" | "completed" | "failed" | "not_sent" | "outcome_unknown";
export type Operation = JsonRecord & { operation_id: string; sequence: number; kind: string; input: JsonRecord; status: OperationStatus; created_at: string; started_at?: string; completed_at?: string; result?: unknown; error?: unknown; native_prompt_id?: string };
type NativeProcessState = "not_attempted" | "launching" | "running" | "ended" | "not_launched";
type NativeProcessRole = "provider" | "provisioner";
export type WorkerClaim = { token: string; worker: ProcessIdentity; claimed_at: string; provider: ProcessIdentity | null; provider_state: NativeProcessState; provisioner: ProcessIdentity | null; provisioner_state: NativeProcessState };
export type LaunchReservation = { token: string; operation_id: string; resume: boolean; state: "reserved" | "claimed" | "fenced"; launcher: ProcessIdentity; worker?: ProcessIdentity; created_at: string; failure?: unknown };
export type ContentInput = JsonRecord & { prompt_id: string; native_message_id?: string; block_index: number; text: string };
export type ContentRow = ContentInput & { seq: number };
export type Attention = JsonRecord & { request_id: string; method: string; payload: unknown; status: string };
export type NativeFile = JsonRecord & { reference_id: string };
export type NativeFileInput = JsonRecord & { path?: string; uri?: string; prompt_id?: string; tool_call_id?: string };
export type Turn = JsonRecord & { prompt_id: string; status: string; source: string };
export type RecordType = "operation" | "content" | "side_answer" | "attention" | "file" | "turn" | "issue" | "native_options" | "native_capabilities" | "queue" | "background" | "elicitation_completion";
type SingletonObservation = "queue" | "native_options" | "native_capabilities";
type KeyedObservation = "background" | "elicitation_completion";
export type StoredRecord = { seq: number; change: number; type: RecordType; id: string; prompt_id?: string; value: JsonRecord };
export type Revision = { change: number; wake: number };
export type DirectoryReceipt = { path: string; device: string; inode: string };
const AGENT_ID = /^agent_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const now = () => new Date().toISOString();
export const RUNTIME_CONTRACT = 2;

/** A prompt RPC can end without that prompt ever becoming its own turn. */
export function removedFromQueue(operation: JsonRecord): boolean {
  if (operation.status !== "completed") return false;
  const result = operation.result as JsonRecord | undefined;
  const meta = result?._meta as JsonRecord | undefined;
  // The old result flag is retained data, not a reason to fabricate a turn.
  return meta?.completionKind === "removedFromQueue" || result?.removed_from_queue === true;
}

/** One passive interpretation of autonomous prompt activity, including retained old false terminals. */
export function promptActivity(store: AgentStore, promptId: unknown): { turn: Turn | null; inactive: boolean; removed_from_queue: boolean } {
  if (typeof promptId !== "string" || !promptId) return { turn: null, inactive: false, removed_from_queue: false };
  const observed = store.turn(promptId);
  const removed = observed?.source === "removed_from_queue"
    || store.operations().some(operation => operation.native_prompt_id === promptId && removedFromQueue(operation));
  const terminal = !!observed && observed.source !== "removed_from_queue" && ["completed", "cancelled"].includes(observed.status);
  return { turn: terminal || !removed ? observed : null, inactive: terminal || removed, removed_from_queue: removed };
}

/** Validate every existing ancestor, including aliases such as /tmp on macOS. */
function canonical(path: string, create = false): string {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0")) throw new Error("Expected an absolute canonical normalized path");
  let current = parse(path).root;
  for (const part of path.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    try { lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) continue;
      try { mkdirSync(current, { mode: 0o700 }); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
    }
    let state;
    try { state = lstatSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && !create) continue; throw error; }
    if (!state.isDirectory() || state.isSymbolicLink() || realpathSync(current) !== current) throw new Error("Runtime directory is not canonical or contains a symlink");
  }
  return path;
}
export function runtimeCoordinates(environment: NodeJS.ProcessEnv = process.env): string {
  const base = stateHome(environment);
  canonical(base);
  return canonical(join(base, `runtime-v${RUNTIME_CONTRACT}`));
}
export function agentPath(agentId: string, environment: NodeJS.ProcessEnv = process.env): string {
  if (!AGENT_ID.test(agentId)) throw new Error("Invalid agent_id");
  return join(runtimeCoordinates(environment), "agents", agentId);
}
export function directoryReceipt(path: string): DirectoryReceipt {
  canonical(path);
  const state = lstatSync(path, { bigint: true });
  return { path, device: String(state.dev), inode: String(state.ino) };
}
export function attestDirectory(expected: DirectoryReceipt): void {
  const actual = directoryReceipt(expected.path);
  if (actual.device !== expected.device || actual.inode !== expected.inode) throw new Error("Runtime directory custody changed");
}
function regular(path: string): { device: string; inode: string } {
  const state = lstatSync(path, { bigint: true });
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1n) throw new Error("Database custody is not a regular single-link file");
  return { device: String(state.dev), inode: String(state.ino) };
}
const decode = <T>(row: unknown): T | null => row ? JSON.parse((row as { value: string }).value) as T : null;

/** One compact SQLite database per collaborator. Reads never recover or execute. */
export class AgentStore {
  readonly agentId: string;
  readonly root: string;
  readonly databasePath: string;
  readonly directory: DirectoryReceipt;
  private readonly db: DatabaseSync;
  private readonly file: { device: string; inode: string };
  private readonly readonlyMode: boolean;
  private ownerIdentity: ProcessIdentity | null = null;
  /** Turns that stopped running in the open transaction; their files are written once it commits. */
  private readonly stoppedTurns = new Set<string>();

  private constructor(agentId: string, environment: NodeJS.ProcessEnv, options: { create?: boolean; readonly?: boolean } = {}) {
    this.agentId = agentId; this.root = agentPath(agentId, environment); this.databasePath = join(this.root, "agent.sqlite");
    this.readonlyMode = options.readonly === true;
    if (options.create) { canonical(dirname(this.root), true); mkdirSync(this.root, { mode: 0o700 }); }
    try { this.directory = directoryReceipt(this.root); }
    catch (error) {
      if (!options.create && (error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AgentError("collaborator_not_found", "No collaborator directory exists for this agent_id.",
          "Use grok_list to find an existing collaborator or check the exact agent_id and runtime selection.");
      }
      throw error;
    }
    if (options.create) closeSync(openSync(this.databasePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
    this.file = regular(this.databasePath);
    this.attest(false);
    this.db = new DatabaseSync(this.databasePath, { readOnly: this.readonlyMode, enableForeignKeyConstraints: true });
    try {
      this.db.exec("PRAGMA busy_timeout=5000;");
      if (options.create) {
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE records (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, id TEXT NOT NULL,
            change INTEGER UNIQUE NOT NULL, prompt_id TEXT, status TEXT, value TEXT NOT NULL, UNIQUE(type,id));
          CREATE INDEX record_status ON records(type,status);
          CREATE INDEX record_prompt ON records(prompt_id,change);
          CREATE TABLE prompt_inputs (id TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO state VALUES ('revision','{"change":0,"wake":0}'); INSERT INTO state VALUES ('format','1');
          INSERT INTO state VALUES ('runtime_contract','${RUNTIME_CONTRACT}');`);
      }
      this.assertContract();
      if (!options.create && !this.readonlyMode) this.db.exec("PRAGMA synchronous=FULL;");
      this.attest();
    } catch (error) { this.db.close(); throw error; }
  }
  static create(meta: AgentMeta, environment: NodeJS.ProcessEnv = process.env): AgentStore {
    if (!["opening", "ready", "stopping", "disconnected", "closed"].includes(meta.phase)) throw new Error("Agent metadata requires a valid phase");
    const store = new AgentStore(meta.agent_id, environment, { create: true });
    store.transaction(() => store.putState("meta", meta));
    return store;
  }
  static open(agentId: string, environment: NodeJS.ProcessEnv = process.env, options: { readonly?: boolean } = {}): AgentStore {
    return new AgentStore(agentId, environment, options);
  }
  close(): void { this.db.close(); }
  /** Read all projected fields and their delivery cursor from one SQLite snapshot. */
  snapshot<T>(read: () => T): T {
    this.attest(); this.db.exec("BEGIN");
    try {
      const result = read();
      if (result && typeof result === "object" && "then" in result) throw new Error("Store snapshots must be synchronous");
      this.attest(); this.db.exec("COMMIT"); return result;
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }
  private assertContract(): void {
    if (this.getState<number>("format") !== 1) throw new Error("Unsupported collaborator database format");
    const actual = this.getState<unknown>("runtime_contract");
    if (actual !== RUNTIME_CONTRACT) throw new AgentError("runtime_contract_mismatch",
      `Collaborator runtime contract ${JSON.stringify(actual)} does not match ${RUNTIME_CONTRACT}; no records were interpreted or changed.`,
      "Use the matching installed runtime and exact collaborator identity. Preserve this database; do not migrate it, copy it into another runtime, or replay its operations.");
  }
  private attest(checkContract = true): void {
    attestDirectory(this.directory);
    const actual = regular(this.databasePath);
    if (actual.device !== this.file.device || actual.inode !== this.file.inode) throw new Error("Database custody changed");
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try { regular(this.databasePath + suffix); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (checkContract) this.assertContract();
  }
  private transaction<T>(fn: () => T): T {
    if (this.readonlyMode) throw new Error("Read-only store cannot mutate");
    this.attest(); this.db.exec("BEGIN IMMEDIATE");
    let result: T;
    try { result = fn(); this.attest(); this.db.exec("COMMIT"); }
    catch (error) { this.stoppedTurns.clear(); try { this.db.exec("ROLLBACK"); } catch {} throw error; }
    // Turn files describe committed state only, so they are written after COMMIT.
    const stopped = [...this.stoppedTurns]; this.stoppedTurns.clear();
    for (const promptId of stopped) this.writeTurnFile(promptId);
    return result;
  }
  private getState<T>(key: string): T | null { return decode<T>(this.db.prepare("SELECT value FROM state WHERE key=?").get(key)); }
  private putState(key: string, value: unknown): void { this.db.prepare("INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value)); }
  private bump(meaningful = true): Revision {
    const previous = this.getState<Revision>("revision")!;
    const next = { change: previous.change + 1, wake: previous.wake + (meaningful ? 1 : 0) };
    this.putState("revision", next); return next;
  }
  private stored(row: unknown): StoredRecord | null {
    if (!row) return null;
    const value = row as { seq: number; change: number; type: RecordType; id: string; prompt_id: string | null; value: string };
    return { seq: Number(value.seq), change: Number(value.change), type: value.type, id: value.id,
      ...(value.prompt_id === null ? {} : { prompt_id: value.prompt_id }), value: JSON.parse(value.value) as JsonRecord };
  }
  /** A current semantic owner, not an append-only change journal. Its seq stays stable. */
  private putRecord(type: RecordType, id: string, value: JsonRecord, meaningful = true): StoredRecord {
    const previous = this.stored(this.db.prepare("SELECT * FROM records WHERE type=? AND id=?").get(type, id));
    if (previous && isDeepStrictEqual(previous.value, value)) return previous;
    const revision = this.bump(meaningful);
    const prompt = typeof value.prompt_id === "string" ? value.prompt_id : type === "operation" && typeof value.native_prompt_id === "string" ? value.native_prompt_id : null;
    const status = typeof value.status === "string" ? value.status : null;
    return this.stored(this.db.prepare(`INSERT INTO records (type,id,change,prompt_id,status,value) VALUES (?,?,?,?,?,?)
      ON CONFLICT(type,id) DO UPDATE SET change=excluded.change,prompt_id=excluded.prompt_id,status=excluded.status,value=excluded.value
      RETURNING *`).get(type, id, revision.change, prompt, status, JSON.stringify(value)))!;
  }
  private value<T>(type: RecordType, id: string): T | null { return decode<T>(this.db.prepare("SELECT value FROM records WHERE type=? AND id=?").get(type, id)); }
  private values<T>(type: RecordType, statuses?: readonly string[]): T[] {
    if (statuses?.length === 0) return [];
    const statusSql = statuses ? ` AND status IN (${statuses.map(() => "?").join(",")})` : "";
    return this.db.prepare(`SELECT value FROM records WHERE type=?${statusSql} ORDER BY seq`).all(type, ...(statuses ?? [])).map(row => decode<T>(row)!);
  }
  meta(): AgentMeta { this.attest(); const result = this.getState<AgentMeta>("meta"); if (!result) throw new Error("Agent admission is incomplete"); return result; }
  revision(): Revision { this.attest(); return this.getState<Revision>("revision")!; }
  records(options: { after?: number; through?: number; limit?: number; prompt_id?: string } = {}): StoredRecord[] {
    this.attest(); const after = options.after ?? 0, through = options.through ?? this.revision().change, limit = options.limit ?? 128;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(through) || through < after
        || !Number.isSafeInteger(limit) || limit < 1 || options.prompt_id !== undefined && !options.prompt_id) throw new Error("Invalid records page");
    const selected = options.prompt_id === undefined ? "" : " AND prompt_id=?";
    return this.db.prepare(`SELECT * FROM records WHERE change>? AND change<=?${selected} ORDER BY change LIMIT ?`)
      .all(after, through, ...(options.prompt_id === undefined ? [] : [options.prompt_id]), limit).map(row => this.stored(row)!);
  }
  record(seq: number): StoredRecord | null {
    this.attest(); if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("Invalid record sequence");
    return this.stored(this.db.prepare("SELECT * FROM records WHERE seq=?").get(seq));
  }
  hasPrompt(promptId: string): boolean {
    this.attest(); return !!this.db.prepare("SELECT 1 FROM records WHERE prompt_id=? LIMIT 1").get(promptId)
      || !!this.db.prepare("SELECT 1 FROM prompt_inputs WHERE id=?").get(promptId);
  }
  count(type: RecordType, statuses?: readonly string[]): number {
    this.attest(); if (statuses?.length === 0) return 0;
    const selected = statuses ? ` AND status IN (${statuses.map(() => "?").join(",")})` : "";
    return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM records WHERE type=?${selected}`).get(type, ...(statuses ?? []))!.count);
  }
  setMeta(claim: WorkerClaim, patch: JsonRecord, meaningful = true): void {
    this.transaction(() => {
      this.assertOwner(claim); const meta = this.meta();
      const next = { ...meta, ...patch, agent_id: this.agentId, created_at: meta.created_at };
      if (!["opening", "ready", "stopping", "disconnected", "closed"].includes(next.phase)) throw new Error("Invalid agent phase");
      if (meta.phase === "closed" && next.phase !== "closed") throw new Error("Closed collaborator cannot reopen");
      if (isDeepStrictEqual(meta, next)) return;
      this.putState("meta", next); this.bump(meaningful);
    });
  }
  private assertAdmission(): void {
    const phase = this.meta().phase;
    if (phase === "closed") throw new AgentError("collaborator_closed", "Collaborator is closed", "Read retained results; this collaborator cannot accept more work.");
    if (phase === "stopping" || this.db.prepare("SELECT 1 FROM records WHERE type='operation' AND status IN ('admitted','started') AND json_extract(value,'$.kind')='close' LIMIT 1").get()) {
      throw new AgentError("collaborator_closing", "Collaborator close is pending", "Wait for the existing close operation and inspect retained results; do not submit another operation.");
    }
  }
  private insertOperation(kind: string, input: JsonRecord, operationId = `operation_${randomUUID()}`): Operation {
    if (this.value("operation", operationId)) throw new Error("Operation identity already admitted");
    const operation: Operation = { operation_id: operationId, sequence: 0, kind, input, status: "admitted", created_at: now() };
    const stored = this.putRecord("operation", operationId, operation);
    operation.sequence = stored.seq;
    this.db.prepare("UPDATE records SET value=? WHERE seq=?").run(JSON.stringify(operation), stored.seq);
    return operation;
  }
  admit(kind: string, input: JsonRecord, options: { operation_id?: string } = {}): Operation {
    return this.transaction(() => {
      this.assertAdmission();
      const meta = this.meta(), worker = this.worker();
      if (meta.phase === "disconnected" || meta.phase === "stopping"
          || (worker ? processIdentityStatus(worker.worker) !== "alive" : !(meta.phase === "opening" && this.launch()?.state === "reserved"))) {
        throw new AgentError("collaborator_disconnected", "Collaborator is disconnected or stopping; ordinary admission requires a current resident or reserved launch",
          "Read retained results. Use a new follow_up with resume:true only after exact predecessor absence; never replay uncertain earlier input.");
      }
      const operationId = options.operation_id ?? `operation_${randomUUID()}`;
      if (kind === "interrupt" && input.prompt_id !== undefined) {
        const promptId = input.prompt_id, queue = this.value<JsonRecord>("queue", "queue");
        const reject = (code: string, message: string): never => { throw new AgentError(code, message,
          "Read the current native queue. Interrupt with prompt_id removes only that observed queued version; omit prompt_id to cancel the current root turn. No operation was admitted."); };
        if (typeof promptId !== "string" || !promptId) reject("invalid_prompt_id", "Queued removal requires a nonempty exact native prompt_id.");
        if (!queue || queue.unavailable === true || !Array.isArray(queue.entries)) reject("queue_not_observed", "Queued removal requires a current native queue snapshot; the queue is unknown.");
        const activity = promptActivity(this, promptId);
        if (activity.inactive) reject("prompt_not_queued", `Native prompt ${JSON.stringify(promptId)} is no longer an autonomous queued prompt; the retained queue entry is stale.`);
        if (queue!.runningPromptId === promptId || activity.turn?.status === "running") {
          reject("prompt_running", `Native prompt ${JSON.stringify(promptId)} is running, not an eligible queued removal target.`);
        }
        const entries = (queue!.entries as unknown[]).filter((value): value is JsonRecord => !!value && typeof value === "object" && !Array.isArray(value));
        const matching = entries.filter(entry => entry.id === promptId);
        if (matching.length !== 1) reject("prompt_not_queued", `Native prompt ${JSON.stringify(promptId)} is not uniquely present in the observed queue.`);
        const target = matching[0]!;
        if (typeof target.version !== "number" || !Number.isSafeInteger(target.version) || target.version < 0) reject("queue_version_unknown", `Queued prompt ${JSON.stringify(promptId)} has no exact usable native version.`);
        input = { ...input, queue_target: { id: promptId, version: target.version } };
      }
      if (kind === "respond") {
        const requestId = typeof input.request_id === "string" ? input.request_id : "";
        const pending = this.value<Attention>("attention", requestId);
        if (!pending || pending.status !== "pending") throw new AgentError("attention_not_pending", "Attention request is not pending", "Read current attention; do not answer an expired or resolved request.");
        if (pending.response_operation_id !== undefined) throw new AgentError("attention_already_responded", "Attention response already admitted", "Inspect the existing response operation; do not submit a duplicate answer.");
        this.putRecord("attention", requestId, { ...pending, response_operation_id: operationId });
      }
      return this.insertOperation(kind, input, operationId);
    });
  }
  operations(): Operation[] { this.attest(); return this.values<Operation>("operation"); }
  pendingOperations(): Operation[] { this.attest(); return this.values<Operation>("operation", ["admitted", "started"]); }
  operation(id: string): Operation | null { this.attest(); return this.value<Operation>("operation", id); }
  private changeOperation(previous: Operation, patch: JsonRecord, meaningful = true): Operation {
    const next = { ...previous, ...patch, operation_id: previous.operation_id, sequence: previous.sequence, kind: previous.kind, input: previous.input, created_at: previous.created_at } as Operation;
    const allowed: Record<OperationStatus, OperationStatus[]> = { admitted: ["admitted", "started", "not_sent", "failed"], started: ["started", "completed", "failed", "outcome_unknown"], completed: ["completed"], failed: ["failed"], not_sent: ["not_sent"], outcome_unknown: ["outcome_unknown"] };
    if (!allowed[previous.status].includes(next.status)) throw new Error("Operation transition would replay or rewrite terminality");
    this.putRecord("operation", previous.operation_id, next, meaningful); return next;
  }
  updateOperation(claim: WorkerClaim, id: string, patch: JsonRecord, meaningful = true): Operation {
    return this.transaction(() => {
      this.assertOwner(claim); const previous = this.operation(id); if (!previous) throw new Error("Unknown operation");
      return this.changeOperation(previous, patch, meaningful);
    });
  }
  worker(): WorkerClaim | null { this.attest(); return this.getState<WorkerClaim>("worker"); }
  launch(): LaunchReservation | null { this.attest(); return this.getState<LaunchReservation>("launch"); }
  private assertProcessAbsent(claim: WorkerClaim, role: NativeProcessRole): void {
    const state = claim[`${role}_state`], identity = claim[role];
    if (state === "launching" || state === "running" && !identity) throw new Error(`${role} identity is unknown; absence is not established`);
    if (identity && processIdentityStatus(identity) !== "absent") throw new Error(`${role} absence is not established`);
  }
  private assertProviderAbsent(claim: WorkerClaim): void {
    this.assertProcessAbsent(claim, "provisioner");
    this.assertProcessAbsent(claim, "provider");
  }
  private settleAbandoned(error?: unknown): void {
    const meta = this.meta(), provisioning = meta.provisioning as JsonRecord | undefined;
    if (provisioning && ["starting", "running"].includes(String(provisioning.status))) {
      this.putState("meta", { ...meta, provisioning: { ...provisioning, status: "outcome_unknown",
        reason: "The prior worker is absent; native creation was not observed to settle." } });
    }
    for (const operation of this.values<Operation>("operation", ["admitted", "started"])) {
      const effects = operation.effects && typeof operation.effects === "object" && !Array.isArray(operation.effects)
        ? structuredClone(operation.effects) as JsonRecord : {};
      if (["follow_up", "send_now"].includes(operation.kind) && effects.prompt === undefined) {
        effects.prompt = { status: operation.native_prompt_id ? "unknown" : "not_sent",
          ...(operation.native_prompt_id ? { prompt_id: operation.native_prompt_id } : {}) };
      }
      if (operation.status === "admitted" && effects.configuration === undefined) {
        const configuration = Object.fromEntries(["model", "effort"].filter(field => operation.input[field] !== undefined)
          .map(field => [field, { value: operation.input[field], status: "not_sent" }]));
        if (Object.keys(configuration).length) effects.configuration = configuration;
      }
      // A submitted effect can have happened. Applied/rejected/not-sent facts survive intact.
      const uncertain = (value: unknown): void => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        const record = value as JsonRecord;
        if (record.status === "submitted") record.status = "unknown";
        for (const child of Object.values(record)) uncertain(child);
      };
      uncertain(effects);
      this.changeOperation(operation, { status: operation.status === "started" ? "outcome_unknown" : "not_sent", completed_at: now(),
        ...(error === undefined ? {} : { error }), ...(Object.keys(effects).length ? { effects } : {}) });
    }
    for (const attention of this.values<Attention>("attention", ["pending"])) this.expirePendingAttention(attention, "worker_absent", "worker_absent");
    for (const turn of this.values<Turn>("turn", ["running"])) {
      const ended = { ...turn, status: "unknown", source: "worker_absent", updated_at: now() };
      this.putRecord("turn", turn.prompt_id, ended); this.stoppedTurns.add(turn.prompt_id);
    }
    this.putRecord("queue", "queue", { unavailable: true, reason: "Prior resident worker is absent; native queue is not currently observed." });
  }
  /** Admission and the sole launch reservation commit together, before any child can start. */
  admitLaunch(input: JsonRecord, options: { operation_id: string; resume: boolean }): { operation: Operation; launch: LaunchReservation } {
    return this.transaction(() => {
      this.assertAdmission();
      const old = this.worker(), priorLaunch = this.launch(), meta = this.meta();
      if (!options.resume) {
        if (old || priorLaunch) throw new Error("Initial launch already reserved or claimed");
        if (input.resume === true) throw new Error("Initial launch cannot carry resume authority");
      } else {
        if (input.resume !== true || input.action !== undefined && input.action !== "follow_up") throw new Error("Resume requires an explicit new follow_up with resume:true");
        if (!priorLaunch) throw new Error("Resume requires a prior launch occurrence");
        // A reservation nothing can still claim never reached the provider: relaunch is safe.
        if (priorLaunch.state === "reserved" && mayStillClaim(priorLaunch)) {
          throw new Error("Unclaimed launch reservation may still be claimed; close fences it");
        }
        if (old) {
          if (processIdentityStatus(old.worker) !== "absent") throw new Error("Predecessor worker absence is not established");
          this.assertProviderAbsent(old);
        }
        if (meta.session_open_started && !meta.native_session_id) throw new Error("Native session identity is unknown; resume denied");
        this.settleAbandoned();
      }
      const operation = this.insertOperation("follow_up", input, options.operation_id);
      const launch: LaunchReservation = { token: randomUUID(), operation_id: operation.operation_id, resume: options.resume, state: "reserved", launcher: currentProcessIdentity(), created_at: now() };
      this.putState("launch", launch); this.putState("worker", null);
      this.putState("meta", { ...this.meta(), phase: "opening" }); this.bump();
      return { operation, launch };
    });
  }
  claim(token: string, worker: ProcessIdentity = currentProcessIdentity()): WorkerClaim {
    return this.transaction(() => {
      const launch = this.launch();
      if (!launch || launch.token !== token || launch.state !== "reserved" || this.meta().phase === "closed") throw new Error("Launch reservation fence rejected claim");
      if (this.worker()) throw new Error("Worker already claimed");
      const current = currentProcessIdentity();
      if (!sameIdentity(current, worker)) throw new Error("Worker claim must belong to the calling process");
      if (launch.worker && !sameIdentity(launch.worker, worker)) throw new Error("Launch worker identity conflicts with claim");
      const claim: WorkerClaim = { token, worker, claimed_at: now(), provider: null, provider_state: "not_attempted", provisioner: null, provisioner_state: "not_attempted" };
      this.ownerIdentity = current;
      this.putState("worker", claim); this.putState("launch", { ...launch, state: "claimed", worker }); this.bump();
      return claim;
    });
  }
  /** Late service receipts cannot resurrect a fenced reservation or replace a claimed child. */
  setLaunched(token: string, worker?: ProcessIdentity): void {
    if (!worker) return;
    this.transaction(() => {
      const launch = this.launch();
      if (!launch || launch.token !== token || launch.state === "fenced") return;
      const claim = this.worker();
      if (launch.worker && !sameIdentity(launch.worker, worker) || claim && (!sameIdentity(claim.worker, worker) || claim.token !== token)) throw new Error("Observed launch worker identity conflicts with ownership");
      if (launch.worker && sameIdentity(launch.worker, worker)) return;
      this.putState("launch", { ...launch, worker }); this.bump(false);
    });
  }
  /** A launch no child claimed settles as not sent; false when a child claimed it first and owns the outcome. */
  failLaunch(token: string, error: unknown): boolean {
    return this.transaction(() => {
      const launch = this.launch();
      if (!launch || launch.token !== token || launch.state === "fenced") return true;
      if (launch.state === "claimed") return false;
      if (launch.worker || this.worker()) throw new Error("Cannot certify launch failure after a child may exist");
      const operation = this.operation(launch.operation_id);
      if (!operation || operation.status !== "admitted") throw new Error("Launch operation is not an unstarted admission");
      const configuration = Object.fromEntries(["model", "effort"].filter(field => operation.input[field] !== undefined)
        .map(field => [field, { value: operation.input[field], status: "not_sent" }]));
      this.changeOperation(operation, { status: "not_sent", completed_at: now(), error,
        effects: { prompt: { status: "not_sent" }, ...(Object.keys(configuration).length ? { configuration } : {}) } });
      this.putState("launch", { ...launch, state: "fenced", failure: error });
      this.putState("meta", { ...this.meta(), phase: "disconnected" }); this.bump();
      return true;
    });
  }
  /** Close can retire an unclaimed reservation, or an exactly absent resident, without starting anything. */
  admitClose(operationId: string): Operation {
    return this.transaction(() => {
      const meta = this.meta();
      if (meta.phase === "closed") this.assertAdmission();
      const claim = this.worker(), launch = this.launch();
      if (claim) {
        const status = processIdentityStatus(claim.worker);
        if (status === "alive") { this.assertAdmission(); return this.insertOperation("close", { agent_id: this.agentId }, operationId); }
        if (status !== "absent") throw new Error("Worker absence is unobservable; close cannot retire it");
        this.assertProviderAbsent(claim);
      }
      // A reserved child must claim before provider launch. Fencing here is safe
      // even when the service never observed its process identity.
      const reason = launch?.state === "reserved" ? "unclaimed_launch_fenced" : "resident_absent";
      if (launch) this.putState("launch", { ...launch, state: "fenced" });
      this.settleAbandoned(); this.putState("worker", null);
      const admitted = this.insertOperation("close", { agent_id: this.agentId }, operationId);
      const started = this.changeOperation(admitted, { status: "started", started_at: now() }, false);
      const operation = this.changeOperation(started, { status: "completed", completed_at: now(), result: { retired: true, native: null, process: null, reason } });
      this.putState("meta", { ...this.meta(), phase: "closed" }); this.bump(); return operation;
    });
  }
  assertOwner(claim: WorkerClaim): void {
    const current = this.worker();
    this.ownerIdentity ??= currentProcessIdentity();
    const launch = this.launch();
    if (!current || current.token !== claim.token || launch?.token !== claim.token || launch.state !== "claimed"
        || current.worker.pid !== process.pid || !sameIdentity(current.worker, claim.worker) || !sameIdentity(this.ownerIdentity, current.worker)) throw new Error("Worker ownership fence rejected mutation");
  }
  processStarting(claim: WorkerClaim, role: NativeProcessRole = "provider"): void {
    this.transaction(() => {
      this.assertOwner(claim); const current = this.worker()!;
      if (current[`${role}_state`] !== "not_attempted") throw new Error(`${role} launch has already been attempted`);
      this.putState("worker", { ...current, [role]: null, [`${role}_state`]: "launching" }); this.bump(false);
    });
  }
  processNotLaunched(claim: WorkerClaim, role: NativeProcessRole = "provider"): void {
    this.transaction(() => {
      this.assertOwner(claim); const current = this.worker()!;
      if (current[`${role}_state`] !== "launching" || current[role] !== null) throw new Error(`${role} no-child result is not established`);
      this.putState("worker", { ...current, [`${role}_state`]: "not_launched" }); this.bump();
    });
  }
  setProcess(claim: WorkerClaim, identity: ProcessIdentity | null, role: NativeProcessRole = "provider"): void {
    this.transaction(() => {
      this.assertOwner(claim); const current = this.worker()!;
      if (identity) {
        if (current[`${role}_state`] !== "launching" || processIdentityStatus(identity) !== "alive") throw new Error(`${role} launch identity is not established`);
        this.putState("worker", { ...current, [role]: identity, [`${role}_state`]: "running" });
      } else {
        this.assertProcessAbsent(current, role);
        this.putState("worker", { ...current, [`${role}_state`]: "ended" });
      }
      this.bump();
    });
  }
  release(claim: WorkerClaim, options?: { disconnect_error: unknown; cleanup_receipt?: JsonRecord }): void {
    this.transaction(() => {
      this.assertOwner(claim); const current = this.worker()!;
      this.assertProviderAbsent(current);
      if (options) {
        // The failed worker has stopped dispatching. Admission and this final
        // disposition share the write lock: a close is either retired here or
        // sees no resident and takes the ordinary local-retirement route.
        const close = this.values<Operation>("operation", ["admitted", "started"]).find(operation => operation.kind === "close");
        if (close) {
          const receipt = { native: null, process: null, ...options.cleanup_receipt,
            retired: true, reason: "failed_worker_cleanup" };
          const started = close.status === "admitted" ? this.changeOperation(close, { status: "started", started_at: now() }, false) : close;
          const unknown = close.status === "started" || options.cleanup_receipt?.native_error !== undefined;
          this.changeOperation(started, { status: unknown ? "outcome_unknown" : "completed", completed_at: now(), result: receipt,
            ...(unknown ? { error: options.cleanup_receipt?.native_error ?? options.disconnect_error } : {}) });
        }
        this.settleAbandoned(options.disconnect_error);
        const meta = this.meta();
        this.putState("meta", { ...meta, phase: close || meta.phase === "closed" ? "closed" : "disconnected" });
      } else if (this.count("operation", ["admitted", "started"])) throw new Error("Cannot release unfinished operations");
      this.putState("worker", null); this.bump();
    });
  }
  appendContent(claim: WorkerClaim, row: ContentInput): ContentRow {
    if (typeof row.prompt_id !== "string" || !row.prompt_id || !Number.isSafeInteger(row.block_index) || row.block_index < 0 || typeof row.text !== "string") throw new Error("Invalid observed content block");
    return this.transaction(() => {
      this.assertOwner(claim);
      const stored = this.putRecord("content", randomUUID(), row, false);
      // Text that arrives after its turn stopped still reaches the turn's file.
      const turn = this.value<Turn>("turn", row.prompt_id);
      if (turn && turn.status !== "running") this.stoppedTurns.add(row.prompt_id);
      return { ...row, seq: stored.seq };
    });
  }
  appendSideAnswer(claim: WorkerClaim, row: JsonRecord & { operation_id: string; text: string }): void {
    if (!row.operation_id || typeof row.text !== "string") throw new Error("Invalid side answer");
    this.transaction(() => {
      this.assertOwner(claim);
      const operation = this.operation(row.operation_id);
      if (!operation || operation.kind !== "side_question") throw new Error("Side answer requires its exact side-question operation");
      const previous = this.value<JsonRecord>("side_answer", row.operation_id);
      if (previous) {
        if (isDeepStrictEqual(previous, row)) return;
        throw new Error("Side answer is immutable");
      }
      this.putRecord("side_answer", row.operation_id, row);
    });
  }
  observation(type: SingletonObservation | KeyedObservation, id: string = type): JsonRecord | null { this.attest(); return this.value(type, id); }
  setObservation(claim: WorkerClaim, type: SingletonObservation, value: JsonRecord, meaningful = true): void {
    this.transaction(() => { this.assertOwner(claim); this.putRecord(type, type, value, meaningful); });
  }
  upsertObservation(claim: WorkerClaim, type: KeyedObservation, id: string, value: JsonRecord, meaningful = true): void {
    if (!id) throw new Error("Native observation requires an exact identity");
    this.transaction(() => { this.assertOwner(claim); this.putRecord(type, id, value, meaningful); });
  }
  turn(promptId: string): Turn | null { this.attest(); return this.value<Turn>("turn", promptId); }
  upsertTurn(claim: WorkerClaim, turn: Turn, meaningful = true): string[] {
    if (!turn.prompt_id || !turn.status || !turn.source) throw new Error("Invalid native turn");
    return this.transaction(() => {
      this.assertOwner(claim); const previous = this.value<Turn>("turn", turn.prompt_id);
      if (previous && previous.status !== "running" && turn.status === "running") throw new Error("Native terminal turn cannot return to running");
      if (turn.status !== "running") this.stoppedTurns.add(turn.prompt_id);
      this.putRecord("turn", turn.prompt_id, turn, meaningful);
      const expired: string[] = [];
      if (this.authoritativeCancellation(turn)) {
        for (const attention of this.values<Attention>("attention", ["pending"])) {
          if (attention.prompt_id === turn.prompt_id && this.expirePendingAttention(attention, "prompt_cancelled", turn.source)) expired.push(attention.request_id);
        }
      }
      return expired;
    });
  }
  runningTurns(): Turn[] { this.attest(); return this.values<Turn>("turn", ["running"]); }
  issue(claim: WorkerClaim, issue: JsonRecord): void {
    this.transaction(() => {
      this.assertOwner(claim); this.putRecord("issue", randomUUID(), issue);
    });
  }
  promptInput(promptId: string): JsonRecord | null {
    this.attest(); return decode<JsonRecord>(this.db.prepare("SELECT value FROM prompt_inputs WHERE id=?").get(promptId));
  }
  setPromptInput(claim: WorkerClaim, promptId: string, input: JsonRecord): void {
    if (!promptId || !Array.isArray(input.attachments)) throw new Error("Prepared prompt input requires exact attachment records");
    this.transaction(() => {
      this.assertOwner(claim); const previous = this.promptInput(promptId);
      if (previous) {
        if (isDeepStrictEqual(previous, input)) return;
        throw new Error("Prepared prompt input is immutable");
      }
      this.db.prepare("INSERT INTO prompt_inputs VALUES (?,?)").run(promptId, JSON.stringify(input));
    });
  }
  private authoritativeCancellation(turn: Turn | null): turn is Turn {
    return turn?.status === "cancelled" && ["prompt_response", "turn_completed"].includes(turn.source);
  }
  /** Called only under the write lock: preserve the exact request and admitted answer association. */
  private expirePendingAttention(attention: Attention, reason: string, source: string): boolean {
    if (attention.status !== "pending") return false;
    const expiredAt = now();
    this.putRecord("attention", attention.request_id, { ...attention, status: "expired", reason, source, expired_at: expiredAt });
    if (typeof attention.response_operation_id === "string") {
      const operation = this.value<Operation>("operation", attention.response_operation_id);
      if (operation?.kind === "respond" && operation.status === "admitted") {
        this.changeOperation(operation, { status: "not_sent", completed_at: expiredAt,
          error: failure(new AgentError("attention_not_pending", "The native attention request expired before its admitted answer was submitted.",
            "Read the expired attention and retained response operation; do not replay this answer.", { request_id: attention.request_id, reason, source })) });
      }
    }
    return true;
  }
  expireAttention(claim: WorkerClaim, requestId: string, reason: string, source: string): boolean {
    return this.transaction(() => {
      this.assertOwner(claim); const attention = this.value<Attention>("attention", requestId);
      return attention ? this.expirePendingAttention(attention, reason, source) : false;
    });
  }
  /** Native closure of one tool interaction is independent of its prompt's completion. */
  resolveNativeInteraction(claim: WorkerClaim, toolCallId: string): string[] {
    return this.transaction(() => {
      this.assertOwner(claim);
      const expired: string[] = [];
      for (const attention of this.values<Attention>("attention", ["pending"])) {
        if (attentionToolCallId(attention.method, attention.payload) === toolCallId
          && this.expirePendingAttention(attention, "interaction_resolved", "native_interaction_resolved")) expired.push(attention.request_id);
      }
      return expired;
    });
  }
  upsertAttention(claim: WorkerClaim, attention: Attention): Attention {
    if (!attention.method || typeof attention.method !== "string" || Object.hasOwn(attention, "kind")) throw new Error("Attention requires exact native method, not a wrapper kind");
    return this.transaction(() => {
      this.assertOwner(claim); const previous = this.value<Attention>("attention", attention.request_id);
      if (previous && previous.status !== "pending" && attention.status === "pending") throw new Error("Ended attention cannot be reopened");
      const next: Attention = { ...previous, ...attention,
        ...(previous?.response_operation_id === undefined ? {} : { response_operation_id: previous.response_operation_id }) };
      this.putRecord("attention", attention.request_id, next);
      const turn = typeof next.prompt_id === "string" ? this.value<Turn>("turn", next.prompt_id) : null;
      if (this.authoritativeCancellation(turn)) this.expirePendingAttention(next, "prompt_cancelled", turn.source);
      return this.value<Attention>("attention", attention.request_id)!;
    });
  }
  resolveAttention(claim: WorkerClaim, id: string, patch: JsonRecord = {}): void {
    this.transaction(() => {
      this.assertOwner(claim); const previous = this.value<Attention>("attention", id); if (!previous || previous.status !== "pending") throw new Error("Attention is not pending");
      this.putRecord("attention", id, { ...previous, ...patch, request_id: id, status: "resolved",
        ...(previous.response_operation_id === undefined ? {} : { response_operation_id: previous.response_operation_id }) });
    });
  }
  getAttention(id: string): Attention | null { this.attest(); return this.value<Attention>("attention", id); }
  attention(): Attention[] { this.attest(); return this.values<Attention>("attention"); }
  /** Mutable native references, scoped to their exact prompt/tool; never inspect or acquire file bytes. */
  upsertFile(claim: WorkerClaim, file: NativeFileInput): NativeFile {
    if (!(typeof file.path === "string" && file.path) && !(typeof file.uri === "string" && file.uri)) throw new Error("Native file reference requires a path or URI");
    return this.transaction(() => {
      this.assertOwner(claim);
      const metadata = Object.fromEntries(Object.entries(file).filter(([key, value]) => key !== "reference_id" && value !== undefined));
      const scoped = this.values<NativeFile>("file").filter(previous => previous.prompt_id === file.prompt_id && previous.tool_call_id === file.tool_call_id);
      const direct = scoped.filter(previous => previous.path === file.path && previous.uri === file.uri);
      const exact = scoped.filter(previous => (file.path === undefined || previous.path === file.path) && (file.uri === undefined || previous.uri === file.uri));
      const locations = (value: JsonRecord): Set<string> => {
        const keys = new Set<string>();
        if (typeof value.path === "string" && value.path) keys.add(`path:${value.path}`);
        if (typeof value.uri === "string" && value.uri) {
          keys.add(`uri:${value.uri}`);
          try { keys.add(`path:${fileURLToPath(value.uri)}`); } catch { /* Non-local URI remains an exact native reference. */ }
        }
        return keys;
      };
      const keys = locations(file);
      const aliases = scoped.filter(previous => [...locations(previous)].some(key => keys.has(key)));
      // A bridge between two different owners is new evidence, not permission to merge their identities.
      const previous = direct.length === 1 ? direct[0] : exact.length === 1 ? exact[0] : aliases.length === 1 ? aliases[0] : undefined;
      const next: NativeFile = { ...previous, ...metadata, reference_id: previous?.reference_id ?? `file_${randomUUID()}` };
      this.putRecord("file", next.reference_id, next);
      return next;
    });
  }
  files(): NativeFile[] { this.attest(); return this.values<NativeFile>("file"); }
  /** The operation that submitted this native prompt, when grokpair sent it. */
  operationForPrompt(promptId: string): string | null {
    this.attest();
    const row = this.db.prepare("SELECT id FROM records WHERE type='operation' AND prompt_id=? ORDER BY seq LIMIT 1").get(promptId) as { id: string } | undefined;
    return row?.id ?? null;
  }
  /** Publish only a file that still matches the authoritative finished turn, even after a failed rewrite. */
  turnFile(promptId: string): string | null {
    try {
      const path = this.turnPath(promptId);
      if (!existsSync(path)) return null;
      const text = this.renderTurnFile(promptId);
      return text !== null && readFileSync(path).equals(Buffer.from(text)) ? path : null;
    } catch { return null; }
  }
  private turnPath(promptId: string): string {
    // Lowercase only: two ids that differ by case would share a file on a case-insensitive volume.
    const name = /^[a-z0-9][a-z0-9_-]{0,127}$/.test(promptId) ? promptId : createHash("sha256").update(promptId).digest("hex");
    return join(this.root, "turns", `${name}.md`);
  }
  private renderTurnFile(promptId: string): string | null {
    const turn = this.value<Turn>("turn", promptId);
    if (!turn || turn.status === "running") return null;
    let text = "";
    for (const row of this.db.prepare("SELECT value FROM records WHERE type='content' AND prompt_id=? ORDER BY seq").all(turn.prompt_id)) {
      const block = decode<ContentInput & { block_start?: boolean }>(row)!;
      text += `${block.block_start === true && block.block_index > 0 ? "\n\n" : ""}${block.text}`;
    }
    const operationId = this.operationForPrompt(turn.prompt_id), operation = operationId ? this.operation(operationId) : null;
    const meta = this.meta();
    const header = { agent_id: this.agentId, prompt_id: turn.prompt_id, ...(operationId ? { operation_id: operationId } : {}),
      status: turn.status, ...(typeof turn.stop_reason === "string" ? { stop_reason: turn.stop_reason } : {}), cwd: meta.cwd,
      execution_cwd: meta.execution_cwd, worktree_root: meta.worktree_root ?? null,
      sandbox_argument: meta.sandbox_argument, sandbox_observation: "unavailable",
      ...(typeof operation?.input.task === "string" ? { task: operation.input.task } : {}) };
    // JSON scalars are valid YAML, so the front matter stays exact for any brief.
    const front = Object.entries(header).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
    return `---\n${front}\n---\n\n${text}\n`;
  }
  /** A turn that stopped running is also kept as a plain file that outlives every process; the database stays authoritative. */
  private writeTurnFile(promptId: string): void {
    try {
      const text = this.renderTurnFile(promptId);
      if (text === null) return;
      const path = this.turnPath(promptId), temporary = `${path}.${randomUUID()}.tmp`;
      try { mkdirSync(dirname(path), { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    } catch {}
  }
}

/** One shared index keeps a caller key bound to at most one open collaborator. */
export class KeyRegistry {
  private constructor(private readonly db: DatabaseSync) {}
  static open(environment: NodeJS.ProcessEnv = process.env): KeyRegistry {
    const path = join(canonical(runtimeCoordinates(environment), true), "keys.sqlite");
    // Created private and exclusive like a collaborator database; an existing one must be a regular file.
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    regular(path);
    const db = new DatabaseSync(path);
    // A racing keyed spawn waits while another admits its collaborator under the lock, and then sees it as existing.
    try { db.exec("PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, agent_id TEXT NOT NULL);"); }
    catch (error) { db.close(); throw error; }
    return new KeyRegistry(db);
  }
  /** Read-only lookup for listing; no registry file means no key has a holder. */
  static holderOf(key: string, environment: NodeJS.ProcessEnv = process.env): string | null {
    const path = join(runtimeCoordinates(environment), "keys.sqlite");
    if (!existsSync(path)) return null;
    regular(path);
    const db = new DatabaseSync(path, { readOnly: true });
    try { db.exec("PRAGMA busy_timeout=5000;"); return new KeyRegistry(db).holder(key); } finally { db.close(); }
  }
  holder(key: string): string | null {
    return (this.db.prepare("SELECT agent_id FROM keys WHERE key=?").get(key) as { agent_id: string } | undefined)?.agent_id ?? null;
  }
  /** An open holder is returned instead of admitting another collaborator. Holders are observed outside the
   * write lock; the claim commits only if the key still names the holder that was observed. */
  claim<T>(key: string, isOpen: (agentId: string) => boolean, admit: () => { agent_id: string; value: T }): { holder: string } | { value: T } {
    while (true) {
      const observed = this.holder(key);
      if (observed && isOpen(observed)) return { holder: observed };
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (this.holder(key) !== observed) { this.db.exec("ROLLBACK"); continue; }
        const admitted = admit();
        this.db.prepare("INSERT INTO keys VALUES (?,?) ON CONFLICT(key) DO UPDATE SET agent_id=excluded.agent_id").run(key, admitted.agent_id);
        this.db.exec("COMMIT"); return { value: admitted.value };
      } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
    }
  }
  close(): void { this.db.close(); }
}
function sameIdentity(a: ProcessIdentity, b: ProcessIdentity): boolean { return a.pid === b.pid && a.birth === b.birth; }
/** A reservation can still be claimed while its recorded worker, or else the process that reserved it, is not proved gone. */
export function mayStillClaim(launch: LaunchReservation): boolean {
  return processIdentityStatus(launch.worker ?? launch.launcher) !== "absent";
}
export function listAgentIds(environment: NodeJS.ProcessEnv = process.env): string[] {
  const root = join(runtimeCoordinates(environment), "agents"); canonical(root);
  try { return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && AGENT_ID.test(entry.name)).map(entry => entry.name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
