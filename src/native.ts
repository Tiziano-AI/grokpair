import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream, PROTOCOL_VERSION, RequestError, type ClientConnection, type InitializeResponse, type ContentBlock } from "@agentclientprotocol/sdk";
import { AgentError, PRODUCT, PRODUCT_VERSION, failure, explicitDiagnostics, primaryDiagnostic } from "./core.js";
import { observeProcess, signalProcess, type ProcessIdentity } from "./process.js";
import { NATIVE_ATTENTION_METHODS } from "./attention.js";

export type Row = Record<string, unknown>;
export const row = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
export const string = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
// Native ToolOutput uses an internally tagged outer enum and externally tagged
// error variants. Select only variants emitted as Failed by acp_tool_update;
// walking arbitrary rawOutput/output objects would also retain successful data.
const NATIVE_ERROR_VARIANTS: Record<string, readonly string[]> = {
  ReadFile: ["FileNotFound", "IsADirectory", "PermissionDenied", "FileTooLarge", "FileReadError", "ImageSizeError"],
  ListDir: ["NotFound", "IsAFile", "NotADirectory", "PermissionDenied", "Error"],
  SearchReplace: ["FileAlreadyExists", "MultipleMatchesFound", "NoMatchesFound", "InvalidInput", "FileNotFound", "FilenameTooLong"],
  Todo: ["DuplicateId", "InvalidArgument"],
  WebFetch: ["DomainNotAllowed", "CrossHostRedirect", "Error"],
  TaskOutput: ["TaskNotFound"],
  KillTask: ["TaskNotFound"],
  ApplyPatch: ["ParseError", "ApplicationError", "EmptyPatch"],
  CodexGrepFiles: ["Error"],
};
const NATIVE_MESSAGE_REJECTIONS = new Set(["not_found_or_not_owned", "not_active_or_finalizing", "saturated", "not_accepted_before_deadline", "unsupported", "limit", "channel_closed"]);
/** Retain explicit failure diagnostics, never arbitrary tool output or a transcript. */
export function nativeToolFailure(update: Row): Row & { message: string } {
  const output = row(update.rawOutput);
  const roots: { value: unknown; source: string }[] = [{ value: output, source: "rawOutput" }];
  const fields: { source: string; value: string }[] = [];
  const retainFields = (value: Row, source: string, keys: readonly string[]): void => {
    for (const key of keys) {
      const field = value[key];
      if (typeof field === "string" || typeof field === "boolean" || typeof field === "number" && Number.isFinite(field)) {
        fields.push({ source: `${source}.${key}`, value: String(field) });
      }
    }
  };
  let diagnosticText = false;
  if (update.status !== "completed") {
    const variants = typeof output.type === "string" && Object.hasOwn(NATIVE_ERROR_VARIANTS, output.type) ? NATIVE_ERROR_VARIANTS[output.type]! : [];
    for (const variant of variants) {
      if (!Object.hasOwn(output, variant)) continue;
      roots.push({ value: output[variant], source: `rawOutput.${variant}` });
      retainFields(row(output[variant]), `rawOutput.${variant}`, ["file_path", "url", "original_host", "redirect_url"]);
      // These exact variants emit diagnostic prose, unlike Bash's stdout or
      // Skill's tool_result. Preserve it without treating all failed text alike.
      diagnosticText = ["ReadFile", "SearchReplace", "Todo", "WebFetch", "ApplyPatch"].includes(String(output.type));
    }
    if (output.type === "MCP" && Object.hasOwn(row(output.output), "Error")) {
      roots.push({ value: row(output.output).Error, source: "rawOutput.output.Error" });
      retainFields(output, "rawOutput", ["tool_name", "server_name", "reconnect_attempted", "auth_retry_attempted", "is_timeout", "is_error"]);
    }
    if (output.type === "SendSubagentMessage" && NATIVE_MESSAGE_REJECTIONS.has(String(output.outcome))) {
      roots.push({ value: output.outcome, source: "rawOutput.outcome" });
      retainFields(output, "rawOutput", ["max_in_flight", "max_bytes", "observed_bytes"]);
      diagnosticText = true;
    }
    if (output.type === "Bash") retainFields(output, "rawOutput", ["signal", "timed_out", "exit_code"]);
  }
  if (Array.isArray(update.content)) {
    for (const [index, item] of update.content.entries()) {
      const wrapper = row(item), content = row(wrapper.content);
      if (wrapper.type !== "content" || content.type !== "text" || typeof content.text !== "string") continue;
      // Native Bash emits stdout here; Skill emits tool_result. Even a complete
      // JSON object in either channel is not evidence of a diagnostic envelope.
      if (output.type === "Bash" || output.type === "Skill") continue;
      if (diagnosticText) {
        roots.push({ value: content.text, source: `content[${index}].content.text` });
        continue;
      }
      try {
        const diagnostic = row(JSON.parse(content.text));
        // Complete JSON with explicit diagnostics, not embedded JSON, prose,
        // successful result text, stdout or resource content.
        if ([diagnostic.error, diagnostic.message, diagnostic.code, diagnostic.cause, diagnostic.causes, diagnostic.errors].some(value => value !== undefined)) {
          roots.push({ value: diagnostic, source: `content[${index}].content.text` });
        }
      } catch { /* Text without a complete JSON diagnostic is not retained. */ }
    }
  }
  const collected = explicitDiagnostics(roots);
  collected.fields.push(...fields);
  const primary = primaryDiagnostic(collected.messages), nativeCode = collected.codes[0];
  const diagnostics = collected.messages.filter(item => item !== primary);
  return { message: primary?.message ?? "Native tool reported failure",
    ...(primary ? { diagnostic_source: primary.source } : {}),
    ...(nativeCode ? { native_code: nativeCode.code, native_code_source: nativeCode.source } : {}),
    ...(collected.codes.length > 1 ? { native_codes: collected.codes } : {}),
    ...(diagnostics.length ? { diagnostics } : {}),
    ...(collected.fields.length ? { diagnostic_fields: collected.fields } : {}),
    ...(collected.references.length ? { diagnostic_references: collected.references } : {}) };
}
export function unwrap(method: string, value: unknown): Row {
  const body = row(value);
  return body.method === method.replace(/^_/, "") && body.params ? row(body.params) : body;
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export type NativeHooks = {
  starting(): void;
  notLaunched(): void;
  started(identity: ProcessIdentity): void;
  initialized?(response: InitializeResponse): void;
  notification(method: string, params: unknown): void;
  attention(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
  failure(error: unknown): void;
};
export type ConfigurationField = "model" | "effort";
export type ConfigurationStage = "submitted" | "applied" | "rejected" | "unknown";

/** The SDK is the only framer, parser, serializer and RPC router. */
export class NativeConnection {
  readonly connection: ClientConnection;
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  initialization!: InitializeResponse;
  identity: ProcessIdentity | undefined;
  private closing = false;
  private ended = false;
  private initialized = false;
  private startupStderr = Buffer.alloc(0);
  private startupStderrTruncated = false;
  private exitResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private readonly streamsClosed: Promise<void>;
  private configOptions: Row[] = [];

  constructor(cwd: string, sandbox: string | undefined, private readonly hooks: NativeHooks, environment: NodeJS.ProcessEnv = process.env) {
    if (sandbox !== undefined && !sandbox.trim()) throw new AgentError("invalid_sandbox", "sandbox must be a nonempty native profile name", "Omit sandbox to use native configuration, or provide an exact native profile name.");
    hooks.starting();
    try {
      this.child = spawn("grok", ["--cwd", cwd, ...(sandbox === undefined ? [] : ["--sandbox", sandbox]), "agent", "--no-leader", "stdio"], {
        cwd, env: environment, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      // A synchronous spawn rejection returns no ChildProcess at all. Unlike
      // a later observation error it cannot leave a possibly launched child.
      hooks.notLaunched(); throw error;
    }
    // Startup diagnostics only; clear and stop retaining at successful initialize.
    this.child.stderr.on("data", (data: Buffer) => {
      if (this.initialized) return;
      const remaining = 64 * 1024 - this.startupStderr.length;
      if (data.length > remaining) this.startupStderrTruncated = true;
      if (remaining > 0) this.startupStderr = Buffer.concat([this.startupStderr, data.subarray(0, remaining)]);
    });
    this.streamsClosed = new Promise(resolve => this.child.once("close", () => resolve()));
    this.exited = new Promise(resolve => {
      this.child.once("exit", (code, signal) => { this.ended = true; this.exitResult = { code, signal }; resolve(this.exitResult); });
      this.child.once("error", error => {
        // Node's spawn error without a PID is definitive non-launch, unlike an
        // identity-observation failure after spawn (which retains custody).
        if (this.child.pid === undefined) { this.ended = true; hooks.notLaunched(); resolve({ code: null, signal: null }); }
        if (!this.closing && this.initialized) hooks.failure(error);
      });
    });
    const app = client();
    for (const method of ["session/update", "_x.ai/session_notification", "_x.ai/session/update", "_x.ai/queue/changed", "_x.ai/task_backgrounded", "_x.ai/task_completed", "_x.ai/mcp/elicit_complete", "elicitation/complete"]) {
      app.onNotification(method, value => value, ({ params }) => {
        try { hooks.notification(method, params); }
        catch (error) { hooks.failure(error); this.connection.close(error); }
      });
    }
    for (const method of NATIVE_ATTENTION_METHODS) {
      app.onRequest(method, value => value, ({ params, signal }) => hooks.attention(method, params, signal));
    }
    this.connection = app.connect(ndJsonStream(
      Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>,
      // Keep framing with the SDK without adopting its new 32 MiB default.
      // Infinity is invalid; this ceiling is not a memory-safety guarantee.
      { maxMessageBytes: Number.MAX_SAFE_INTEGER },
    ));
    void this.connection.closed.then(() => { if (!this.closing && this.initialized) hooks.failure(new Error("Native ACP connection ended")); }, error => { if (!this.closing && this.initialized) hooks.failure(error); });
  }

  async initialize(): Promise<InitializeResponse> {
    try {
      if (!this.child.pid) throw new Error("Native process did not launch");
      const observed = observeProcess(this.child.pid);
      if (observed.status !== "observed") throw new Error("Native process identity could not be observed");
      this.identity = observed.identity; this.hooks.started(this.identity);
      this.initialization = await this.connection.agent.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: PRODUCT, version: PRODUCT_VERSION },
      });
    } catch (error) {
      // A closed transport may precede the process/stdio close observations.
      // A rejected initialize can instead leave a live process; never invent its exit.
      await Promise.race([this.streamsClosed, sleep(100)]);
      const stderr = this.startupStderr.toString("utf8");
      throw new AgentError("native_startup_failed", stderr || (error instanceof Error ? error.message : String(error)),
        "Inspect the native startup rejection and recorded effects. Keep the selected sandbox; do not retry with a more permissive profile automatically.",
        { stderr, stderr_truncated: this.startupStderrTruncated, process: this.exitResult ?? null }, { cause: error });
    }
    this.initialized = true;
    this.startupStderr = Buffer.alloc(0); this.startupStderrTruncated = false;
    this.hooks.initialized?.(this.initialization);
    const methods = this.initialization.authMethods ?? [];
    const preferred = string(row(this.initialization._meta).defaultAuthMethodId);
    const auth = methods.find(item => item.id === preferred) ?? methods.find(item => item.id === "cached_token") ?? methods[0];
    if (auth) await this.connection.agent.request("authenticate", { methodId: auth.id });
    return this.initialization;
  }

  async session(cwd: string, sessionId: string, resume: boolean): Promise<Row> {
    if (resume && !this.initialization.agentCapabilities?.sessionCapabilities?.resume) {
      throw new AgentError("resume_unavailable", "Native session resume is unavailable", "Keep prior results; do not replay the old task.");
    }
    const response = resume
      ? await this.connection.agent.request("session/resume", { sessionId, cwd, mcpServers: [] })
      : await this.connection.agent.request("session/new", { cwd, mcpServers: [], _meta: { sessionId } });
    if (!resume && row(response).sessionId !== sessionId) throw new Error("Native session/new returned a different session identity");
    const result = row(response);
    this.acceptOptions(result);
    return result;
  }

  acceptOptions(response: Row): void {
    const options = response.configOptions ?? row(row(response._meta)["x.ai/sessionConfig"]).options;
    if (Array.isArray(options)) this.configOptions = options.map(row);
  }
  async configure(sessionId: string, selection: { model?: string; effort?: string },
    observe: (field: ConfigurationField, stage: ConfigurationStage, response?: Row, error?: unknown) => void): Promise<void> {
    for (const field of ["model", "effort"] as const) {
      const value = selection[field];
      if (value === undefined) continue;
      if (this.closing) throw new Error("Native connection closed before configuration dispatch");
      const configId = field === "model" ? "model" : "reasoning_effort";
      const option = this.configOptions.find(option => option.id === configId);
      if (!option || option.type !== "select") throw new AgentError("native_option_unavailable", `Native ${configId} configuration is not advertised`, "Inspect native_options; omit unsupported configuration. Already applied fields remain applied; no rollback is performed.",
        { configuration_field: field, setter: configId, requested_value: value });
      // Choice lists are observations, not a local policy. The provider alone
      // validates values, including effort values changed by the model setter.
      observe(field, "submitted");
      let result: Row;
      try { result = row(await this.connection.agent.request("session/set_config_option", { sessionId, configId, value })); }
      catch (error) { observe(field, error instanceof RequestError ? "rejected" : "unknown", undefined, error); throw error; }
      this.acceptOptions(result);
      observe(field, "applied", result);
    }
  }
  prompt(sessionId: string, promptId: string, content: ContentBlock[], metadata: Row): Promise<unknown> {
    return this.connection.agent.request("session/prompt", { sessionId, prompt: content, _meta: { ...metadata, promptId } });
  }
  request(method: "_x.ai/btw" | "_x.ai/interject", params: Row): Promise<unknown> {
    return this.connection.agent.request(method, params);
  }
  notify(method: "session/cancel" | "_x.ai/queue/edit" | "_x.ai/queue/remove" | "_x.ai/queue/interject", params: Row): Promise<void> {
    return this.connection.agent.notify(method, params);
  }
  async close(sessionId?: string): Promise<Row> {
    this.closing = true;
    let native: unknown, error: unknown;
    try {
      if (sessionId) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          native = await Promise.race([
            this.connection.agent.request("session/close", { sessionId }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Native close response timed out")), 15_000); }),
          ]);
        } finally { clearTimeout(timer); }
      }
    } catch (cause) { error = cause; }
    this.connection.close(); this.child.stdin.end();
    if (!this.ended) await Promise.race([this.exited, sleep(3_000)]);
    if (!this.ended && this.identity) {
      signalProcess(this.identity, "SIGTERM");
      await Promise.race([this.exited, sleep(3_000)]);
    }
    if (!this.ended && this.identity) {
      signalProcess(this.identity, "SIGKILL");
      await Promise.race([this.exited, sleep(3_000)]);
    }
    if (!this.ended) throw new Error("Native process completion remains unobserved");
    return { native: native ?? null, ...(error ? { native_error: failure(error) } : {}), process: await this.exited };
  }
}
