#!/usr/bin/env node
// Deterministic ACP peer, not native-provider, sandbox, or release acceptance.
// All transport framing and dispatch belong to the official stable SDK.
import { agent, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const trace = value => {
  if (process.env.GROKPAIR_THIN_TRACE) appendFileSync(process.env.GROKPAIR_THIN_TRACE,
    `${JSON.stringify({ pid: process.pid, ...value })}\n`);
};
const argv = process.argv.slice(2);
const selectedCwd = argv.includes("--cwd") ? argv[argv.indexOf("--cwd") + 1] : process.cwd();
// This disposable stand-in owns native provisioning; production code must not
// reproduce its Git creation or source-copy behavior.
if (argv.includes("worktree") && argv.includes("create")) {
  trace({ kind: "worktree_launch", argv, cwd: process.cwd() });
  if (process.env.GROKPAIR_THIN_WORKTREE_MODE === "refuse") {
    process.stderr.write("Fixture native provisioning refused by selected profile.\n"); process.exit(21);
  }
  const git = (...args) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: selectedCwd, env, encoding: "utf8" });
    if (result.error || result.status !== 0) throw Error(result.error?.message ?? result.stderr);
    return result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  };
  const repository = git("rev-parse", "--show-toplevel"), suffix = relative(repository, selectedCwd);
  const parent = join(dirname(process.env.GROKPAIR_THIN_TRACE), "native-worktrees"); mkdirSync(parent, { recursive: true });
  const worktreeRoot = join(parent, randomUUID());
  git("worktree", "add", "--quiet", "-b", `fixture-${randomUUID()}`, worktreeRoot);
  for (const name of git("-C", repository, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0").filter(Boolean)) {
    const source = join(repository, name), target = join(worktreeRoot, name);
    if (existsSync(source)) { mkdirSync(dirname(target), { recursive: true }); cpSync(source, target, { recursive: true, force: true }); }
    else if (existsSync(target)) rmSync(target, { recursive: true });
  }
  const mode = process.env.GROKPAIR_THIN_WORKTREE_MODE;
  const execution = mode === "root-fallback" || !existsSync(join(worktreeRoot, suffix)) ? worktreeRoot : join(worktreeRoot, suffix);
  trace({ kind: "worktree_created", root: realpathSync(worktreeRoot), execution, source: selectedCwd });
  if (process.env.GROKPAIR_THIN_WORKTREE_STDERR) process.stderr.write(process.env.GROKPAIR_THIN_WORKTREE_STDERR);
  if (mode !== "lost-output") process.stdout.write(execution + "\n");
  const gate = process.env.GROKPAIR_THIN_WORKTREE_GATE;
  if (gate) {
    trace({ kind: "worktree_gate_waiting", path: gate });
    // The utility deliberately remains alive after a worker crash so the
    // bridge must use its recorded process identity, not assume it exited.
    while (!existsSync(gate)) await pause(10);
    trace({ kind: "worktree_gate_released" });
  }
  process.exit(0);
}
trace({ kind: "launch", argv, cwd: process.cwd(), sandbox_environment: process.env.GROK_SANDBOX ?? null });
if (process.argv[2] === "version") {
  process.stdout.write(JSON.stringify({ currentVersion: "9.9.9 (deterministic fixture)", channel: "stable" }));
  process.exit(0);
}
if (process.argv[2] === "update") {
  process.stdout.write(JSON.stringify({ currentVersion: "9.9.9", latestVersion: "9.9.9", updateAvailable: false, error: null }));
  process.exit(0);
}
if (!process.argv.includes("agent") || !process.argv.includes("stdio")) throw new Error("Expected grok agent stdio");
if (process.env.GROKPAIR_THIN_STARTUP_FAILURE === "true") {
  process.stderr.write("Fixture native custom profile is unavailable at execution cwd.\n"); process.exit(23);
}

const sessions = new Map();
const queue = [];
let transportClosed = false;
// Gates belong only to this disposable fixture. They let the test stop at an
// observed native boundary without relying on a fast/slow machine race.
async function responseGate(name) {
  const path = process.env[`GROKPAIR_THIN_${name.toUpperCase()}_GATE`];
  if (!path) return;
  trace({ kind: "response_gate_waiting", name });
  while (!existsSync(path) && !transportClosed) await pause(10);
  if (transportClosed) {
    trace({ kind: "response_gate_aborted", name });
    throw new Error(`Fixture ${name} response ended with ACP transport`);
  }
  trace({ kind: "response_gate_released", name });
}
let active = null;
let lastRemovedPrompt;
let orphanKeepAlive;
const id = params => params._meta?.promptId;
// The bridge preserves caller task as first text block; its separate delegation
// guidance and attachments remain visible in the complete traced params.
const text = params => params.prompt.find(block => block.type === "text")?.text ?? "";
// Large fixtures exercise the real wire without making a second payload archive.
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const tracedPrompt = params => text(params) === "THIN:large-image" ? { ...params, prompt: params.prompt.map(block => block.type === "image"
  ? { type: "image", mimeType: block.mimeType, base64_chars: block.data.length, sha256: digest(Buffer.from(block.data, "base64")) } : block) } : params;
const configOptions = sessionId => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: sessions.get(sessionId)?.model ?? "fixture-model",
    options: [{ value: "fixture-model", name: "Fixture" }, { value: "fixture-alternate", name: "Alternate fixture" }] },
  { id: "reasoning_effort", name: "Effort", category: "thought_level", type: "select", currentValue: sessions.get(sessionId)?.reasoning_effort ?? "high",
    options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }, ...(sessions.get(sessionId)?.model === "fixture-alternate" ? [{ value: "turbo", name: "Model-specific effort" }] : [])] },
];
const setup = sessionId => ({ sessionId, configOptions: configOptions(sessionId), models: { currentModelId: "fixture-model", availableModels: [
  { modelId: "fixture-model", name: "Fixture", _meta: { reasoningEfforts: [{ id: "high", value: "high" }] } },
] }, _meta: { sessionId, "x.ai/sessionConfig": { options: [
  { category: "model", id: "fixture-model", selected: true }, { category: "mode", id: "high", selected: true },
] } } });
const update = (client, params, update) => client.notify("session/update", {
  sessionId: params.sessionId, _meta: { promptId: id(params) }, update,
});
const chunk = (client, params, messageId, value, extra = {}) => update(client, params, {
  sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: value }, ...extra,
});
const queueChanged = (client, sessionId) => process.env.GROKPAIR_THIN_NO_QUEUE === "true" ? Promise.resolve() : client.notify("_x.ai/queue/changed", {
  sessionId, entries: queue.map(entry => ({ id: id(entry.params), version: entry.version,
    owner: entry.params._meta?.clientIdentifier, lastEditor: entry.params._meta?.clientIdentifier,
    kind: "prompt", text: text(entry.params), combinedTexts: [],
  })), runningPromptId: active ? id(active.params) : null, runningKind: active ? "prompt" : null,
  runningText: active ? text(active.params) : null, runningCombinedTexts: [],
});
const nativeTerminal = (client, params, stopReason = "end_turn") => client.notify("_x.ai/session_notification", {
  sessionId: params.sessionId, _meta: { promptId: id(params) },
  update: { sessionUpdate: "turn_completed", prompt_id: id(params), stop_reason: stopReason,
    agent_result: "Not a substitute for authentic root chunks." },
});
async function attention(client, params) {
  const requests = [
    ["permission", "session/request_permission", { sessionId: params.sessionId,
      toolCall: { toolCallId: "permission-tool", title: "Fixture permission", kind: "read", status: "pending" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }, { optionId: "deny", kind: "reject_once", name: "Deny" }] }],
    ["question", "_x.ai/ask_user_question", { sessionId: params.sessionId, toolCallId: "question-tool", mode: "default",
      questions: [{ question: "Choose fixture color?", options: [{ label: "Blue", description: "Blue color" }, { label: "Green", description: "Green color" }] }] }],
    ["plan", "_x.ai/exit_plan_mode", { sessionId: params.sessionId, toolCallId: "plan-tool", planContent: "Return the fixture result." }],
    ["elicitation", "_x.ai/mcp/elicit", { sessionId: params.sessionId, toolCallId: "elicit-tool", serverName: "fixture", mode: "form", message: "Choose count",
      requestedSchema: { type: "object", properties: { count: { type: "integer", minimum: 1 } }, required: ["count"], additionalProperties: false } }],
  ];
  for (const [kind, method, payload] of requests) {
    trace({ kind: "attention_requested", attention_kind: kind });
    const response = await client.request(method, payload);
    trace({ kind: "attention_response", attention_kind: kind, response });
  }
}

// Deliberately leave reverse RPCs outstanding while the prompt can cancel.
// Awaiting each question here would hide the native lifecycle race under test.
function independentAttention(client, params, label, kind = "permission", promptId = id(params)) {
  const payload = { sessionId: params.sessionId, ...(promptId ? { _meta: { promptId } } : {}) };
  let method;
  if (kind === "permission") {
    method = "session/request_permission";
    Object.assign(payload, { toolCall: { toolCallId: label, title: label, kind: "read", status: "pending" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }] });
  } else if (kind === "elicitation") {
    method = "_x.ai/mcp/elicit";
    Object.assign(payload, { toolCallId: label, serverName: "fixture", mode: "form", message: "Choose count",
      requestedSchema: { type: "object", properties: { count: { type: "integer" } } } });
  } else {
    method = "_x.ai/exit_plan_mode";
    Object.assign(payload, { toolCallId: label, planContent: label });
  }
  trace({ kind: "independent_attention_requested", label, prompt_id: promptId });
  void client.request(method, payload).then(
    response => trace({ kind: "independent_attention_response", label, response }),
    error => trace({ kind: "independent_attention_rejected", label, message: error.message }),
  );
}

const app = agent({ name: "thin-deterministic-native-fixture" });
app.onRequest("initialize", async ({ params }) => {
  trace({ kind: "initialize", params });
  const crashMarker = process.env.GROKPAIR_THIN_CRASH_INITIALIZE_ONCE;
  if (crashMarker && !existsSync(crashMarker)) {
    writeFileSync(crashMarker, "crashed before prompt dispatch"); process.exit(71);
  }
  await responseGate("initialize");
  // Native 1.0.24 omits image/audio advertisement but accepts image blocks.
  const promptCapabilities = { embeddedContext: process.env.GROKPAIR_THIN_DISABLE_CAPABILITY !== "embeddedContext" };
  trace({ kind: "advertised_prompt_capabilities", promptCapabilities });
  const result = { protocolVersion: PROTOCOL_VERSION, agentInfo: { name: "thin-fixture", version: "9.9.9" },
    agentCapabilities: { loadSession: true, promptCapabilities,
      sessionCapabilities: { resume: {}, close: {} },
      _meta: { "x.ai/capabilities": { ...(process.env.GROKPAIR_THIN_DISABLE_CAPABILITY === "toolOverrides" ? {} : {
        toolOverrides: { x_keyword_search: true, x_semantic_search: true, x_user_search: false, x_thread_fetch: false },
      }) } } },
    _meta: { modelState: { currentModelId: "fixture-model", availableModels: setup("unused").models.availableModels, reasoningEffort: "high" } } };
  trace({ kind: "initialize_returned", result });
  return result;
});
app.onRequest("session/new", async ({ params }) => {
  const sessionId = params._meta?.sessionId ?? randomUUID();
  trace({ kind: "new_session", params, session_id: sessionId }); sessions.set(sessionId, {});
  await responseGate("session");
  return setup(sessionId);
});
for (const method of ["session/resume", "session/load"]) app.onRequest(method, ({ params }) => {
  trace({ kind: "resume_session", params, session_id: params.sessionId }); sessions.set(params.sessionId, {}); return setup(params.sessionId);
});
app.onRequest("authenticate", ({ params }) => { trace({ kind: "authenticate", params }); return {}; });
app.onRequest("session/set_config_option", async ({ params }) => {
  trace({ kind: "configure_received", params });
  if (process.env.GROKPAIR_THIN_CONFIG_CRASH === params.configId) process.exit(73);
  if (process.env.GROKPAIR_THIN_CONFIG_DISCONNECT === params.configId) {
    connection.close();
    await new Promise(() => {});
  }
  const option = configOptions(params.sessionId).find(item => item.id === params.configId);
  if (!option?.options.some(item => item.value === params.value) && !(params.configId === "model" && params.value === "fixture-future")) throw RequestError.invalidParams({}, "Selection rejected by fixture");
  const state = sessions.get(params.sessionId); state[params.configId] = params.value;
  trace({ kind: "configure", params });
  await responseGate(`configure_${params.configId}`);
  return { configOptions: configOptions(params.sessionId) };
});
app.onRequest("session/prompt", async ({ params, client }) => {
  trace({ kind: "prompt_received", params: tracedPrompt(params), session_id: params.sessionId, prompt_id: id(params), text: text(params) });
  if (text(params).startsWith("THIN:removed:")) {
    // Native removal can be combination, interjection or Goal absorption. It
    // ends this prompt RPC, not its still-live reverse interactions, and need
    // not identify the receiving turn. Keep a stale queue to test derivation.
    lastRemovedPrompt = params;
    await chunk(client, params, "not-autonomous", "Shared text does not identify a receiving turn.");
    independentAttention(client, params, "removed-pending");
    await client.notify("_x.ai/queue/changed", { sessionId: params.sessionId,
      entries: [{ id: id(params), version: 0, text: text(params) }], runningPromptId: id(params), runningKind: "prompt" });
    const result = { stopReason: "cancelled", _meta: { sessionId: params.sessionId, promptId: id(params), completionKind: "removedFromQueue",
      native_fixture: { removal: text(params).slice("THIN:removed:".length), exact: [null, false] } } };
    trace({ kind: "removed_prompt_response", result });
    return result;
  }
  const entry = { params, version: 0, release: null, cancelled: false };
  if (active) {
    const promoted = new Promise(resolve => { entry.promote = resolve; });
    if (params._meta?.sendNow === true) {
      queue.unshift(entry); active.cancelled = true; active.release?.();
    } else queue.push(entry);
    await queueChanged(client, params.sessionId);
    if (await promoted === "removed") return { stopReason: "cancelled", _meta: { promptId: id(params), completionKind: "removedFromQueue" } };
  }
  active = entry;
  await queueChanged(client, params.sessionId);
  trace({ kind: "prompt_started", prompt_id: id(params), text: text(params) });
  const task = text(params);
  if (task.startsWith("THIN:hold") || task === "THIN:orphan") {
    if (task === "THIN:orphan") orphanKeepAlive = setInterval(() => {}, 1000);
    await chunk(client, params, "hold-root", "Before cancellation.");
    await update(client, params, { sessionUpdate: "tool_call", toolCallId: "stuck-tool", title: "Still running fixture tool", kind: "other", status: "in_progress" });
    await new Promise(resolve => { entry.release = resolve; trace({ kind: "hold_ready" }); });
  } else if (task.startsWith("THIN:delayed:")) {
    await pause(700); await chunk(client, params, "answer", task.slice("THIN:delayed:".length));
  } else if (task === "THIN:fragments") {
    await update(client, params, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "PRIVATE THOUGHT" } });
    await client.notify("session/update", { sessionId: params.sessionId, _meta: { promptId: id(params), isReplay: true },
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAY MUST NOT BECOME LIVE ROOT" } } });
    await client.notify("session/update", { sessionId: "foreign-child-session", _meta: { promptId: id(params) },
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "CHILD MUST NOT BECOME ROOT" } } });
    await update(client, params, { sessionUpdate: "tool_call", toolCallId: "fragment-tool", title: "Private tool content", kind: "other", status: "completed",
      content: [{ type: "content", content: { type: "text", text: "TOOL MUST NOT BECOME ROOT" } }] });
    for (let index = 0; index < 180; index++) {
      await chunk(client, params, `message-${Math.floor(index / 30)}`, `Fragment ${String(index).padStart(3, "0")}: ${"λ".repeat(701)}\r\n`);
      if (index % 12 === 0) await pause(2);
    }
  } else if (task === "THIN:image-consumption") {
    const images = params.prompt.filter(block => block.type === "image");
    if (images.length !== 1) throw new Error("Image-consumption fixture requires exactly one image");
    const data = Buffer.from(images[0].data, "base64");
    trace({ kind: "image_consumed", bytes: [...data], mime_type: images[0].mimeType });
    await chunk(client, params, "answer", `Consumed image bytes: ${data.toString("hex")}`);
  } else if (task === "THIN:large-notification") {
    const value = `Large native frame λ🙂\r\n${"λ🙂".repeat(6 * 1024 * 1024)}\r\nExact end.`;
    trace({ kind: "large_notification", text_bytes: Buffer.byteLength(value), text_chars: value.length, sha256: digest(value) });
    await chunk(client, params, "large-answer", value);
  } else if (task === "THIN:large-image") {
    const images = params.prompt.filter(block => block.type === "image");
    if (images.length !== 1) throw new Error("Large-image fixture requires exactly one image");
    const data = Buffer.from(images[0].data, "base64");
    trace({ kind: "large_image_consumed", bytes: data.length, sha256: digest(data), mime_type: images[0].mimeType,
      encoded_prompt_bytes: Buffer.byteLength(JSON.stringify(params.prompt)) });
    await chunk(client, params, "answer", "Large image bytes received exactly.");
  } else if (task === "THIN:unfinished-frame" || task === "THIN:malformed-frame") {
    await chunk(client, params, "partial", "Retain this exact partial text λ🙂.\r\n");
    // Fault injection only: the official parser must not promote an incomplete
    // frame or a malformed line into root text or a successful turn outcome.
    const broken = task === "THIN:unfinished-frame"
      ? '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"UNFINISHED MUST NOT BECOME ROOT'
      : '{"jsonrpc":"2.0","method":BROKEN}\n';
    trace({ kind: "broken_frame_written", scenario: task, bytes: Buffer.byteLength(broken) });
    await new Promise(resolve => process.stdout.write(broken, resolve));
    process.exit(74);
  } else if (task === "THIN:attention") {
    await attention(client, params); await chunk(client, params, "answer", "All native requests answered.");
  } else if (task === "THIN:huge-attention") {
    const payload = { sessionId: params.sessionId, _meta: { promptId: id(params), exact: null },
      toolCall: { toolCallId: "huge-permission", title: "Read the complete escaped native request", kind: "read", status: "pending",
        rawInput: { context: 'Quoted "value", backslash \\, tab\t, CRLF\r\n, NUL\0, Unicode λ🙂.\n'.repeat(900),
          future: [null, false, { "escaped\"key\\": "Exact tail.\r\n" }] } },
      options: [{ optionId: 'allow"\\once\tλ🙂', kind: "allow_once", name: "Allow exactly this request" },
        { optionId: "deny", kind: "reject_once", name: "Deny" }] };
    trace({ kind: "huge_attention_requested", payload });
    const response = await client.request("session/request_permission", payload);
    trace({ kind: "huge_attention_response", response });
    await chunk(client, params, "answer", "Huge native request answered exactly once.");
  } else if (task === "THIN:interaction-resolved") {
    independentAttention(client, params, "ended-permission");
    independentAttention(client, params, "ended-elicitation", "elicitation");
    independentAttention(client, params, "other-interaction", "plan");
    await responseGate("interaction_resolve");
    // PendingInteractionGuard emits this notification without aborting the
    // independent gateway RPC when an MCP requester has abandoned its waiter.
    const ended = (sessionId, tool_call_id) => client.notify("_x.ai/session_notification", {
      sessionId, update: { sessionUpdate: "interaction_resolved", tool_call_id },
    });
    await ended("foreign-session", "other-interaction");
    await ended(params.sessionId, "unknown-interaction");
    await ended(params.sessionId, "ended-permission");
    await ended(params.sessionId, "ended-elicitation");
    await ended(params.sessionId, "ended-elicitation");
    await ended(params.sessionId, "late-interaction");
    independentAttention(client, params, "late-interaction", "elicitation");
    await ended(params.sessionId, "reopened-interaction");
    await client.notify("_x.ai/session_notification", { sessionId: params.sessionId,
      update: { sessionUpdate: "pending_interaction", tool_call_id: "reopened-interaction", kind: "plan_approval" } });
    independentAttention(client, params, "reopened-interaction", "plan");
    await responseGate("interaction_finish");
    await chunk(client, params, "answer", "Root continues after the interactions ended.");
  } else if (task === "THIN:image-dropped") {
    const allNotes = [
      ["This request failed over its images (or was too large); 2 image(s) were left out of the retry."],
      ["The server could not process an image, so it was removed from the conversation. Re-attach it if it is still needed."],
      ["The server could not process an image, so it was left out of this request."],
    ];
    for (const notes of allNotes) {
      const payload = { sessionId: params.sessionId, _meta: { eventId: randomUUID(), future: null },
        update: { sessionUpdate: "image_dropped", notes } };
      trace({ kind: "image_dropped_notice", payload });
      await client.notify("_x.ai/session_notification", payload);
    }
    await chunk(client, params, "answer", "Root text returned after native image exclusion.");
  } else if (task === "THIN:native-enum-errors") {
    for (const [toolCallId, rawOutput] of [
      ["mcp-error", { type: "MCP", output: { Error: "Authentication expired" } }],
      ["todo-error", { type: "Todo", InvalidArgument: "Missing required field: todos" }],
      ["read-error", { type: "ReadFile", FileNotFound: "File not found: /tmp/example" }],
    ]) await update(client, params, { sessionUpdate: "tool_call_update", toolCallId, status: "failed", rawOutput });
    await chunk(client, params, "answer", "Native diagnostic envelopes preserved.");
  } else if (task === "THIN:native-question-outcomes") {
    for (const label of ["empty", "partial", "cancelled", "chat", "skip"]) {
      const payload = { sessionId: params.sessionId, toolCallId: "question-" + label, mode: "plan",
        _meta: { promptId: id(params), future: null }, extra: { preserved: true },
        questions: [{ question: "Question?", id: null, options: [{ label: "A", description: "", id: "native-option", preview: null }] },
          { question: "Unanswered?", options: [] }] };
      trace({ kind: "variant_attention_requested", label, payload });
      const response = await client.request("_x.ai/ask_user_question", payload);
      trace({ kind: "variant_attention_response", label, response });
    }
    await chunk(client, params, "answer", "Question cancellation completed normally.");
  } else if (task === "THIN:malformed-attention") {
    const payload = { sessionId: params.sessionId, toolCallId: "invalid-question", mode: "default",
      questions: null, _meta: { promptId: id(params), retained: null }, extra: { doNotLose: "diagnostic context" } };
    trace({ kind: "malformed_attention_requested", payload });
    try {
      await client.request("_x.ai/ask_user_question", payload);
      throw new Error("Malformed native request must not receive a manufactured answer");
    } catch (error) {
      trace({ kind: "malformed_attention_rejected", message: error.message });
    }
    await chunk(client, params, "answer", "Malformed reverse request did not hang.");
  } else if (task === "THIN:background-notices") {
    const notify = async (update) => {
      trace({ kind: "background_native_notice", update });
      await client.notify("_x.ai/session_notification", { sessionId: params.sessionId, update });
    };
    const started = (task_id) => ({ sessionUpdate: "task_backgrounded", task_id, tool_call_id: "tool-" + task_id,
      command: "printf fixture", cwd: process.cwd(), output_file: "/fixture/" + task_id + ".log",
      monitor_description: null, description: "Exact background context", _meta: { preserve: true } });
    await notify(started("task-a"));
    await notify(started("task-b"));
    await notify({ sessionUpdate: "task_completed", task_snapshot: { task_id: "task-a", exit_code: 3,
      signal: null, output: "Exact completion output\r\n", future: { nested: null } }, will_wake: false });
    const completion = { sessionId: params.sessionId, elicitationId: "elicit-real-id", serverName: "fixture",
      _meta: { preserve: null }, future: [1, 2] };
    trace({ kind: "elicitation_native_notice", payload: completion });
    await client.notify("_x.ai/mcp/elicit_complete", completion);
    await chunk(client, params, "answer", "Root completed with task-b still backgrounded.");
  } else if (task.startsWith("THIN:attention-cancel-")) {
    independentAttention(client, params, "matching-pending");
    if (task === "THIN:attention-cancel-live") {
      independentAttention(client, params, "matching-completed");
      independentAttention(client, params, "other-prompt", "plan", "fixture-other-prompt");
      independentAttention(client, params, "unscoped", "plan", null);
    }
    await new Promise(resolve => { entry.release = resolve; trace({ kind: "attention_cancel_ready" }); });
    await responseGate("attention_cancel");
    if (task === "THIN:attention-cancel-live") {
      await nativeTerminal(client, params, "cancelled");
      independentAttention(client, params, "matching-late");
    }
    await responseGate("attention_prompt");
  } else if (task === "THIN:write-result") {
    const source = readFileSync(join(process.cwd(), "tracked.txt"), "utf8");
    trace({ kind: "source_before_edit", source, cwd: process.cwd() });
    writeFileSync(join(process.cwd(), "tracked.txt"), "collaborator implementation\n");
    const resultPath = join(process.cwd(), "result.txt"); writeFileSync(resultPath, "Useful collaborator result.\n");
    await update(client, params, { sessionUpdate: "tool_call", toolCallId: "result-file", title: "Created result", kind: "edit", status: "completed",
      content: [{ type: "content", content: { type: "resource_link", uri: `file://${resultPath}`, name: "result.txt", mimeType: "text/plain" } }], locations: [{ path: resultPath }] });
    await chunk(client, params, "answer", "Implementation and result available.");
  } else if (task === "THIN:tool-failure") {
    await update(client, params, { sessionUpdate: "tool_call", toolCallId: "failed-native-tool", title: "Native diagnostic title", kind: "other", status: "in_progress" });
    await update(client, params, { sessionUpdate: "tool_call_update", toolCallId: "failed-native-tool", status: "failed", rawOutput: { error: { code: "native_fixture_limit", message: "Precise native tool rejection" } } });
    await chunk(client, params, "answer", "Root result remains available despite native tool failure.");
  } else if (task === "THIN:tool-failure-diagnostics") {
    const failed = async (toolCallId, body) => update(client, params, { sessionUpdate: "tool_call", toolCallId,
      title: `Diagnostic ${toolCallId}`, kind: "other", status: "failed", ...body });
    await failed("nested-first", { rawOutput: { error: { code: "nested_code", message: "Nested primary failure" },
      message: "Sibling diagnostic message", cause: { message: "Native explicit cause" }, stderr: "STDERR SECRET", stdout: "STDOUT MUST NOT BE A DIAGNOSTIC" } });
    await failed("sibling-first", { rawOutput: { message: "Sibling primary failure", error: "String error detail" } });
    await failed("json-content", { content: [{ type: "content", content: { type: "text", text: JSON.stringify({ error: { message: "Structured JSON failure" }, cause: { message: "Structured cause" }, stderr: "STRUCTURED STDERR SECRET" }) } }] });
    await failed("untrusted-content", { rawOutput: { stdout: "STDOUT SECRET", result: "RESULT SECRET", stderr: "STDERR SECRET", detail: "DETAIL SECRET", details: "DETAILS SECRET" }, content: [
      { type: "content", content: { type: "text", text: "PLAINTEXT SECRET" } },
      { type: "content", content: { type: "resource", resource: { uri: "fixture://diagnostic", mimeType: "application/json", text: JSON.stringify({ error: "RESOURCE SECRET" }) } } },
    ] });
    await update(client, params, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "THOUGHT SECRET" } });
    await failed("bounded", { rawOutput: { error: { message: "P".repeat(5000), cause: { message: "N".repeat(5000) } },
      message: "M".repeat(5000), causes: [{ message: "E".repeat(5000) }, { message: "D".repeat(5000) }, { message: "S".repeat(5000) }] } });
    await chunk(client, params, "answer", "Useful root survives diagnostic extraction.");
  } else if (task === "THIN:media-reference" || task === "THIN:audio-reference") {
    if (!process.env.GROKPAIR_THIN_OUTPUT_DIR) throw new Error("Missing test-owned native output directory");
    const audio = task === "THIN:audio-reference", filename = audio ? "fixture-audio.wav" : "fixture-image.png";
    const path = join(process.env.GROKPAIR_THIN_OUTPUT_DIR, filename);
    writeFileSync(path, audio ? Buffer.from("RIFFfixtureWAVE") : Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await update(client, params, { sessionUpdate: "tool_call", toolCallId: "fixture-image", title: "Fixture native image reference", kind: "other", status: "completed",
      rawOutput: { type: audio ? "UnlistedNativeAudioTool" : "ImageGen", path, filename, session_folder: process.cwd(), uploaded_url: `https://example.invalid/${filename}` } });
    await chunk(client, params, "answer", "Native image reference; inspect before use.");
  } else if (task === "THIN:nested") {
    // Grok may load grokpair itself; record what a nested command-line call gets from this provider environment.
    const nested = spawnSync(process.execPath, [process.env.GROKPAIR_THIN_ENTRYPOINT, "list", "{}"], { encoding: "utf8" });
    trace({ kind: "nested_cli", marker: process.env.GROKPAIR_COLLABORATOR ?? null, status: nested.status, stdout: nested.stdout, stderr: nested.stderr });
    await chunk(client, params, "answer", "Nested call observed.");
  } else if (task === "THIN:crash-after") {
    await chunk(client, params, "partial", "Retain this uncertain partial text.");
    await pause(100); process.exit(72);
  } else await chunk(client, params, "answer", task.startsWith("THIN:echo:") ? task.slice(10) : task);
  const stopReason = entry.cancelled ? "cancelled" : "end_turn";
  trace({ kind: "prompt_returned", prompt_id: id(params), stop_reason: stopReason });
  active = null;
  const follower = queue.shift();
  if (follower) { active = follower; follower.promote("run"); }
  await queueChanged(client, params.sessionId);
  if (task === "THIN:stale-terminal") {
    await nativeTerminal(client, params);
    await client.notify("_x.ai/queue/changed", { sessionId: params.sessionId, entries: [], runningPromptId: id(params), runningKind: "prompt" });
  }
  if (task === "THIN:provider") setTimeout(async () => {
    const provider = { sessionId: params.sessionId, _meta: { promptId: `provider-${randomUUID()}` }, prompt: [{ type: "text", text: "native origin" }] };
    active = { params: provider }; await queueChanged(client, provider.sessionId);
    await chunk(client, provider, "provider-root", "Provider-origin contribution.");
    await nativeTerminal(client, provider); active = null; await queueChanged(client, provider.sessionId);
    trace({ kind: "provider_completed", prompt_id: id(provider) });
  }, 100);
  return { stopReason, _meta: { sessionId: params.sessionId, promptId: id(params) } };
});
app.onNotification("session/cancel", ({ params }) => {
  trace({ kind: "cancel", params }); if (active) { active.cancelled = true; active.release?.(); }
});
app.onNotification("_x.ai/queue/edit", value => value, async ({ params, client }) => {
  const entry = queue.find(value => id(value.params) === params.id);
  if (!entry) throw new Error("No exact queued prompt");
  entry.params.prompt = [{ type: "text", text: params.newText }, ...entry.params.prompt.filter(block => block.type === "image")];
  entry.version++; trace({ kind: "edit", params }); await queueChanged(client, params.sessionId);
});
app.onNotification("_x.ai/queue/remove", value => value, async ({ params, client }) => {
  const index = queue.findIndex(value => id(value.params) === params.id && value.version === params.expectedVersion);
  if (index >= 0) { const [entry] = queue.splice(index, 1); entry.promote("removed"); }
  trace({ kind: "remove", params }); await queueChanged(client, params.sessionId);
});
app.onRequest("_x.ai/interject", value => value, ({ params }) => {
  trace({ kind: "steer", params });
  if (process.env.GROKPAIR_THIN_STEER_KEEP_RUNNING !== "true") active?.release?.();
  return { result: { status: "queued" } };
});
app.onRequest("_x.ai/btw", value => value, async ({ params, client }) => {
  trace({ kind: "side_question", params }); await pause(30);
  if (params.question === "THIN:late-removed-attention") independentAttention(client, lastRemovedPrompt, "removed-late", "plan");
  if (params.question === "THIN:unknown-queue") await client.notify("_x.ai/queue/changed", { sessionId: params.sessionId, entries: [], runningPromptId: `unseen-${randomUUID()}`, runningKind: "prompt" });
  if (params.question === "THIN:clear-queue") await client.notify("_x.ai/queue/changed", { sessionId: params.sessionId, entries: [], runningPromptId: null, runningKind: null });
  return { result: { answer: params.question === "THIN:large-side" ? "Side-only λ\r\n".repeat(8_000) : `Side answer: ${params.question}` } };
});
app.onRequest("session/close", ({ params }) => {
  if (orphanKeepAlive) clearInterval(orphanKeepAlive);
  trace({ kind: "close", params }); if (active) { active.cancelled = true; active.release?.(); }
  if (process.env.GROKPAIR_THIN_CLOSE_ERROR === "true") throw RequestError.internalError({}, "Fixture native close rejection");
  return { _meta: { "x.ai/closeOutcome": "closed" } };
});
const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin), { maxMessageBytes: Number.MAX_SAFE_INTEGER }));
await connection.closed;
transportClosed = true;
trace({ kind: "connection_closed" });
// A native that ends its transport ends its output too, even while its process
// lingers, so the caller observes the end before the process exits.
process.stdout.end();
const exitGate = process.env.GROKPAIR_THIN_EXIT_GATE;
if (exitGate) {
  trace({ kind: "exit_gate_waiting" });
  while (!existsSync(exitGate)) await pause(10);
  trace({ kind: "exit_gate_released" });
}
process.on("exit", code => trace({ kind: "process_exit", code }));
