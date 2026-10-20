import { randomUUID } from "node:crypto";
import { RequestError, type ContentBlock } from "@agentclientprotocol/sdk";
import { AgentError, COLLABORATOR_MARKER, failure, id, now } from "./core.js";
import { AgentStore, promptActivity, type AgentMeta, type Operation, type WorkerClaim } from "./agent-store.js";
import { currentProcessIdentity } from "./process.js";
import { NativeConnection, nativeToolFailure, row, string, unwrap, type Row } from "./native.js";
import { attentionToolCallId, parseAttention, unwrapAttentionParams, validateAttentionResponse, type Attention } from "./attention.js";
import { prepareAttachments, provisionWorkspace, validateNativeWorkspace, assertQueuedEditInput, type AttachmentInput, type PreparedAttachments, type PreparedWorkspacePlan } from "./workspace.js";
import { validateWorkspace, workspaceBoundaries } from "./filesystem.js";
import type { SearchInput } from "./agent-schema.js";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const array = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
type LiveAttention = { attention: Attention; resolve(value: unknown): void; reject(error: unknown): void; signal: AbortSignal; dispose(): void };

/** One resident actor owns all native input and semantic mutation. No idle lease. */
class Worker {
  private native: NativeConnection | undefined;
  private sessionId: string | undefined;
  private ready = false;
  private closing = false;
  private stopped = false;
  private fatalError: unknown;
  private readonly running = new Set<Promise<void>>();
  private readonly pending = new Map<string, LiveAttention>();
  private readonly endedInteractions = new Set<string>();
  private readonly blocks = new Map<string, { index: number; message?: string; open: boolean }>();
  private readonly toolPrompts = new Map<string, string>();
  private readonly toolTitles = new Map<string, string>();
  private submissionTail = Promise.resolve();
  private readonly provisionAbort = new AbortController();
  private provisioning: Promise<unknown> | undefined;

  constructor(private readonly store: AgentStore, private readonly claim: WorkerClaim, private readonly environment: NodeJS.ProcessEnv) {}
  private meta(): AgentMeta { return this.store.meta(); }
  private patch(patch: Partial<AgentMeta>, meaningful = true): void { this.store.setMeta(this.claim, patch, meaningful); }
  private issue(code: string, message: string, extra: Row = {}): void {
    this.store.issue(this.claim, { code, message, ...extra });
  }
  private turn(promptId: string, patch: Row, meaningful = true): void {
    const previous = this.store.turn(promptId);
    if (previous && previous.status !== "running" && patch.status === "running") return;
    const expired = this.store.upsertTurn(this.claim, { ...previous, prompt_id: promptId, status: String(patch.status), source: String(patch.source), ...patch, updated_at: now() }, meaningful);
    for (const requestId of expired) this.rejectAttention(requestId, "Native prompt was cancelled");
  }
  private nativeOptions(response: Row): void {
    const options = response.configOptions ?? row(row(response._meta)["x.ai/sessionConfig"]).options;
    if (Array.isArray(options)) {
      this.native?.acceptOptions(response);
      this.store.setObservation(this.claim, "native_options", { options });
    }
  }
  private observe(method: string, value: unknown): void {
    if (this.stopped) return;
    const params = unwrap(method, value), meta = row(params._meta), update = row(params.update);
    if (method === "_x.ai/session/update" || meta.isReplay === true || params.sessionId !== this.sessionId) return;
    if (method === "_x.ai/queue/changed") {
      const { sessionId: _, ...queue } = params;
      this.store.setObservation(this.claim, "queue", queue); return;
    }
    if (method === "elicitation/complete" || method === "_x.ai/mcp/elicit_complete") {
      const nativeId = string(params.elicitationId);
      const key = nativeId ? JSON.stringify([params.sessionId, params.serverName, nativeId]) : `notice_${randomUUID()}`;
      this.store.upsertObservation(this.claim, "elicitation_completion", key, { method, payload: params });
      return;
    }
    const promptId = string(method === "session/update" ? meta.promptId : update.prompt_id);
    const type = string(update.sessionUpdate);
    if (method === "_x.ai/session_notification" && type === "pending_interaction") {
      const toolCallId = string(update.tool_call_id);
      if (toolCallId) this.endedInteractions.delete(toolCallId);
      return;
    }
    if (method === "_x.ai/session_notification" && type === "interaction_resolved") {
      const toolCallId = string(update.tool_call_id);
      if (toolCallId) {
        this.endedInteractions.add(toolCallId);
        for (const requestId of this.store.resolveNativeInteraction(this.claim, toolCallId)) {
          this.rejectAttention(requestId, "Native interaction ended");
        }
      }
      return;
    }
    if (method === "_x.ai/session_notification" && type === "image_dropped") {
      // These notes distinguish exclusion from one request from removal from
      // the conversation. Preserve the native event, not an inferred failure.
      const notes = Array.isArray(update.notes) ? update.notes.filter((note): note is string => typeof note === "string") : [];
      this.issue("native_image_dropped", notes.join("\n") || "Native provider reported an image exclusion", {
        method, payload: params, ...(promptId ? { prompt_id: promptId } : {}),
      });
      return;
    }
    if (method === "session/update" && promptId) {
      const content = row(update.content);
      if (type === "agent_message_chunk" && content.type === "text" && typeof content.text === "string") {
        const message = string(update.messageId), previous = this.blocks.get(promptId);
        const continues = !!previous && previous.open && previous.message === message;
        const index = continues ? previous.index : (previous?.index ?? -1) + 1;
        this.blocks.set(promptId, { index, ...(message ? { message } : {}), open: true });
        this.store.appendContent(this.claim, { prompt_id: promptId, block_index: index, text: content.text,
          ...(message ? { native_message_id: message } : {}), ...(continues ? {} : { block_start: true }) });
        if (!this.store.turn(promptId)) this.turn(promptId, { status: "running", source: "live_update" }, false);
      } else {
        const previous = this.blocks.get(promptId); if (previous) previous.open = false;
      }
    }
    if (method === "session/update" && (type === "tool_call" || type === "tool_call_update")) {
      const toolId = string(update.toolCallId);
      if (toolId && promptId) this.toolPrompts.set(toolId, promptId);
      if (toolId && string(update.title)) this.toolTitles.set(toolId, String(update.title));
      const owner = promptId ?? (toolId ? this.toolPrompts.get(toolId) : undefined);
      this.files(update, owner, toolId);
      if (update.status === "failed") {
        const { message, ...diagnostics } = nativeToolFailure(update);
        const title = toolId ? this.toolTitles.get(toolId) : string(update.title);
        this.issue("native_tool_failed", message, { ...diagnostics, ...(title ? { title } : {}), ...(owner ? { prompt_id: owner } : {}), ...(toolId ? { tool_call_id: toolId } : {}) });
      }
    }
    if (method === "_x.ai/session_notification" && type === "turn_completed" && promptId) {
      const stop = string(update.stop_reason);
      this.turn(promptId, { status: stop === "cancelled" ? "cancelled" : "completed", source: "turn_completed", ...(stop ? { stop_reason: stop } : {}) });
    }
    if (type === "config_option_update") this.nativeOptions(update);
    if (type === "task_backgrounded" || type === "task_completed" || method === "_x.ai/task_backgrounded" || method === "_x.ai/task_completed") {
      const payload = Object.keys(update).length ? update : params;
      const completed = type === "task_completed" || method === "_x.ai/task_completed";
      const taskId = string(completed ? row(payload.task_snapshot).task_id : payload.task_id);
      const key = taskId ?? `uncorrelated_background_${randomUUID()}`;
      const previous = taskId ? this.store.observation("background", key) : null;
      this.store.upsertObservation(this.claim, "background", key, {
        ...(taskId ? { task_id: taskId } : { correlation: "unknown", background_record_id: key }),
        observations: { ...row(previous?.observations), [completed ? "completed" : "backgrounded"]: { method, payload } },
      });
      if (!taskId) this.issue("background_identity_missing", "Native background event has no task_id at its method-defined location.", { method, background_record_id: key });
    }
  }
  private files(update: Row, promptId?: string, toolId?: string): void {
    const publish = (value: Row): void => {
      const path = string(value.path), uri = string(value.uri);
      if (!path && !uri) return;
      this.store.upsertFile(this.claim, { source: "native",
        ...(path ? { path } : {}), ...(uri ? { uri } : {}),
        ...(string(value.mimeType) ? { mime_type: value.mimeType } : {}), ...(string(value.name) ? { name: value.name } : {}),
        ...(Object.hasOwn(value, "description") ? { description: value.description } : {}),
        ...(Object.hasOwn(value, "size") ? { size: value.size } : {}),
        ...(Object.hasOwn(value, "_meta") ? { _meta: value._meta } : {}),
        ...(promptId ? { prompt_id: promptId } : {}), ...(toolId ? { tool_call_id: toolId } : {}) });
    };
    for (const item of array(update.content)) {
      if (item.type === "resource_link" || item.type === "diff") publish(item);
      const content = row(item.content);
      if (content.type === "resource_link") publish(content);
      if (content.type === "resource") publish(row(content.resource));
    }
    for (const location of array(update.locations)) publish(location);
    const output = row(update.rawOutput);
    // Exact structured native references, independent of a changing media tool
    // roster. A reference is not a claim that a file was created or acquired.
    if (string(output.path) || string(output.uploaded_url)) {
      publish({ path: output.path, uri: output.uploaded_url, name: output.filename,
        ...(Object.hasOwn(output, "mime_type") ? { mimeType: output.mime_type } : {}) });
    }
  }
  private requestAttention(method: string, value: unknown, signal: AbortSignal): Promise<unknown> {
    let params: Row;
    try { params = unwrapAttentionParams(method, value); } catch { params = row(value); }
    if (this.closing || signal.aborted || params.sessionId !== undefined && params.sessionId !== this.sessionId) return Promise.reject(new Error("Native attention is not live for this session"));
    const requestId = id("request"), promptId = string(row(params._meta).promptId) ?? this.toolPrompts.get(String(params.toolCallId ?? row(params.toolCall).toolCallId));
    let attention: Attention | null;
    try { attention = parseAttention(method, value); }
    catch (error) {
      const diagnostic = failure(error, "invalid_native_attention");
      this.store.upsertAttention(this.claim, { request_id: requestId, method, payload: params, status: "rejected", error: diagnostic,
        ...(promptId ? { prompt_id: promptId } : {}) });
      return Promise.reject(new RequestError(-32602, diagnostic.message, diagnostic));
    }
    if (!attention) return Promise.reject(new RequestError(-32601, "Unsupported native attention method"));
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.store.expireAttention(this.claim, requestId, "request_aborted", "native_abort");
        this.rejectAttention(requestId, "Native attention request ended");
      };
      const toolCallId = attentionToolCallId(method, attention.payload);
      // The native gateway forwards requests and notifications independently.
      // Keep an observed closure if its RPC arrives later; a new native
      // pending_interaction explicitly reopens that tool identity.
      const ended = toolCallId !== undefined && this.endedInteractions.has(toolCallId);
      const stored = this.store.upsertAttention(this.claim, { request_id: requestId, ...attention,
        status: ended ? "expired" : "pending", ...(promptId ? { prompt_id: promptId } : {}),
        ...(ended ? { reason: "interaction_resolved", source: "native_interaction_resolved", expired_at: now() } : {}) });
      if (stored.status !== "pending") { reject(new Error("Native attention already ended")); return; }
      this.pending.set(requestId, { attention, resolve, reject, signal, dispose: () => signal.removeEventListener("abort", abort) });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  private rejectAttention(requestId: string, message: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId); pending.dispose(); pending.reject(new Error(message));
  }
  private fail(error: unknown): void { this.fatalError ??= error; }
  private async bootstrap(): Promise<void> {
    const meta = this.meta(), existing = string(meta.native_session_id);
    const plan = meta.workspace_plan as PreparedWorkspacePlan, boundaries = workspaceBoundaries(this.environment);
    const environment = { ...this.environment, [COLLABORATOR_MARKER]: this.store.agentId };
    const sandbox = meta.sandbox_argument ?? undefined;
    let cwd: string;
    if (typeof meta.prepared_cwd === "string") {
      cwd = meta.prepared_cwd;
      validateNativeWorkspace(plan, cwd, string(meta.worktree_root), boundaries);
    } else {
      if (meta.worktree && meta.provisioning !== undefined) throw new AgentError("worktree_context_unavailable",
        "A previous provisioning attempt has no validated directory; creation will not be repeated.",
        "Inspect the retained provisioning outcome and native worktree list. Preserve created work; resume cannot invent a missing directory.");
      const record = (patch: Row) => this.patch({ provisioning: { ...row(this.meta().provisioning), ...patch } });
      const preparation = provisionWorkspace(plan, sandbox, {
        signal: this.provisionAbort.signal,
        starting: () => { this.store.processStarting(this.claim, "provisioner"); record({ status: "starting" }); },
        notLaunched: () => { this.store.processNotLaunched(this.claim, "provisioner"); record({ status: "not_launched" }); },
        started: identity => { this.store.setProcess(this.claim, identity, "provisioner"); record({ status: "running", process: identity }); },
        returned: path => record({ returned_cwd: path }),
        exited: exit => {
          this.store.setProcess(this.claim, null, "provisioner");
          record({ status: exit.code === 0 ? "outcome_unknown" : "failed", exit: { code: exit.code, signal: exit.signal } });
        },
      }, environment, boundaries);
      this.provisioning = preparation;
      let workspace;
      try { workspace = await preparation; }
      catch (error) {
        if (meta.worktree) {
          const current = row(this.meta().provisioning);
          record({ status: current.status === "not_launched" || current.status === "failed" ? current.status : "outcome_unknown", error: failure(error) });
        }
        throw error;
      }
      cwd = workspace.cwd;
      this.patch({ prepared_cwd: cwd, ...(workspace.worktree_root ? { worktree_root: workspace.worktree_root } : {}) });
      if (meta.worktree) record({ status: "completed" });
    }
    validateWorkspace(meta.cwd, boundaries);
    if (this.closing) return;
    this.native = new NativeConnection(cwd, sandbox, {
      starting: () => this.store.processStarting(this.claim),
      notLaunched: () => this.store.processNotLaunched(this.claim),
      started: identity => { this.store.setProcess(this.claim, identity); this.patch({ execution_cwd: cwd }); },
      initialized: response => this.store.setObservation(this.claim, "native_capabilities", {
        protocol_version: response.protocolVersion,
        ...(Object.hasOwn(response, "agentInfo") ? { agent_info: response.agentInfo } : {}),
        ...(Object.hasOwn(response, "agentCapabilities") ? { capabilities: response.agentCapabilities } : {}),
      }),
      notification: (method, params) => this.observe(method, params),
      attention: (method, params, signal) => this.requestAttention(method, params, signal),
      failure: error => this.fail(error),
    }, environment);
    const initialization = await this.native.initialize();
    this.nativeOptions(row(initialization));
    if (this.closing) return;
    if (!existing && meta.session_open_started) throw new AgentError("session_identity_unknown", "A prior session request lost its response", "Preserve prior work; explicit resume cannot invent a native session identity.");
    this.sessionId = existing ?? randomUUID();
    this.patch({ session_open_started: true }, false);
    const session = await this.native.session(cwd, this.sessionId, !!existing);
    this.patch({ native_session_id: this.sessionId }); this.nativeOptions(session);
    if (this.closing) return;
    this.ready = true; this.patch({ phase: "ready" });
  }
  private guidance(): string {
    const meta = this.meta();
    const placement = meta.worktree
      ? `Your source context is ${JSON.stringify(meta.cwd)}; your isolated execution directory is ${JSON.stringify(meta.execution_cwd)}. Map source paths in the brief to their corresponding locations in this tree for edits; do not edit the original checkout or apply changes back. The caller inspects and integrates your contribution.`
      : `Work in ${JSON.stringify(meta.execution_cwd)} within the brief's file and effect boundaries.`;
    return `This contribution was delegated by another agent. Return your answer and files to that calling agent, not directly to the human user or anyone else. Do not send messages, contact people or publish unless this brief explicitly delegates that effect and destination. ${placement} Use your relevant native tools and skills. The brief governs authority, including discovery and alternative methods; a directory is not permission to change everything in it. The caller retains acceptance, credentials, commits and publication. Report native restrictions or denials; do not broaden the execution profile or move application state to bypass them.`;
  }
  private async richInput(operation: Operation): Promise<{ content: ContentBlock[]; metadata: Row; inputs: PreparedAttachments["inputs"] }> {
    const input = operation.input, prepared = await prepareAttachments((input.attachments ?? []) as AttachmentInput[]);
    const metadata: Row = { clientIdentifier: this.store.agentId, sendNow: operation.kind === "send_now" };
    if (input.search !== undefined) {
      const overrides = row(row(this.native!.initialization.agentCapabilities?._meta)["x.ai/capabilities"]).toolOverrides;
      if (overrides !== true && (overrides === null || typeof overrides !== "object")) throw new AgentError("search_unavailable", "Native per-prompt search overrides are not advertised", "Omit the overrides or use a native provider that supports them.");
      const search = input.search as SearchInput;
      metadata.toolOverrides = search;
    }
    // Task text stays its own exact block; instructions never overwrite it.
    return { content: [{ type: "text", text: String(input.task) }, { type: "text", text: this.guidance() }, ...prepared.blocks], metadata, inputs: prepared.inputs };
  }
  private started(operation: Operation, patch: Row = {}): void { this.store.updateOperation(this.claim, operation.operation_id, { status: "started", started_at: now(), ...patch }, false); }
  private completed(operation: Operation, result: unknown): void { this.store.updateOperation(this.claim, operation.operation_id, { status: "completed", completed_at: now(), result }); }
  private async submit<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.submissionTail;
    let release!: () => void;
    this.submissionTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }
  private async execute(operation: Operation): Promise<void> {
    let dispatched = false;
    let configurationFailure: Row | undefined;
    const effects: Row = {};
    const recordEffects = () => this.store.updateOperation(this.claim, operation.operation_id, { effects }, true);
    try {
      const input = operation.input, native = this.native!;
      if (operation.kind === "close") { await this.close(operation); return; }
      if (!this.sessionId) throw new Error("Native session is unavailable");
      const sessionId = this.sessionId;
      if (["follow_up", "send_now", "configure"].includes(operation.kind)) {
        const isPrompt = operation.kind !== "configure";
        if (isPrompt) effects.prompt = { status: "not_sent" };
        const configuration: Row = {};
        for (const field of ["model", "effort"]) if (input[field] !== undefined) configuration[field] = { value: String(input[field]), status: "not_sent" };
        if (Object.keys(configuration).length) effects.configuration = configuration;
        this.started(operation, { effects });
        // Admission order covers preparation/configuration and submission only,
        // never the duration of a native prompt. Session configuration can thus
        // change while native work is active without overtaking initial input.
        const submission = await this.submit(async () => {
          if (this.closing) throw new Error("Collaborator closed before submission");
          const material = isPrompt ? await this.richInput(operation) : undefined;
          if (input.model !== undefined || input.effort !== undefined) {
            await native.configure(sessionId, { ...(input.model !== undefined ? { model: String(input.model) } : {}), ...(input.effort !== undefined ? { effort: String(input.effort) } : {}) }, (field, status, response, error) => {
              if (error) configurationFailure = { configuration_field: field, setter: field === "model" ? "model" : "reasoning_effort", requested_value: String(input[field]), cause: failure(error) };
              configuration[field] = { value: String(input[field]), status, ...(error ? { error: failure(error) } : {}) };
              if (status === "submitted") dispatched = true;
              // Publish the full updated choice set before the next setter can
              // start; a later rejection never hides an earlier applied model.
              if (response) this.nativeOptions(response);
              recordEffects();
            });
          }
          if (!isPrompt) { this.completed(operation, { configured: true }); return undefined; }
          if (this.closing) throw new Error("Collaborator closed before the native prompt was sent");
          // No native prompt identity exists during configuration or preparation.
          const promptId = randomUUID();
          this.store.setPromptInput(this.claim, promptId, { attachments: material!.inputs });
          effects.prompt = { status: "submitted", prompt_id: promptId };
          this.store.updateOperation(this.claim, operation.operation_id, { native_prompt_id: promptId, effects });
          dispatched = true;
          return { promptId, completion: native.prompt(sessionId, promptId, material!.content, material!.metadata) };
        });
        if (!submission) return;
        const { promptId, completion } = submission;
        let response: Row;
        try { response = row(await completion); }
        catch (error) {
          effects.prompt = { status: error instanceof RequestError ? "rejected" : "unknown", prompt_id: promptId };
          recordEffects(); throw error;
        }
        const meta = row(response._meta);
        if (meta.sessionId !== undefined && meta.sessionId !== sessionId || meta.promptId !== undefined && meta.promptId !== promptId) throw new Error("Native prompt response identity differs from its request");
        if (meta.completionKind === "removedFromQueue") {
          effects.prompt = { status: "completed", prompt_id: promptId }; recordEffects();
          this.completed(operation, response);
        }
        else {
          const stopReason = string(response.stopReason);
          if (!stopReason) throw new Error("Native prompt response has no stop reason");
          effects.prompt = { status: "completed", prompt_id: promptId }; recordEffects();
          this.turn(promptId, { status: stopReason === "cancelled" ? "cancelled" : "completed", source: "prompt_response", stop_reason: stopReason });
          this.completed(operation, { stop_reason: stopReason });
        }
      } else if (operation.kind === "respond") {
        const requestId = String(input.request_id), pending = this.pending.get(requestId);
        if (!pending || pending.signal.aborted || this.store.getAttention(requestId)?.status !== "pending") {
          const current = this.store.operation(operation.operation_id);
          if (current?.status === "admitted") this.store.updateOperation(this.claim, operation.operation_id, { status: "not_sent", completed_at: now(),
            error: failure(new AgentError("attention_not_pending", "Attention request is no longer pending", "Read current attention and the retained response operation; do not replay this answer.")) });
          return;
        }
        const response = validateAttentionResponse(pending.attention, input.response);
        this.started(operation); dispatched = true;
        this.pending.delete(requestId); pending.dispose(); this.store.resolveAttention(this.claim, requestId);
        pending.resolve(response);
        // SDK owns reverse-response transport; this records handing it the exact validated answer, not native consumption.
        this.completed(operation, { response_submitted: true });
      } else if (operation.kind === "side_question" || operation.kind === "steer") {
        const method = operation.kind === "side_question" ? "_x.ai/btw" : "_x.ai/interject";
        effects.native_request = { method, status: "not_sent" };
        this.started(operation, { effects });
        const send = async () => {
          const prepared = operation.kind === "steer" ? await prepareAttachments((input.attachments ?? []) as AttachmentInput[]) : undefined;
          if (this.closing) throw new Error("Collaborator closed before the native request was sent");
          effects.native_request = { method, status: "submitted" }; recordEffects(); dispatched = true;
          return { completion: native.request(method,
            operation.kind === "side_question" ? { sessionId, question: input.task } : {
              sessionId, text: input.task, interjectionId: operation.operation_id,
              content: [{ type: "text", text: input.task }, ...prepared!.blocks],
            }) };
        };
        // Interject can create a root turn when native is idle. Keep it behind
        // earlier admitted input preparation, but release at SDK dispatch so
        // neither prompt completion nor a side answer blocks steering.
        let answer: Row;
        try {
          const { completion } = operation.kind === "steer" ? await this.submit(send) : await send();
          answer = row(await completion);
          effects.native_request = { method, status: "completed" }; recordEffects();
        } catch (error) {
          effects.native_request = { method, status: !dispatched ? "not_sent" : error instanceof RequestError ? "rejected" : "unknown" }; recordEffects(); throw error;
        }
        const result = Object.hasOwn(answer, "result") ? row(answer.result) : answer;
        if (operation.kind === "side_question") {
          if (typeof result.answer !== "string") throw new Error("Native side answer has no text");
          this.store.appendSideAnswer(this.claim, { operation_id: operation.operation_id, text: result.answer });
          this.completed(operation, { side_answer: true });
        } else this.completed(operation, { status: result.status });
      } else if (operation.kind === "edit" || operation.kind === "interrupt") {
        const promptId = string(input.prompt_id), queue = row(this.store.observation("queue"));
        const queued = promptId && !promptActivity(this.store, promptId).inactive ? array(queue.entries).find(entry => entry.id === promptId) : undefined;
        if (operation.kind === "edit" && !queued) throw new Error("Exact native prompt is no longer queued");
        if (operation.kind === "interrupt" && promptId && !queued) throw new Error("Exact native prompt is no longer queued");
        if (operation.kind === "edit") assertQueuedEditInput(this.store.promptInput(promptId!));
        const target = row(input.queue_target);
        if (operation.kind === "interrupt" && promptId && (target.id !== promptId || !Number.isSafeInteger(target.version) || Number(target.version) < 0)) {
          throw new Error("Admitted queued removal has no exact native ID and version");
        }
        this.started(operation); dispatched = true;
        // Native edit replaces all text blocks with one. Keep the same
        // delegation guidance rather than silently removing it on edit.
        if (operation.kind === "edit") await native.notify("_x.ai/queue/edit", { sessionId, id: promptId, newText: `${input.task}\n\n${this.guidance()}`, clientIdentifier: this.store.agentId });
        else if (promptId) await native.notify("_x.ai/queue/remove", { sessionId, id: target.id, expectedVersion: target.version, clientIdentifier: this.store.agentId });
        else await native.notify("session/cancel", { sessionId, _meta: { cancelSubagents: true, cancelTrigger: "ctrl_c" } });
        this.completed(operation, { notification_sent: true });
      } else throw new Error(`Unsupported admitted operation ${operation.kind}`);
    } catch (error) {
      const current = this.store.operation(operation.operation_id);
      const prompt = row(effects.prompt);
      if (prompt.status === "submitted") { effects.prompt = { ...prompt, status: "unknown" }; }
      const configUnknown = Object.values(row(effects.configuration)).some(value => ["unknown", "submitted"].includes(String(row(value).status)));
      const diagnostic = failure(error);
      if (configurationFailure || diagnostic.details.configuration_field) {
        diagnostic.details = { ...diagnostic.details, ...configurationFailure,
          applied_fields: Object.entries(row(effects.configuration)).filter(([, value]) => row(value).status === "applied").map(([field]) => field),
          rollback: "not_performed" };
        diagnostic.action = "Inspect native_options and the failed setter diagnostic. Preserve applied fields; no rollback occurred. Correct a rejected value deliberately; do not replay a setter whose outcome is unknown.";
      }
      if (current && (current.status === "admitted" || current.status === "started")) this.store.updateOperation(this.claim, operation.operation_id, {
        status: configUnknown || row(effects.prompt).status === "unknown" || row(effects.native_request).status === "unknown" || (dispatched && !Object.keys(effects).length && !(error instanceof RequestError)) ? "outcome_unknown" : "failed", completed_at: now(), error: diagnostic, ...(Object.keys(effects).length ? { effects } : {}),
      });
    }
  }
  private expireAttention(): void {
    for (const requestId of this.pending.keys()) {
      this.store.expireAttention(this.claim, requestId, "connection_ended", "worker_close");
      this.rejectAttention(requestId, "Collaborator connection ended");
    }
    this.pending.clear();
  }
  private settleUnfinished(error: unknown): void {
    for (const operation of this.store.pendingOperations()) {
      const effects = row(operation.effects), prompt = row(effects.prompt), configuration = row(effects.configuration);
      for (const field of ["model", "effort"]) if (operation.input[field] !== undefined && !configuration[field]) configuration[field] = { value: String(operation.input[field]), status: "not_sent" };
      if (Object.keys(configuration).length) effects.configuration = configuration;
      if (prompt.status === "submitted") effects.prompt = { ...prompt, status: "unknown" };
      if (row(effects.native_request).status === "submitted") effects.native_request = { ...row(effects.native_request), status: "unknown" };
      if (["follow_up", "send_now"].includes(operation.kind) && !effects.prompt) effects.prompt = { status: "not_sent" };
      for (const [field, value] of Object.entries(configuration)) if (row(value).status === "submitted") configuration[field] = { ...row(value), status: "unknown" };
      this.store.updateOperation(this.claim, operation.operation_id, { status: operation.status === "admitted" ? "not_sent" : "outcome_unknown", completed_at: now(), error: failure(error), effects });
    }
    for (const turn of this.store.runningTurns()) this.turn(turn.prompt_id, { status: "unknown", source: turn.source });
  }
  private async close(operation: Operation): Promise<void> {
    this.closing = true; this.started(operation); this.patch({ phase: "stopping" });
    let receipt: Row | undefined;
    try {
      this.provisionAbort.abort();
      await this.provisioning?.catch(() => {});
      if (this.native && this.sessionId) {
        try { await this.native.notify("session/cancel", { sessionId: this.sessionId, _meta: { cancelSubagents: true, cancelTrigger: "ctrl_c" } }); }
        catch (error) { this.issue("close_cancel_unconfirmed", failure(error).message); }
      }
      receipt = this.native ? await this.native.close(string(this.meta().native_session_id)) : { native: null, process: null };
      // Observed child exit does not erase an unresolved pre-identity custody
      // window. The store verifies absence for both independent native roles
      // before close can publish a terminal state and release the spawn key.
      this.store.setProcess(this.claim, null, "provisioner");
      this.store.setProcess(this.claim, null);
      if (receipt.native_error) this.store.updateOperation(this.claim, operation.operation_id, { status: "outcome_unknown", completed_at: now(), result: receipt, error: receipt.native_error });
      else this.completed(operation, receipt);
      this.patch({ phase: "closed", close: receipt });
    } catch (error) {
      this.store.updateOperation(this.claim, operation.operation_id, { status: "outcome_unknown", completed_at: now(), error: failure(error), ...(receipt ? { result: receipt } : {}) });
      this.patch({ phase: "disconnected" }); this.issue("close_incomplete", failure(error).message);
    } finally {
      this.expireAttention();
      this.settleUnfinished(new Error("Collaborator closed before this operation completed"));
      this.stopped = true;
    }
  }
  async run(): Promise<void> {
    this.patch({ phase: "opening" });
    let disconnect: { disconnect_error: unknown; cleanup_receipt?: Row } | undefined;
    // Deliberate close rejects in-flight initialize/session RPCs. Its own
    // operation owns settlement; that rejection must not start a second close.
    const bootstrap = this.bootstrap().catch(error => { if (!this.closing) this.fail(error); });
    try {
      while (!this.stopped && !this.fatalError) {
        for (const operation of this.store.pendingOperations()) {
          if (operation.status !== "admitted" || this.closing) continue;
          if (!this.ready && operation.kind !== "close" && operation.kind !== "respond") continue;
          const execution = this.execute(operation).finally(() => this.running.delete(execution));
          this.running.add(execution);
        }
        await sleep(100);
      }
      if (this.fatalError && !this.stopped && !this.closing) {
        this.closing = true; this.expireAttention();
        disconnect = { disconnect_error: failure(this.fatalError) };
        try { if (this.native) disconnect.cleanup_receipt = await this.native.close(); }
        catch (error) { this.issue("provider_cleanup_incomplete", failure(error).message); }
        const { message, ...diagnostic } = failure(this.fatalError);
        this.issue("native_disconnected", message, { cause: diagnostic });
      }
      await bootstrap;
      await Promise.allSettled([...this.running]);
    } finally {
      // Final admission settlement and release share one store transaction, so
      // close cannot be stranded between the last pending scan and worker exit.
      try { this.store.setProcess(this.claim, null); this.store.release(this.claim, disconnect); }
      catch (error) { this.issue("worker_custody_retained", failure(error).message); }
    }
  }
}

export async function runWorker(agentId: string, launchToken: string, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const store = AgentStore.open(agentId, environment);
  try {
    const resume = store.launch()?.resume;
    const claim = store.claim(launchToken, currentProcessIdentity());
    if (resume) {
      for (const turn of store.runningTurns()) store.upsertTurn(claim, { ...turn, status: "unknown", updated_at: now() });
      store.setObservation(claim, "queue", { unavailable: true, reason: "Native queue has not been observed after resume" });
      store.setMeta(claim, { phase: "opening" });
    }
    await new Worker(store, claim, environment).run();
  } finally { store.close(); }
}
