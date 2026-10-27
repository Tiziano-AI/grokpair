import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { processIdentityStatus, signalProcess } from "../src/process.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Real MCP -> detached production worker -> official SDK -> deterministic ACP
// fixture. This proves bridge behavior, not native Grok or sandbox acceptance.
const entrypoint = process.env.GROKPAIR_TEST_ENTRYPOINT ?? fileURLToPath(new URL("../plugin/lib/grokpair.js", import.meta.url));
const fixturePath = fileURLToPath(new URL("./fixtures/thin-native.mjs", import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const roots = [];
test.after(async () => {
  for (const root of roots) {
    const agentsPath = join(root, "runtime", "runtime-v2", "agents");
    const claims = existsSync(agentsPath) ? readdirSync(agentsPath).map(agentId => workerClaim({ root }, agentId)).filter(Boolean) : [];
    const identities = claims.flatMap(claim => [claim.worker, claim.provider, claim.provisioner].filter(Boolean));
    // ps and kill(0) can straddle final process exit and briefly yield unknown;
    // wait on every not-yet-absent identity, not merely an observed live one.
    for (let attempt = 0; attempt < 60 && identities.some(identity => processIdentityStatus(identity) !== "absent"); attempt++) await pause(50);
    if (identities.some(identity => processIdentityStatus(identity) !== "absent")) {
      process.stderr.write(`Preserving test runtime with unresolved process custody: ${root}\n`);
      continue;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function storedState(current, agentId, key) {
  const path = join(current.root, "runtime", "runtime-v2", "agents", agentId, "agent.sqlite");
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    // Match the production reader's bounded SQLite lock handling: resident
    // settlement can briefly own the write lock during this passive inspection.
    db.exec("PRAGMA busy_timeout=5000;");
    const row = db.prepare("SELECT value FROM state WHERE key=?").get(key); return row ? JSON.parse(row.value) : null;
  }
  finally { db.close(); }
}
const workerClaim = (current, agentId) => storedState(current, agentId, "worker");

function fixture(extra = {}) {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "grokpair-thin-mcp-")));
  roots.push(root);
  const cwd = join(root, "workspace"), bin = join(root, "bin"); mkdirSync(cwd); mkdirSync(bin);
  // exec retains one process identity; PATH is local to the test's MCP process.
  const executable = join(bin, "grok");
  writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixturePath)} "$@"\n`);
  chmodSync(executable, 0o755);
  const tracePath = join(root, "native.jsonl");
  const env = Object.fromEntries(Object.entries({ ...process.env,
    GROKPAIR_HOME: join(root, "runtime"), GROKPAIR_THIN_TRACE: tracePath,
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, ...extra,
  }).filter(([, value]) => typeof value === "string"));
  const traces = () => existsSync(tracePath) ? readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  return { root, cwd, env, traces, agents: new Set() };
}
async function connect(current, { entry = entrypoint, removedNode } = {}) {
  const client = new Client({ name: "thin-real-mcp-fixture", version: "1.0.0" });
  const args = [entry, "mcp"];
  if (removedNode) {
    // An upgrade removes the versioned executable a running server's process.execPath names.
    const preload = join(current.root, "removed-node.mjs");
    writeFileSync(preload, `process.execPath = ${JSON.stringify(removedNode)};\n`); args.unshift(`--import=${pathToFileURL(preload).href}`);
  }
  const transport = new StdioClientTransport({ command: process.execPath, args, cwd: current.cwd, env: current.env, stderr: "pipe" });
  const errors = []; transport.stderr?.on("data", chunk => errors.push(String(chunk)));
  await client.connect(transport, { timeout: 10_000 });
  async function call(name, input, expectedError = false) {
    const raw = await client.callTool({ name, arguments: input }, undefined, { timeout: 20_000 });
    assert.equal(raw.content.length, 1, "one MCP JSON carrier");
    assert.equal(raw.content[0].type, "text");
    assert.equal(Object.hasOwn(raw, "structuredContent"), false);
    const value = JSON.parse(raw.content[0].text);
    assert.equal(value.schema_version, "3");
    assert.equal(Boolean(raw.isError), expectedError, JSON.stringify(value));
    if (name === "grok_spawn" && !expectedError) current.agents.add(value.agent?.agent_id ?? value.agent_id);
    return value;
  }
  return { client, call, errors, close: () => client.close() };
}
async function until(work, predicate, label, timeout = 12_000) {
  const deadline = Date.now() + timeout; let latest;
  do { latest = await work(); if (predicate(latest)) return latest; await pause(35); } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(latest)}`);
}
// Test-only inspection groups drained discriminated records. The production
// public response exposes no legacy unbounded arrays or dual cursor semantics.
function inspect(agent) {
  const of = type => agent.records.filter(record => record.type === type).map(({ type: _, ...record }) => record);
  return { ...agent, content: of("content"), operations: of("operation"), turns: of("turn"), attention: of("attention"), files: of("file"), issues: of("issue"), side_answers: of("side_answer"),
    queue: of("queue").at(-1) ?? { entries: [] }, native_options: of("native_options").at(-1)?.options ?? [] };
}
const readPage = async (mcp, agentId, extra = {}) => (await mcp.call("grok_read", { agent_id: agentId, ...extra })).agent;
// Bridge-behavior assertions inspect the full typed record stream.
const read = async (mcp, agentId, extra = {}) => {
  extra = { view: "records", ...extra };
  let page = await readPage(mcp, agentId, extra);
  const records = [...page.records];
  for (let pages = 0; page.has_more; pages++) {
    assert.ok(pages < 1_000, "record pagination must advance");
    page = await readPage(mcp, agentId, { ...extra, cursor: page.cursor }); records.push(...page.records);
  }
  return inspect({ ...page, records });
};
const spawn = async (mcp, current, task) => {
  const result = await mcp.call("grok_spawn", { task, cwd: current.cwd });
  return result.agent?.agent_id ?? result.agent_id;
};
const done = (mcp, agentId) => until(() => read(mcp, agentId), value => value.status === "idle"
  && value.operations.filter(item => ["follow_up", "send_now"].includes(item.kind)).every(item => !["admitted", "started"].includes(item.status)), "root completion");
const contentText = value => value.records ? value.records.filter(item => item.type === "content").map(item => item.text).join("")
  : (value.turns ?? []).map(turn => turn.text ?? "").join("");
async function clean(current, mcp, { pageOnly = false } = {}) {
  for (const agentId of current.agents) {
    try {
      await mcp.call("grok_close", { agent_id: agentId });
      await until(() => pageOnly ? readPage(mcp, agentId, { max_chars: 4_000 }) : read(mcp, agentId), value => value.status === "closed", "cleanup close");
    } catch {}
  }
  await mcp.close();
}
function git(cwd, ...args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trimEnd();
}

test("MCP disconnect does not kill admitted work; follow-up reuses one resident native session", { timeout: 30_000 }, async () => {
  const current = fixture(); let mcp = await connect(current);
  try {
    const spawned = await mcp.call("grok_spawn", { task: "THIN:delayed:First complete answer.\r\n", cwd: current.cwd }), agentId = spawned.agent_id;
    await mcp.close(); mcp = await connect(current);
    const first = await done(mcp, agentId);
    assert.equal(contentText(first), "First complete answer.\r\n");
    const follow = await mcp.call("grok_send", { agent_id: agentId, task: "THIN:echo:Second complete answer." });
    const second = await until(() => read(mcp, agentId), value => value.status === "idle" && contentText(value).includes("Second complete answer."), "follow-up completion");
    assert.equal(contentText(second), "First complete answer.\r\nSecond complete answer.");
    // What a caller sees by default: each prompt's turn, linked to the operation that sent it.
    const view = (await mcp.call("grok_read", { agent_id: agentId })).agent;
    assert.equal(Object.hasOwn(view, "records"), false); assert.equal(view.has_more, false);
    assert.deepEqual(view.turns.map(turn => [turn.operation_id, turn.status, turn.stop_reason, turn.text]), [
      [spawned.operation_id, "completed", "end_turn", "First complete answer.\r\n"],
      [follow.operation_id, "completed", "end_turn", "Second complete answer."]]);
    assert.equal(Object.hasOwn(view, "operations"), false, "completed prompt operations deliver through their turns");
    const prompts = current.traces().filter(item => item.kind === "prompt_received");
    assert.equal(prompts.length, 2); assert.equal(new Set(prompts.map(item => item.pid)).size, 1);
    assert.equal(prompts[0].params.prompt[0].text, "THIN:delayed:First complete answer.\r\n");
    assert.equal(new Set(prompts.map(item => item.session_id)).size, 1);
    assert.equal(current.traces().filter(item => item.kind === "new_session").length, 1);
  } finally { await clean(current, mcp); }
});

test("root cancellation releases output with a permanently in-progress tool", { timeout: 30_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:hold");
    await until(() => read(mcp, agentId), value => contentText(value) === "Before cancellation.", "hold text");
    await mcp.call("grok_interrupt", { agent_id: agentId });
    const result = await done(mcp, agentId);
    assert.equal(contentText(result), "Before cancellation.");
    assert.ok(result.operations.some(item => item.result?.stopReason === "cancelled" || item.result?.stop_reason === "cancelled"));
    assert.equal(current.traces().filter(item => item.kind === "cancel").length, 1);
  } finally { await clean(current, mcp); }
});

test("async large root fragments preserve exact order and bounded read pagination", { timeout: 30_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:fragments"); await done(mcp, agentId);
    let cursor; let all = ""; let pages = 0; const blocks = new Set(), messages = new Set();
    do {
      const page = await readPage(mcp, agentId, { view: "records", max_chars: 4_000, ...(cursor ? { cursor } : {}) });
      assert.ok(JSON.stringify(page).length <= 4_000, "the entire page stays within max_chars, not only content");
      const text = contentText(page); all += text; pages++;
      for (const item of page.records.filter(record => record.type === "content")) { blocks.add(item.block_index); messages.add(item.native_message_id); }
      cursor = page.has_more ? page.cursor : undefined;
      assert.ok(pages < 500, "pagination must advance");
    } while (cursor);
    const expected = Array.from({ length: 180 }, (_, index) => `Fragment ${String(index).padStart(3, "0")}: ${"λ".repeat(701)}\r\n`).join("");
    assert.equal(all, expected); assert.ok(pages > 20); assert.equal(all.includes("PRIVATE THOUGHT"), false);
    assert.equal(blocks.size, 6); assert.equal(messages.size, 6);
    // The caller's view of the same turn: one text in which each native message block follows a blank line.
    let resultText = "", resultCursor, resultPages = 0;
    do {
      const page = await readPage(mcp, agentId, { max_chars: 4_000, ...(resultCursor ? { cursor: resultCursor } : {}) });
      assert.ok(JSON.stringify(page).length <= 4_000); assert.ok((page.turns ?? []).length <= 1);
      resultText += contentText(page); resultPages++;
      resultCursor = page.has_more ? page.cursor : undefined;
    } while (resultCursor && resultPages < 500);
    const message = index => Array.from({ length: 30 }, (_, fragment) => `Fragment ${String(index * 30 + fragment).padStart(3, "0")}: ${"λ".repeat(701)}\r\n`).join("");
    assert.equal(resultText, Array.from({ length: 6 }, (_, index) => message(index)).join("\n\n"));
  } finally { await clean(current, mcp); }
});

test("a single native notification above 32 MiB survives the official framing limit and bounded MCP reads", { timeout: 120_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:large-notification");
    await until(() => readPage(mcp, agentId, { view: "records", max_chars: 4_000 }), value => value.status === "idle", "large native frame completion", 60_000);
    const expected = `Large native frame λ🙂\r\n${"λ🙂".repeat(6 * 1024 * 1024)}\r\nExact end.`;
    assert.ok(Buffer.byteLength(expected) > 32 * 1024 * 1024, "the actual native text, not aggregated smaller frames, crosses ACP's default limit");
    let cursor, all = "", pages = 0, final;
    do {
      const response = await mcp.call("grok_read", { agent_id: agentId, view: "records", max_chars: 1_000_000, ...(cursor ? { cursor } : {}) });
      const page = response.agent;
      assert.ok(JSON.stringify(response).length <= 1_000_000, "the full public result remains bounded");
      assert.equal(page.oversized, undefined);
      all += contentText(page); pages++;
      assert.ok(pages < 50, "each bounded read advances over the giant native record");
      final = page; cursor = page.has_more ? page.cursor : undefined;
    } while (cursor);
    assert.equal(all.length, expected.length);
    assert.equal(all === expected, true, "every Unicode character and CRLF survives bounded pagination exactly");
    assert.ok(pages > 10, "one native notification is split over many public pages");
    const native = current.traces().find(item => item.kind === "large_notification");
    assert.deepEqual([native.text_bytes, native.text_chars, native.sha256], [Buffer.byteLength(expected), expected.length, sha256(expected)]);
    assert.ok(readFileSync(join(current.root, "native.jsonl")).length < 100_000, "fixture traces retain counts/digests, not the giant text");
    await mcp.call("grok_send", { agent_id: agentId, task: "THIN:echo:After the giant frame." });
    const follow = await until(() => readPage(mcp, agentId, { view: "records", cursor: final.cursor, max_chars: 8_000 }),
      value => value.status === "idle" && contentText(value) === "After the giant frame.", "same transport remains usable after large notification");
    assert.equal(contentText(follow), "After the giant frame.");
    assert.equal(current.traces().filter(item => item.kind === "new_session").length, 1);
  } finally { await clean(current, mcp, { pageOnly: true }); }
});

for (const scenario of ["unfinished-frame", "malformed-frame"]) test(`native ${scenario} retains admitted work as unknown without replay or invented completion`, { timeout: 40_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const originalTask = `THIN:${scenario}`;
    const admitted = await mcp.call("grok_spawn", { task: originalTask, cwd: current.cwd }), agentId = admitted.agent_id;
    // Passive status can observe the provider's exit before the resident has
    // committed final turn disposition; wait for the actual claim release.
    const failed = await until(() => read(mcp, agentId), value => value.status === "disconnected"
      && value.counts.pending_operations === 0 && value.turns.some(turn => turn.status === "unknown")
      && workerClaim(current, agentId) === null, "broken ACP transport settles admitted work");
    assert.equal(contentText(failed), "Retain this exact partial text λ🙂.\r\n");
    assert.equal(failed.operations.find(item => item.operation_id === admitted.operation_id)?.status, "outcome_unknown");
    assert.ok(failed.turns.some(turn => turn.status === "unknown"));
    assert.equal(failed.turns.some(turn => turn.status === "completed"), false);
    const launches = current.traces().filter(item => item.kind === "launch").length;
    await read(mcp, agentId); await mcp.call("grok_wait", { targets: [{ agent_id: agentId }], timeout_ms: 0 });
    assert.equal(current.traces().filter(item => item.kind === "launch").length, launches, "observation is passive after framing failure");
    const resumed = await mcp.call("grok_send", { agent_id: agentId, resume: true, task: "THIN:echo:Only this new input." });
    const result = await until(() => read(mcp, agentId), value => value.status === "idle"
      && value.operations.find(item => item.operation_id === resumed.operation_id)?.status === "completed", "explicit new work after framing failure");
    assert.equal(contentText(result), "Retain this exact partial text λ🙂.\r\nOnly this new input.");
    assert.equal(result.operations.find(item => item.operation_id === admitted.operation_id)?.status, "outcome_unknown");
    const prompts = current.traces().filter(item => item.kind === "prompt_received");
    assert.equal(prompts.filter(item => item.text === originalTask).length, 1, "the uncertain original was never replayed");
    assert.equal(prompts.filter(item => item.text === "THIN:echo:Only this new input.").length, 1);
    assert.equal(new Set(prompts.map(item => item.session_id)).size, 1);
  } finally { await clean(current, mcp); }
});

test("native-origin exact terminal returns root idle without invented caller operation", { timeout: 30_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:provider");
    const result = await until(() => read(mcp, agentId), value => value.status === "idle" && contentText(value).includes("Provider-origin contribution."), "native-origin completion");
    assert.equal(result.operations.filter(item => item.kind === "follow_up").length, 1);
    assert.equal(result.operations.length, 1);
    assert.equal(contentText(result), "THIN:providerProvider-origin contribution.");
    assert.ok(result.turns.some(turn => turn.source === "turn_completed" && turn.status === "completed" && turn.prompt_id.startsWith("provider-")));
  } finally { await clean(current, mcp); }
});

test("pending native methods reject a wrong response without consuming authority and forward exact valid responses", { timeout: 45_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:attention");
    const responses = [
      ["session/request_permission", { outcome: { outcome: "selected", optionId: "allow" }, _meta: { exact: null } }],
      ["_x.ai/ask_user_question", { outcome: "accepted", answers: { "Choose fixture color?": ["Blue"] },
        annotations: { "Choose fixture color?": { notes: "Notes with an ordinary label.", preview: null } } }],
      ["_x.ai/exit_plan_mode", { outcome: "cancelled", feedback: "Return the result, without changes." }],
      ["_x.ai/mcp/elicit", { outcome: "accept", content: { count: 3 } }],
    ];
    for (const [method, response] of responses) {
      const result = await until(() => read(mcp, agentId), value => value.attention.some(item => item.method === method && item.status === "pending"), `pending ${method}`);
      const pending = result.attention.find(item => item.method === method && item.status === "pending");
      assert.equal("kind" in pending, false);
      assert.equal(pending.payload.sessionId, current.traces().find(item => item.kind === "new_session").session_id);
      const wrong = method === "session/request_permission" ? { outcome: "approved" } : { outcome: { outcome: "cancelled" } };
      await mcp.call("grok_respond", { agent_id: agentId, request_id: pending.request_id, response: wrong }, true);
      assert.equal((await read(mcp, agentId)).attention.find(item => item.request_id === pending.request_id).status, "pending");
      await mcp.call("grok_respond", { agent_id: agentId, request_id: pending.request_id, response });
    }
    assert.equal(contentText(await done(mcp, agentId)), "All native requests answered.");
    assert.deepEqual(current.traces().filter(item => item.kind === "attention_response").map(item => item.response), responses.map(([, response]) => response));
  } finally { await clean(current, mcp); }
});

test("huge escaped native attention reconstructs through bounded MCP read and aggregate wait before one exact answer", { timeout: 30_000 }, async () => {
  const current = fixture(), mcp = await connect(current), budget = 1800;
  const bounded = async (name, input) => {
    const result = await mcp.call(name, { ...input, max_chars: budget });
    assert.ok(JSON.stringify(result).length <= budget, "max_chars bounds the whole public JSON, including aggregate envelopes and escaping");
    return result;
  };
  try {
    const agentId = await spawn(mcp, current, "THIN:huge-attention"), siblingId = await spawn(mcp, current, "THIN:echo:Short sibling result.");
    await until(() => bounded("grok_read", { agent_id: agentId }), result => result.agent.status === "attention", "huge reverse request pending");
    await until(async () => current.traces(), rows => rows.some(row => row.kind === "prompt_returned" && row.prompt_id
      === rows.find(item => item.kind === "prompt_received" && item.text === "THIN:echo:Short sibling result.")?.prompt_id), "short sibling completed");
    const native = current.traces().find(item => item.kind === "huge_attention_requested").payload;
    assert.ok(JSON.stringify(native).length > budget * 20, "one native decision requires many bounded pages");
    const cursors = new Map(); let json = "", recordId, pending, fragmentPages = 0, siblingText = "", more = true;
    const target = agent_id => ({ agent_id, ...(cursors.has(agent_id) ? { cursor: cursors.get(agent_id) } : {}) });
    const consume = page => {
      cursors.set(page.agent_id, page.cursor);
      if (page.agent_id === siblingId) { siblingText += contentText(page); return; }
      assert.equal(page.agent_id, agentId); assert.equal(page.status, "attention"); more = page.has_more;
      assert.equal(page.attention, undefined, "a partial native decision must never look like a complete attention object");
      assert.equal(page.fragment_reset, undefined, "this fixture leaves the pending request unchanged while it is read");
      for (const fragment of page.fragments ?? []) {
        assert.deepEqual(Object.keys(page).sort(), ["agent_id", "cursor", "fragments", "has_more", "status"]);
        assert.equal(fragment.record_type, "attention"); assert.equal(fragment.offset, json.length);
        recordId ??= fragment.record_id; assert.equal(fragment.record_id, recordId);
        assert.equal(pending, undefined, "no fragment follows a completed request representation");
        json += fragment.json; fragmentPages++;
        if (fragment.complete) pending = JSON.parse(json);
      }
      assert.equal(current.traces().some(row => row.kind === "huge_attention_response"), false, "reading even the final fragment does not answer the native request");
    };
    const first = await bounded("grok_wait", { targets: [target(agentId), target(siblingId)], until: "settled", timeout_ms: 0 });
    assert.equal(first.call_status, "settled"); assert.ok(first.agents.some(page => page.agent_id === agentId)); first.agents.forEach(consume);
    // Rotate the excluded short sibling first, keeping only cursors actually delivered.
    const rotated = await bounded("grok_wait", { targets: [target(siblingId), target(agentId)], until: "settled", timeout_ms: 0 });
    rotated.agents.forEach(consume);
    for (let pages = 0; more; pages++) {
      assert.ok(pages < 500, "the public cursor must advance across the structured native record");
      if (pages % 2) {
        const result = await bounded("grok_wait", { targets: [target(agentId)], until: "change", timeout_ms: 0 }); result.agents.forEach(consume);
      } else consume((await bounded("grok_read", target(agentId))).agent);
    }
    assert.ok(fragmentPages > 20); assert.equal(siblingText, "Short sibling result.");
    assert.equal(pending.type, "attention"); assert.equal(pending.method, "session/request_permission"); assert.equal(pending.status, "pending");
    assert.deepEqual(pending.payload, native, "the caller reconstructs every escaped character and native field before choosing an offered option");
    const response = { outcome: { outcome: "selected", optionId: pending.payload.options[0].optionId } };
    await mcp.call("grok_respond", { agent_id: agentId, request_id: pending.request_id, response });
    const finished = await until(() => bounded("grok_read", target(agentId)), result => result.agent.status === "idle", "huge request resolved and root complete");
    assert.equal(finished.agent.counts.pending_attention, 0); assert.equal(contentText(finished.agent), "Huge native request answered exactly once.");
    const duplicate = await mcp.call("grok_respond", { agent_id: agentId, request_id: pending.request_id, response }, true);
    assert.equal(duplicate.error.code, "attention_not_pending"); assert.equal(duplicate.error.admission, "none");
    assert.deepEqual(current.traces().filter(row => row.kind === "huge_attention_response").map(row => row.response), [response]);
    assert.equal(current.traces().filter(row => row.kind === "huge_attention_requested").length, 1);
    assert.equal(current.traces().filter(row => row.kind === "prompt_received" && row.text === "THIN:huge-attention").length, 1, "neither pagination nor response retries replay the native prompt");
  } finally { await clean(current, mcp, { pageOnly: true }); }
});

for (const live of [true, false]) test(`prompt cancellation expires reverse attention from ${live ? "live terminal before held prompt RPC" : "cancelled prompt response without notification"}`, { timeout: 35_000 }, async () => {
  const current = fixture();
  const cancelGate = join(current.root, "attention-cancel-release"), promptGate = join(current.root, "attention-prompt-release");
  current.env.GROKPAIR_THIN_ATTENTION_CANCEL_GATE = cancelGate;
  current.env.GROKPAIR_THIN_ATTENTION_PROMPT_GATE = promptGate;
  const mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, `THIN:attention-cancel-${live ? "live" : "response"}`);
    const initial = await until(() => read(mcp, agentId), value => value.attention.length === (live ? 4 : 1), "independent reverse requests");
    const matching = initial.attention.find(item => item.payload.toolCall?.title === "matching-pending");
    const promptId = initial.operations.find(item => item.kind === "follow_up").native_prompt_id;
    assert.equal(matching.prompt_id, promptId);
    let completed;
    if (live) {
      completed = initial.attention.find(item => item.payload.toolCall?.title === "matching-completed");
      await mcp.call("grok_respond", { agent_id: agentId, request_id: completed.request_id, response: { outcome: { outcome: "selected", optionId: "allow" } } });
      await until(() => read(mcp, agentId), value => value.attention.find(item => item.request_id === completed.request_id)?.status === "resolved", "answered reverse request");
    }
    await until(async () => current.traces(), value => value.some(item => item.kind === "attention_cancel_ready"), "native independently cancellable prompt");
    await mcp.call("grok_interrupt", { agent_id: agentId });
    await until(async () => current.traces(), value => value.some(item => item.kind === "response_gate_waiting" && item.name === "attention_cancel"), "cancel admitted but terminal gated");
    assert.equal((await read(mcp, agentId)).attention.find(item => item.request_id === matching.request_id).status, "pending", "interrupt admission is not native cancellation evidence");
    writeFileSync(cancelGate, "release native cancellation");
    if (!live) {
      await until(async () => current.traces(), value => value.some(item => item.kind === "response_gate_waiting" && item.name === "attention_prompt"), "prompt response held without notification");
      assert.equal((await read(mcp, agentId)).attention.find(item => item.request_id === matching.request_id).status, "pending");
      writeFileSync(promptGate, "return cancelled prompt");
    }
    const cancelled = await until(() => read(mcp, agentId), value => value.attention.find(item => item.request_id === matching.request_id)?.status === "expired", "matching attention expires");
    const expired = cancelled.attention.find(item => item.request_id === matching.request_id);
    assert.equal(expired.reason, "prompt_cancelled");
    assert.equal(expired.source, live ? "turn_completed" : "prompt_response");
    assert.equal(typeof expired.expired_at, "string");
    assert.equal(expired.prompt_id, promptId); assert.deepEqual(expired.payload, matching.payload);
    assert.equal(Object.hasOwn(expired, "response"), false, "expiration never manufactures a native answer");
    await mcp.call("grok_respond", { agent_id: agentId, request_id: matching.request_id, response: { outcome: { outcome: "selected", optionId: "allow" } } }, true);
    if (live) {
      assert.equal(current.traces().some(item => item.kind === "prompt_returned" && item.prompt_id === promptId), false, "live terminal expires attention while prompt RPC is still held");
      const late = await until(() => read(mcp, agentId), value => value.attention.some(item => item.payload.toolCall?.title === "matching-late" && item.status === "expired"), "late matching attention stays expired");
      const lateItem = late.attention.find(item => item.payload.toolCall?.title === "matching-late");
      assert.equal(lateItem.reason, "prompt_cancelled"); assert.equal(lateItem.prompt_id, promptId);
      assert.equal(late.attention.find(item => item.request_id === completed.request_id).status, "resolved");
      for (const label of ["other-prompt", "unscoped"]) {
        const item = late.attention.find(item => item.payload.planContent === label);
        assert.equal(item.status, "pending", `${label} must not inherit another prompt cancellation`);
        assert.equal(item.prompt_id, label === "unscoped" ? undefined : "fixture-other-prompt");
        await mcp.call("grok_respond", { agent_id: agentId, request_id: item.request_id, response: { outcome: "approved" } });
      }
      writeFileSync(promptGate, "return cancelled prompt");
    }
    await done(mcp, agentId);
    await mcp.call("grok_send", { agent_id: agentId, task: "THIN:echo:Useful work after cancellation." });
    const followed = await until(() => read(mcp, agentId), value => value.status === "idle" && contentText(value) === "Useful work after cancellation.", "useful follow-up without stale attention");
    assert.equal(followed.attention.some(item => item.status === "pending"), false);
    const answered = current.traces().filter(item => item.kind === "independent_attention_response");
    assert.equal(answered.some(item => ["matching-pending", "matching-late"].includes(item.label)), false, "expired RPC receives no fabricated decision");
  } finally {
    writeFileSync(cancelGate, "cleanup"); writeFileSync(promptGate, "cleanup"); await clean(current, mcp);
  }
});

test("native queue edits target exact IDs, side answers stay separate, and send-now forwards native metadata", { timeout: 35_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:hold");
    await until(() => read(mcp, agentId), value => contentText(value) === "Before cancellation.", "root hold");
    await mcp.call("grok_send", { agent_id: agentId, task: "THIN:echo:Queued original." });
    const queued = await until(() => read(mcp, agentId), value => value.queue.entries.length === 1, "native queued snapshot");
    const promptId = queued.queue.entries[0].id;
    await mcp.call("grok_send", { agent_id: agentId, action: "edit", prompt_id: promptId, task: "THIN:echo:Queued edited." });
    const guidance = current.traces().find(item => item.kind === "prompt_received").params.prompt[1].text;
    const editedText = `THIN:echo:Queued edited.\n\n${guidance}`;
    await until(() => read(mcp, agentId), value => value.queue.entries[0]?.text === editedText, "native edit snapshot");
    await mcp.call("grok_send", { agent_id: agentId, action: "side_question", task: "What remains?" });
    const side = await until(() => read(mcp, agentId), value => value.operations.some(item => item.kind === "side_question" && item.status === "completed"), "side answer");
    assert.equal(contentText(side), "Before cancellation.");
    assert.equal(side.side_answers.map(item => item.text).join(""), "Side answer: What remains?");
    assert.deepEqual(side.operations.find(item => item.kind === "side_question").result, { side_answer: true });
    await mcp.call("grok_send", { agent_id: agentId, action: "send_now", task: "THIN:echo:Immediate." });
    const final = await until(() => read(mcp, agentId), value => value.status === "idle" && contentText(value).includes("Queued edited."), "native queue drained");
    assert.equal(contentText(final), `Before cancellation.Immediate.Queued edited.\n\n${guidance}`);
    const dispatched = current.traces().filter(item => item.kind === "prompt_received");
    assert.equal(dispatched.find(item => item.text === "THIN:echo:Immediate.").params._meta.sendNow, true);
    assert.equal(current.traces().find(item => item.kind === "edit").params.id, promptId);
    assert.equal(current.traces().find(item => item.kind === "edit").params.newText, editedText);
    assert.equal(final.queue.entries.length, 0);
  } finally { await clean(current, mcp); }
});

test("targeted interrupt rejects the running ID and captures the queued version without session-cancel fallback", { timeout: 30_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:hold");
    const active = await until(() => read(mcp, agentId), value => contentText(value) === "Before cancellation." && value.queue.runningPromptId, "running root");
    await mcp.call("grok_interrupt", { agent_id: agentId, prompt_id: active.queue.runningPromptId }, true);
    assert.equal(current.traces().filter(item => item.kind === "cancel").length, 0);
    const queuedOperation = await mcp.call("grok_send", { agent_id: agentId, task: "THIN:echo:Will be removed." });
    const queued = await until(() => read(mcp, agentId), value => value.queue.entries.length === 1, "queued entry");
    const promptId = queued.queue.entries[0].id;
    await mcp.call("grok_send", { agent_id: agentId, action: "edit", prompt_id: promptId, task: "THIN:echo:Edited but removed." });
    const edited = await until(() => read(mcp, agentId), value => value.queue.entries[0]?.version === 1, "versioned queued edit");
    await mcp.call("grok_interrupt", { agent_id: agentId, prompt_id: promptId });
    const removed = await until(() => read(mcp, agentId), value => value.operations.find(item => item.operation_id === queuedOperation.operation_id)?.result?._meta?.completionKind === "removedFromQueue", "versioned removal");
    assert.equal(current.traces().find(item => item.kind === "remove").params.expectedVersion, edited.queue.entries[0].version);
    assert.equal(current.traces().filter(item => item.kind === "cancel").length, 0);
    assert.equal(removed.queue.runningPromptId, active.queue.runningPromptId);
    assert.equal(removed.status, "working");
    await mcp.call("grok_interrupt", { agent_id: agentId, prompt_id: promptId }, true);
    assert.equal(current.traces().filter(item => item.kind === "cancel").length, 0);
  } finally { await clean(current, mcp); }
});

for (const removal of ["combination", "interjection", "goal"]) test(`${removal} removal retains live and late attention without inventing a cancelled turn`, { timeout: 30_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, `THIN:removed:${removal}`);
    const removed = await until(() => read(mcp, agentId), value => value.operations.some(item => item.result?._meta?.completionKind === "removedFromQueue")
      && value.attention.some(item => item.status === "pending"), "removed prompt and live attention");
    const operation = removed.operations.find(item => item.result?._meta?.completionKind === "removedFromQueue");
    const promptId = operation.native_prompt_id;
    assert.deepEqual(operation.result, current.traces().find(item => item.kind === "removed_prompt_response").result);
    assert.equal(removed.turns.some(item => ["completed", "cancelled"].includes(item.status)), false);
    assert.equal(removed.turns.find(item => item.prompt_id === promptId).status, "running", "raw first-chunk observation remains available");
    assert.equal(removed.counts.queued_prompts, 0); assert.equal(removed.status, "attention");
    assert.equal(removed.queue.runningPromptId, promptId, "stale native observation is preserved");
    await mcp.call("grok_interrupt", { agent_id: agentId, prompt_id: promptId }, true);
    await mcp.call("grok_send", { agent_id: agentId, action: "edit", prompt_id: promptId, task: "Must not retarget removed input" }, true);
    assert.equal(current.traces().some(item => ["remove", "edit", "cancel"].includes(item.kind)), false);
    await mcp.call("grok_send", { agent_id: agentId, action: "side_question", task: "THIN:late-removed-attention" });
    const late = await until(() => read(mcp, agentId), value => value.attention.length === 2, "late attention remains answerable");
    assert.ok(late.attention.every(item => item.status === "pending" && item.prompt_id === promptId));
    for (const item of late.attention) {
      await mcp.call("grok_respond", { agent_id: agentId, request_id: item.request_id, response: item.method === "session/request_permission"
        ? { outcome: { outcome: "selected", optionId: "allow" } } : { outcome: "approved" } });
    }
    await until(() => read(mcp, agentId), value => value.status === "idle" && value.attention.every(item => item.status === "resolved"), "removed root no longer autonomous");
    await until(async () => current.traces(), value => value.filter(item => item.kind === "independent_attention_response").length === 2, "both native interactions responded once");
    await mcp.call("grok_respond", { agent_id: agentId, request_id: late.attention[0].request_id,
      response: { outcome: { outcome: "selected", optionId: "allow" } } }, true);
    assert.equal(current.traces().some(item => item.kind === "independent_attention_rejected"), false);
    assert.equal(current.traces().filter(item => item.kind === "independent_attention_response").length, 2);
    assert.equal(current.traces().filter(item => item.kind === "prompt_received").length, 1);
    const result = await readPage(mcp, agentId);
    assert.ok(result.operations.some(item => item.operation_id === operation.operation_id && item.result._meta.completionKind === "removedFromQueue"));
    assert.equal(result.turns.some(item => item.prompt_id === promptId && item.status !== undefined), false);
  } finally { await clean(current, mcp); }
});

test("steer waits for earlier configured prompt dispatch, not inference, and preserves native image content", { timeout: 25_000 }, async () => {
  const current = fixture({ GROKPAIR_THIN_STEER_KEEP_RUNNING: "true" });
  const gate = join(current.root, "steer-model-response-release");
  current.env.GROKPAIR_THIN_CONFIGURE_MODEL_GATE = gate;
  const mcp = await connect(current);
  try {
    const spawned = await mcp.call("grok_spawn", { task: "THIN:hold", cwd: current.cwd, model: "fixture-alternate" });
    const agentId = spawned.agent_id;
    await until(async () => current.traces(), value => value.some(item => item.kind === "response_gate_waiting" && item.name === "configure_model"), "initial prompt model setter held");
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), path = join(current.root, "steer.png"); writeFileSync(path, bytes);
    const task = "Use this visual reference.\r\n";
    const admitted = await mcp.call("grok_send", { agent_id: agentId, action: "steer", task, attachments: [{ path, kind: "image" }] });
    // The explicit setter gate owns the ordering contrast. Let the resident
    // observe the admitted steer while the earlier prompt cannot dispatch.
    await pause(250);
    assert.equal(current.traces().some(item => item.kind === "prompt_received"), false);
    assert.equal(current.traces().some(item => item.kind === "steer"), false, "steer must not overtake an earlier admitted prompt's configuration");
    writeFileSync(gate, "allow earlier prompt dispatch");
    const result = await until(() => read(mcp, agentId), value => value.operations.find(item => item.operation_id === admitted.operation_id)?.status === "completed", "image steer completed");
    const events = current.traces(), native = events.find(item => item.kind === "steer").params;
    assert.ok(events.findIndex(item => item.kind === "prompt_received") < events.findIndex(item => item.kind === "steer"));
    assert.equal(events.some(item => item.kind === "prompt_returned"), false, "steer must dispatch while the earlier prompt is still running");
    assert.equal(result.operations.find(item => item.operation_id === spawned.operation_id).status, "started");
    assert.equal(native.text, task); assert.equal(native.interjectionId, admitted.operation_id);
    assert.deepEqual(native.content[0], { type: "text", text: task });
    assert.equal(native.content[1].type, "image");
    assert.deepEqual(Buffer.from(native.content[1].data, "base64"), bytes);
    assert.equal(current.traces().filter(item => item.kind === "prompt_received").length, 1);
    assert.equal(contentText(result), "Before cancellation.");
  } finally { writeFileSync(gate, "release test-owned gate"); await clean(current, mcp); }
});

test("missing queue evidence remains ready and null, not manufactured idle or zero", { timeout: 25_000 }, async () => {
  const current = fixture({ GROKPAIR_THIN_NO_QUEUE: "true" }), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:echo:Completed root, unobserved queue.");
    const result = await until(() => read(mcp, agentId), value => value.status === "ready", "ready without queue snapshot");
    assert.equal(contentText(result), "Completed root, unobserved queue.");
    assert.equal(result.counts.queued_prompts, null);
    assert.equal(result.queue_observation.status, "unknown");
    assert.equal(result.records.some(item => item.type === "queue"), false);
    await mcp.call("grok_send", { agent_id: agentId, action: "side_question", task: "THIN:clear-queue" });
    const observed = await until(() => read(mcp, agentId), value => value.status === "idle", "real empty queue observed");
    assert.deepEqual(observed.queue_observation, { status: "observed" });
    assert.equal(observed.counts.queued_prompts, 0);
  } finally { await clean(current, mcp); }
});

test("resume without a native queue snapshot retains unknown queue without synthetic entries", { timeout: 30_000 }, async () => {
  const current = fixture({ GROKPAIR_THIN_NO_QUEUE: "true" }), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:crash-after");
    await until(() => read(mcp, agentId), value => value.status === "disconnected", "native disconnected before resume");
    await until(async () => workerClaim(current, agentId), value => value === null, "prior resident released after provider exit");
    const resumed = await mcp.call("grok_send", { agent_id: agentId, resume: true, task: "THIN:echo:New work with no observed queue." });
    const result = await until(() => read(mcp, agentId), value => value.status === "ready"
      && value.operations.find(item => item.operation_id === resumed.operation_id)?.status === "completed", "resumed root completed with unknown queue");
    assert.equal(result.counts.queued_prompts, null);
    assert.equal(result.queue_observation.status, "unknown");
    const queue = result.records.find(item => item.type === "queue");
    assert.ok(queue, "resume must explicitly invalidate the previous queue observation");
    assert.equal(queue.unavailable, true);
    assert.equal(Object.hasOwn(queue, "entries"), false, "unknown queue is not an observed empty queue");
    assert.equal(typeof queue.reason, "string");
    assert.equal(contentText(result), "Retain this uncertain partial text.New work with no observed queue.");
    assert.equal(current.traces().filter(item => item.kind === "prompt_received" && item.text === "THIN:crash-after").length, 1);
    assert.equal(current.traces().filter(item => item.kind === "resume_session").length, 1);
  } finally { await clean(current, mcp); }
});

test("native question outcomes preserve partial/null payloads and cancellation resolves rather than expiring prompt", { timeout: 35_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:native-question-outcomes");
    const variants = [
      ["empty", { outcome: "accepted", answers: {}, annotations: null }],
      ["partial", { outcome: "accepted", answers: { "Question?": ["A"] }, annotations: { "Question?": { notes: "ordinary-label note", preview: null } } }],
      ["cancelled", { outcome: "cancelled" }],
      ["chat", { outcome: "chat_about_this", partial_answers: { "Question?": "Other" } }],
      ["skip", { outcome: "skip_interview" }],
    ];
    for (const [label, response] of variants) {
      const observed = await until(() => read(mcp, agentId), value => value.attention.some(item => item.payload.toolCallId === "question-" + label && item.status === "pending"), "question " + label);
      const request = observed.attention.find(item => item.payload.toolCallId === "question-" + label);
      assert.deepEqual(request.payload, current.traces().find(item => item.kind === "variant_attention_requested" && item.label === label).payload);
      await mcp.call("grok_respond", { agent_id: agentId, request_id: request.request_id, response });
      await until(() => read(mcp, agentId), value => value.attention.find(item => item.request_id === request.request_id)?.status === "resolved", "resolved " + label);
    }
    const result = await done(mcp, agentId);
    assert.equal(contentText(result), "Question cancellation completed normally.");
    assert.equal(result.turns.some(item => item.status === "cancelled"), false);
    assert.deepEqual(current.traces().filter(item => item.kind === "variant_attention_response").map(item => item.response), variants.map(([, response]) => response));
  } finally { await clean(current, mcp); }
});

test("known malformed native attention is retained rejected with exact payload and error, not pending forever", { timeout: 25_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:malformed-attention"), result = await done(mcp, agentId);
    const rejected = result.attention.find(item => item.payload.toolCallId === "invalid-question");
    assert.equal(rejected.status, "rejected"); assert.equal(rejected.method, "_x.ai/ask_user_question");
    assert.deepEqual(rejected.payload, current.traces().find(item => item.kind === "malformed_attention_requested").payload);
    assert.equal(rejected.error.code, "invalid_native_attention");
    assert.equal(result.counts.pending_attention, 0);
    assert.equal(contentText(result), "Malformed reverse request did not hang.");
    assert.equal(current.traces().filter(item => item.kind === "malformed_attention_rejected").length, 1);
  } finally { await clean(current, mcp); }
});

test("interleaved background tasks and elicitation completion retain native payloads separately without gating root completion", { timeout: 25_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:background-notices"); await done(mcp, agentId);
    // Notices do not gate root completion, so one can be retained just after the root settles.
    const result = await until(() => read(mcp, agentId), value => value.records.some(item => item.type === "elicitation_completion")
      && value.records.some(item => item.type === "background" && item.task_id === "task-a" && "completed" in item.observations), "notices retained");
    const tasks = result.records.filter(item => item.type === "background");
    assert.equal(tasks.length, 2);
    const notices = current.traces().filter(item => item.kind === "background_native_notice");
    for (const item of tasks) {
      assert.deepEqual(item.observations.backgrounded, { method: "_x.ai/session_notification",
        payload: notices.find(notice => notice.update.sessionUpdate === "task_backgrounded" && notice.update.task_id === item.task_id).update });
      if (item.task_id === "task-a") assert.deepEqual(item.observations.completed, { method: "_x.ai/session_notification",
        payload: notices.find(notice => notice.update.sessionUpdate === "task_completed").update });
      else assert.equal("completed" in item.observations, false);
    }
    const completion = result.records.find(item => item.type === "elicitation_completion");
    assert.equal(completion.method, "_x.ai/mcp/elicit_complete");
    assert.deepEqual(completion.payload, current.traces().find(item => item.kind === "elicitation_native_notice").payload);
    assert.equal(contentText(result), "Root completed with task-b still backgrounded.");
  } finally { await clean(current, mcp); }
});

test("native interaction closure settles exact attention and reverse RPCs, not the root turn or other decisions", { timeout: 30_000 }, async () => {
  const current = fixture();
  current.env.GROKPAIR_THIN_INTERACTION_RESOLVE_GATE = join(current.root, "resolve-interactions");
  current.env.GROKPAIR_THIN_INTERACTION_FINISH_GATE = join(current.root, "finish-interactions");
  const mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:interaction-resolved");
    const before = await until(() => read(mcp, agentId), value => value.attention.length === 3, "three reverse requests");
    assert.equal(before.counts.pending_attention, 3);
    writeFileSync(current.env.GROKPAIR_THIN_INTERACTION_RESOLVE_GATE, "release");
    const ended = await until(() => read(mcp, agentId), value => value.attention.length === 5 && value.counts.pending_attention === 2, "exact interaction closures");
    const expired = ended.attention.filter(item => item.status === "expired");
    assert.equal(expired.length, 3);
    assert.ok(expired.every(item => item.reason === "interaction_resolved" && item.source === "native_interaction_resolved" && item.expired_at));
    for (const previous of before.attention.slice(0, 2)) {
      const currentRecord = ended.attention.find(item => item.request_id === previous.request_id);
      assert.deepEqual(currentRecord.payload, previous.payload);
    }
    await until(async () => current.traces(), values => values.filter(item => item.kind === "independent_attention_rejected").length === 3, "reverse RPCs rejected, not fabricated answers");
    assert.equal(current.traces().filter(item => item.kind === "independent_attention_response").length, 0);
    assert.equal(ended.operations[0].status, "started");
    assert.equal(current.traces().some(item => item.kind === "cancel"), false);
    const stale = expired.find(item => item.payload.toolCallId === "ended-elicitation");
    const refused = await mcp.call("grok_respond", { agent_id: agentId, request_id: stale.request_id, response: { outcome: "cancel" } }, true);
    assert.equal(refused.error.admission, "none");
    for (const pending of ended.attention.filter(item => item.status === "pending")) {
      await mcp.call("grok_respond", { agent_id: agentId, request_id: pending.request_id, response: { outcome: "abandoned" } });
    }
    await until(() => read(mcp, agentId), value => value.counts.pending_attention === 0, "remaining choices answered");
    writeFileSync(current.env.GROKPAIR_THIN_INTERACTION_FINISH_GATE, "release");
    const completed = await done(mcp, agentId);
    assert.equal(contentText(completed), "Root continues after the interactions ended.");
    await mcp.call("grok_send", { agent_id: agentId, task: "THIN:echo:Useful next work." });
    const next = await until(() => read(mcp, agentId), value => value.status === "idle" && contentText(value).includes("Useful next work."), "same session usable");
    assert.equal(next.counts.pending_attention, 0);
    assert.equal(current.traces().filter(item => item.kind === "new_session").length, 1);
  } finally { await clean(current, mcp); }
});

test("native image-exclusion warnings remain exact issues alongside successful root text", { timeout: 25_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:image-dropped"), result = await done(mcp, agentId);
    const issues = result.issues.filter(item => item.code === "native_image_dropped");
    const notices = current.traces().filter(item => item.kind === "image_dropped_notice");
    assert.equal(issues.length, 3);
    for (const [index, issue] of issues.entries()) {
      assert.equal(issue.method, "_x.ai/session_notification");
      assert.deepEqual(issue.payload, notices[index].payload);
      assert.equal(issue.message, notices[index].payload.update.notes.join("\n"));
    }
    assert.equal(contentText(result), "Root text returned after native image exclusion.");
    const filtered = await read(mcp, agentId, { prompt_id: result.operations[0].native_prompt_id });
    assert.equal(filtered.issues.filter(item => item.code === "native_image_dropped").length, 0, "unscoped warnings need unfiltered read");
  } finally { await clean(current, mcp); }
});

test("real native enum diagnostic envelopes survive the complete MCP-worker-ACP path", { timeout: 25_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:native-enum-errors"), result = await done(mcp, agentId);
    const errors = result.issues.filter(item => item.code === "native_tool_failed");
    assert.deepEqual(errors.map(item => [item.tool_call_id, item.message, item.diagnostic_source]), [
      ["mcp-error", "Authentication expired", "rawOutput.output.Error"],
      ["todo-error", "Missing required field: todos", "rawOutput.InvalidArgument"],
      ["read-error", "File not found: /tmp/example", "rawOutput.FileNotFound"],
    ]);
    assert.equal(contentText(result), "Native diagnostic envelopes preserved.");
  } finally { await clean(current, mcp); }
});

test("close without a read receipt cancels active work and preserves known result", { timeout: 30_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:hold");
    // Observe the independent fixture, not grok_read/grok_wait delivery.
    await until(async () => current.traces(), value => value.some(item => item.kind === "prompt_started"), "native hold admission");
    await pause(100);
    await mcp.call("grok_close", { agent_id: agentId });
    const result = await until(() => read(mcp, agentId), value => value.status === "closed", "close completion");
    assert.equal(contentText(result), "Before cancellation.");
    const listed = await mcp.call("grok_list", { include_closed: true });
    assert.ok(listed.agents.some(item => item.agent_id === agentId && item.status === "closed"));
    assert.equal((await mcp.call("grok_list", {})).agents.some(item => item.agent_id === agentId), false, "open collaborators only by default");
    current.agents.delete(agentId);
  } finally { await clean(current, mcp); }
});

for (const phase of ["initialize", "session"]) test(`close during ${phase} response owns shutdown until delayed provider exit`, { timeout: 25_000 }, async () => {
  const current = fixture();
  const responseGate = join(current.root, `${phase}-response-release`), exitGate = join(current.root, "provider-exit-release");
  current.env[`GROKPAIR_THIN_${phase.toUpperCase()}_GATE`] = responseGate;
  current.env.GROKPAIR_THIN_EXIT_GATE = exitGate;
  const mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:echo:Must not dispatch after bootstrap close.");
    await until(async () => current.traces(), value => value.some(item => item.kind === "response_gate_waiting" && item.name === phase), `native ${phase} response held`);
    const original = workerClaim(current, agentId);
    assert.ok(original?.provider, "the exact initialized provider identity is owned before close");
    const admitted = await mcp.call("grok_close", { agent_id: agentId });
    await until(async () => current.traces(), value => value.some(item => item.kind === "exit_gate_waiting")
      && value.some(item => item.kind === "response_gate_aborted" && item.name === phase), "ACP closed while provider exit is held");
    assert.equal(processIdentityStatus(original.provider), "alive");
    // Give the resident loop several opportunities to observe bootstrap's
    // rejected RPC while deliberate close still awaits process completion.
    for (let index = 0; index < 4; index++) {
      const pending = await read(mcp, agentId);
      assert.notEqual(pending.status, "disconnected");
      assert.equal(pending.operations.find(item => item.operation_id === admitted.operation_id).status, "started");
      assert.equal(pending.issues.some(item => ["native_disconnected", "provider_cleanup_incomplete"].includes(item.code)), false);
      await pause(100);
    }
    writeFileSync(exitGate, "allow fixture provider exit");
    const result = await until(() => read(mcp, agentId), value => value.status === "closed", "deliberate bootstrap close completed");
    await until(async () => workerClaim(current, agentId), value => value === null, "worker claim released after close");
    await until(async () => [original.worker, original.provider].map(processIdentityStatus), value => value.every(item => item === "absent"), "exact worker and provider processes absent");
    const close = result.operations.filter(item => item.kind === "close");
    assert.equal(close.length, 1); assert.equal(close[0].operation_id, admitted.operation_id); assert.equal(close[0].status, "completed");
    assert.deepEqual(close[0].result, { native: null, process: { code: 0, signal: null } });
    assert.equal(result.operations.find(item => item.kind === "follow_up").status, "not_sent");
    assert.equal(result.issues.some(item => ["native_disconnected", "provider_cleanup_incomplete", "close_incomplete"].includes(item.code)), false);
    assert.equal(contentText(result), "");
    const events = current.traces();
    assert.equal(events.filter(item => item.kind === "launch").length, 1);
    assert.equal(events.filter(item => item.kind === "new_session").length, phase === "session" ? 1 : 0);
    assert.equal(events.filter(item => item.kind === "close").length, 0, "no confirmed session exists to close natively");
    assert.equal(events.filter(item => item.kind === "connection_closed").length, 1);
    assert.equal(events.filter(item => item.kind === "process_exit").length, 1);
    assert.equal(events.filter(item => item.kind === "prompt_received").length, 0);
    current.agents.delete(agentId);
  } finally {
    writeFileSync(responseGate, "release fixture on assertion failure");
    writeFileSync(exitGate, "release fixture on assertion failure");
    await clean(current, mcp);
  }
});

test("confirmed-session native close rejection remains precise uncertainty after process exit", { timeout: 25_000 }, async () => {
  const current = fixture({ GROKPAIR_THIN_CLOSE_ERROR: "true" }), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:echo:Known result survives close rejection.");
    await done(mcp, agentId);
    const admitted = await mcp.call("grok_close", { agent_id: agentId });
    const result = await until(() => read(mcp, agentId), value => value.status === "closed"
      && value.operations.some(item => item.operation_id === admitted.operation_id && item.status === "outcome_unknown"), "native close rejection retained");
    await until(async () => workerClaim(current, agentId), value => value === null, "close-rejection worker claim released");
    const close = result.operations.find(item => item.operation_id === admitted.operation_id);
    assert.match(close.error.message, /Fixture native close rejection/);
    assert.match(close.result.native_error.message, /Fixture native close rejection/);
    assert.equal(close.result.process.code, 0);
    assert.equal(contentText(result), "Known result survives close rejection.");
    assert.equal(current.traces().filter(item => item.kind === "close").length, 1);
    assert.equal(current.traces().filter(item => item.kind === "prompt_received").length, 1);
    current.agents.delete(agentId);
  } finally { await clean(current, mcp); }
});

for (const phase of ["before", "after"]) test(`native crash ${phase} dispatch: read/wait are passive; explicit resume admits only new input`, { timeout: 40_000 }, async () => {
  const current = fixture();
  if (phase === "before") current.env.GROKPAIR_THIN_CRASH_INITIALIZE_ONCE = join(current.root, "initialize-crashed");
  const mcp = await connect(current);
  try {
    const originalTask = phase === "after" ? "THIN:crash-after" : "THIN:echo:Must never be replayed.";
    const agentId = await spawn(mcp, current, originalTask);
    const failed = await until(() => read(mcp, agentId), value => value.status === "disconnected", "native disconnected");
    const launches = current.traces().filter(item => item.kind === "launch").length;
    for (let index = 0; index < 3; index++) {
      await read(mcp, agentId);
      await mcp.call("grok_wait", { targets: [{ agent_id: agentId }], timeout_ms: 0 });
    }
    assert.equal(current.traces().filter(item => item.kind === "launch").length, launches);
    await mcp.call("grok_send", { agent_id: agentId, task: "THIN:echo:Unauthorized implicit resume." }, true);
    await pause(150);
    await mcp.call("grok_send", { agent_id: agentId, resume: true, task: "THIN:echo:Explicit new input." });
    const resumed = await until(() => read(mcp, agentId), value => value.status === "idle" && contentText(value).includes("Explicit new input."), "explicit new follow-up");
    const prompts = current.traces().filter(item => item.kind === "prompt_received");
    assert.equal(prompts.filter(item => item.text === originalTask).length, phase === "after" ? 1 : 0);
    assert.equal(prompts.filter(item => item.text === "THIN:echo:Explicit new input.").length, 1);
    if (phase === "after") {
      assert.ok(contentText(failed).includes("Retain this uncertain partial text."));
      assert.ok(contentText(resumed).includes("Retain this uncertain partial text."));
      assert.ok(resumed.operations.some(item => item.status === "outcome_unknown"));
      assert.equal(new Set(prompts.map(item => item.session_id)).size, 1);
    }
  } finally { await clean(current, mcp); }
});

test("worker crash cannot resume while its exact original provider survives; new work never replays old input", { timeout: 40_000 }, async () => {
  const current = fixture(), mcp = await connect(current); let original;
  try {
    const agentId = await spawn(mcp, current, "THIN:orphan");
    await until(async () => current.traces(), value => value.some(item => item.kind === "hold_ready"), "orphan provider ready");
    original = workerClaim(current, agentId);
    assert.ok(original?.provider); assert.equal(processIdentityStatus(original.provider), "alive");
    signalProcess(original.worker, "SIGKILL");
    await until(async () => processIdentityStatus(original.worker), value => value === "absent", "original worker gone");
    assert.equal(processIdentityStatus(original.provider), "alive", "fixture deliberately outlives ACP disconnect");
    const launches = current.traces().filter(item => item.kind === "launch").length;
    for (let index = 0; index < 3; index++) {
      await read(mcp, agentId);
      await mcp.call("grok_wait", { targets: [{ agent_id: agentId }], timeout_ms: 0 });
    }
    await mcp.call("grok_send", { agent_id: agentId, task: "THIN:echo:Not permitted while original provider lives.", resume: true }, true);
    assert.equal(current.traces().filter(item => item.kind === "launch").length, launches);
    signalProcess(original.provider, "SIGTERM");
    await until(async () => processIdentityStatus(original.provider), value => value === "absent", "original provider gone");
    await mcp.call("grok_send", { agent_id: agentId, task: "THIN:echo:New explicit work only.", resume: true });
    const result = await until(() => read(mcp, agentId), value => value.status === "idle" && contentText(value).includes("New explicit work only."), "worker successor new input");
    assert.equal(current.traces().filter(item => item.kind === "prompt_received" && item.text === "THIN:orphan").length, 1);
    assert.ok(result.operations.some(item => item.status === "outcome_unknown"));
    assert.ok(result.turns.some(item => item.status === "unknown"));
    assert.equal(contentText(result), "Before cancellation.New explicit work only.");
  } finally {
    if (original?.provider && processIdentityStatus(original.provider) === "alive") signalProcess(original.provider, "SIGTERM");
    await clean(current, mcp);
  }
});

test("definitive native spawn failure clears non-launch custody and permits explicit new work without replay", { timeout: 30_000 }, async () => {
  const current = fixture(), path = current.env.PATH;
  current.env.PATH = "/nonexistent-grokpair-test-executable-path";
  let mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:echo:Never sent to a missing executable.");
    const failed = await until(() => read(mcp, agentId), value => value.status === "disconnected", "definitive spawn failure");
    assert.equal(failed.operations[0].status, "not_sent");
    assert.deepEqual(failed.operations[0].effects.prompt, { status: "not_sent" });
    assert.equal(current.traces().length, 0);
    await until(async () => workerClaim(current, agentId), value => value === null, "definitive non-launch releases exact worker custody");
    await mcp.close(); current.env.PATH = path; mcp = await connect(current);
    await mcp.call("grok_send", { agent_id: agentId, resume: true, task: "THIN:echo:New input after definite non-launch." });
    const result = await until(() => read(mcp, agentId), value => value.status === "idle" && contentText(value) === "New input after definite non-launch.", "new work after non-launch");
    assert.equal(result.operations.filter(item => item.kind === "follow_up").length, 2);
    assert.equal(current.traces().filter(item => item.kind === "prompt_received").length, 1);
  } finally { await clean(current, mcp); }
});

test("a server whose Node executable an upgrade removed launches workers with the node now on its PATH", { timeout: 30_000 }, async () => {
  const current = fixture(), stable = join(current.root, "opt", "node", "bin"); mkdirSync(stable, { recursive: true });
  symlinkSync(process.execPath, join(stable, "node"));
  current.env.PATH = `${join(current.root, "bin")}:${stable}`;
  const mcp = await connect(current, { removedNode: join(current.root, "Cellar", "node", "24.0.0", "bin", "node") });
  try {
    const admitted = await mcp.call("grok_spawn", { task: "THIN:echo:Launched after the upgrade.", cwd: current.cwd });
    assert.equal(admitted.call_status, "admitted");
    assert.equal(contentText(await done(mcp, admitted.agent_id)), "Launched after the upgrade.");
    const { worker } = await until(async () => workerClaim(current, admitted.agent_id), claim => claim?.worker, "resident worker claim");
    const command = spawnSync("/bin/ps", ["-p", String(worker.pid), "-ww", "-o", "args="], { encoding: "utf8" }).stdout.trim();
    assert.ok(command.startsWith(`${join(stable, "node")} `), command);
  } finally { await clean(current, mcp); }
});

test("a server with neither its Node executable nor node on its PATH refuses spawn and resume before admission", { timeout: 40_000 }, async () => {
  const current = fixture(), removedNode = join(current.root, "Cellar", "node", "24.0.0", "bin", "node"), key = "stale-node-spawn", held = "held-by-crashed";
  const mcp = await connect(current); let stale;
  try {
    const crashed = (await mcp.call("grok_spawn", { task: "THIN:crash-after", cwd: current.cwd, key: held })).agent_id;
    await until(() => read(mcp, crashed), value => value.status === "disconnected", "crashed before resume");
    await until(async () => workerClaim(current, crashed), value => value === null, "prior resident released");
    // Relative PATH entries would find a node in the collaborator's directory; they are not searched.
    const planted = join(current.cwd, "node"); writeFileSync(planted, "#!/bin/sh\nexit 0\n"); chmodSync(planted, 0o755);
    stale = await connect({ ...current, env: { ...current.env, PATH: `:.:${join(current.root, "bin")}` } }, { removedNode });
    const agents = join(current.root, "runtime", "runtime-v2", "agents"), before = readdirSync(agents);
    const refused = await stale.call("grok_spawn", { task: "THIN:echo:Never launched.", cwd: current.cwd, key }, true);
    assert.equal(refused.error.code, "worker_unavailable"); assert.equal(refused.error.admission, "none");
    assert.equal(Object.hasOwn(refused.error, "agent_id"), false); assert.equal(Object.hasOwn(refused.error, "operation_id"), false);
    assert.ok(refused.error.message.includes(removedNode)); assert.match(refused.error.action, /node on the PATH/);
    assert.deepEqual(readdirSync(agents), before);
    assert.deepEqual((await stale.call("grok_list", { key, include_closed: true })).agents, []);
    // The identical initial request returns its holder without needing a worker.
    const existing = await stale.call("grok_spawn", { task: "THIN:crash-after", cwd: current.cwd, key: held });
    assert.equal(existing.call_status, "existing"); assert.equal(existing.agent_id, crashed);
    const resume = await stale.call("grok_send", { agent_id: crashed, resume: true, task: "THIN:echo:Not by this server." }, true);
    assert.equal(resume.error.code, "worker_unavailable"); assert.equal(resume.error.admission, "none");
    assert.equal(Object.hasOwn(resume.error, "operation_id"), false);
    assert.equal(current.traces().filter(item => item.kind === "launch").length, 1);
    // Nothing was admitted, so a server that can launch still resumes it.
    await mcp.call("grok_send", { agent_id: crashed, resume: true, task: "THIN:echo:Resumed by a launching server." });
    const result = await until(() => read(mcp, crashed), value => value.status !== "starting" && contentText(value).includes("Resumed by a launching server."), "resumed");
    assert.equal(result.operations.filter(item => item.kind === "follow_up").length, 2);
  } finally { await stale?.close(); await clean(current, mcp); }
});

test("an unsupported replacement Node refuses spawn and resume before admission without blocking retained reads", { timeout: 30_000 }, async () => {
  const current = fixture(), mcp = await connect(current); let stale;
  const replacement = join(current.root, "replacement"); mkdirSync(replacement);
  const node = join(replacement, "node"), launches = join(current.root, "unexpected-node-launch");
  try {
    const crashed = (await mcp.call("grok_spawn", { task: "THIN:crash-after", cwd: current.cwd })).agent_id;
    await until(() => read(mcp, crashed), value => value.status === "disconnected", "crashed before replacement checks");
    await until(async () => workerClaim(current, crashed), value => value === null, "prior resident released");
    stale = await connect({ ...current, env: { ...current.env, PATH: replacement } }, { removedNode: join(current.root, "removed-node") });
    const agents = join(current.root, "runtime", "runtime-v2", "agents"), before = readdirSync(agents);
    for (const version of ["v24.22.0", "v26.0.0", "v26.12.0", "v26.12.1", "not-node"]) {
      writeFileSync(node, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' ${quote(version)}; exit 0; fi\nprintf 'unexpected launch\\n' >> ${quote(launches)}\nexit 42\n`);
      chmodSync(node, 0o755);
      const key = `unsupported-${version}`;
      const refused = await stale.call("grok_spawn", { task: "Never admitted.", cwd: current.cwd, key }, true);
      assert.equal(refused.error.code, "worker_unavailable"); assert.equal(refused.error.admission, "none");
      assert.equal(Object.hasOwn(refused.error, "agent_id"), false); assert.equal(Object.hasOwn(refused.error, "operation_id"), false);
      assert.deepEqual(readdirSync(agents), before);
      assert.deepEqual((await stale.call("grok_list", { key, include_closed: true })).agents, []);
      const resume = await stale.call("grok_send", { agent_id: crashed, resume: true, task: "Never resumed." }, true);
      assert.equal(resume.error.code, "worker_unavailable"); assert.equal(resume.error.admission, "none");
      assert.equal(Object.hasOwn(resume.error, "operation_id"), false);
      const retained = await read(stale, crashed);
      assert.equal(retained.operations.filter(operation => operation.kind === "follow_up").length, 1);
    }
    assert.equal(existsSync(launches), false);
    assert.equal(current.traces().filter(item => item.kind === "launch").length, 1);
  } finally { await stale?.close(); await clean(current, mcp); }
});

test("a server whose own package an update removed refuses spawn before admission", { timeout: 30_000 }, async () => {
  const current = fixture(), copy = join(current.root, "plugin", "2.0.0", "lib", "grokpair.js");
  mkdirSync(dirname(copy), { recursive: true }); copyFileSync(entrypoint, copy);
  const mcp = await connect(current, { entry: copy });
  try {
    rmSync(copy);
    const refused = await mcp.call("grok_spawn", { task: "THIN:echo:Never launched.", cwd: current.cwd }, true);
    assert.equal(refused.error.code, "worker_unavailable"); assert.equal(refused.error.admission, "none");
    assert.equal(Object.hasOwn(refused.error, "agent_id"), false); assert.equal(Object.hasOwn(refused.error, "operation_id"), false);
    assert.ok(refused.error.message.includes(copy)); assert.match(refused.error.action, /new session/);
    assert.deepEqual((await mcp.call("grok_list", { include_closed: true })).agents, []);
    assert.equal(current.traces().length, 0);
  } finally { await clean(current, mcp); }
});

for (const sandbox of [undefined, "read-only", " custom profile "]) test(`ordinary non-Git cwd executes there with ${sandbox === undefined ? "omitted" : "exact explicit"} sandbox selection ${JSON.stringify(sandbox)}`, { timeout: 30_000 }, async () => {
  const current = fixture({ GROK_SANDBOX: "inherited-native-selection" }), mcp = await connect(current);
  try {
    writeFileSync(join(current.cwd, "tracked.txt"), "ordinary input\n");
    const input = { task: "THIN:write-result", cwd: current.cwd, ...(sandbox === undefined ? {} : { sandbox }) };
    const admitted = await mcp.call("grok_spawn", input), result = await done(mcp, admitted.agent_id);
    assert.equal(result.cwd, current.cwd); assert.equal(result.execution_cwd, current.cwd); assert.equal(result.worktree, false);
    assert.equal(result.worktree_root, null); assert.equal(result.sandbox_argument, sandbox ?? null);
    assert.equal(result.sandbox_observation.status, "unavailable");
    assert.equal(Object.hasOwn(result, "workspace"), false); assert.equal(Object.hasOwn(result, "candidate"), false);
    const launch = current.traces().find(item => item.kind === "launch");
    assert.deepEqual(launch.argv, ["--cwd", current.cwd, ...(sandbox === undefined ? [] : ["--sandbox", sandbox]), "agent", "--no-leader", "stdio"]);
    assert.equal(launch.sandbox_environment, "inherited-native-selection");
    assert.equal(current.traces().find(item => item.kind === "new_session").params.cwd, current.cwd);
    assert.equal(current.traces().filter(item => item.kind === "worktree_launch").length, 0);
    assert.equal(readFileSync(join(current.cwd, "result.txt"), "utf8"), "Useful collaborator result.\n");
    const guidance = current.traces().find(item => item.kind === "prompt_received").params.prompt[1].text;
    assert.doesNotMatch(guidance, /readonly|read-only|outside.*(?:cwd|workspace)|must not (?:write|edit)/i);
    assert.match(guidance, /delegated by another agent/);
    assert.match(guidance, /Return your answer and files to that calling agent/);
    assert.match(guidance, /Do not send messages, contact people or publish unless this brief explicitly delegates that effect and destination/);
    const turn = (await readPage(mcp, admitted.agent_id)).turns[0];
    const finished = readFileSync(turn.text_file, "utf8");
    assert.ok(finished.includes(`cwd: ${JSON.stringify(current.cwd)}`));
    assert.ok(finished.includes(`execution_cwd: ${JSON.stringify(current.cwd)}`));
    assert.ok(finished.includes(`sandbox_argument: ${JSON.stringify(sandbox ?? null)}`));
  } finally { await clean(current, mcp); }
});

test("native worktree creation carries dirty input and source-relative cwd without editing the source checkout", { timeout: 30_000 }, async () => {
  const current = fixture(), nested = join(current.cwd, "packages", "web"); mkdirSync(nested, { recursive: true });
  git(current.cwd, "init", "--quiet");
  writeFileSync(join(nested, "tracked.txt"), "base\n"); writeFileSync(join(current.cwd, ".gitignore"), "ignored.txt\n");
  git(current.cwd, "add", "."); git(current.cwd, "commit", "--quiet", "-m", "Disposable integration fixture");
  writeFileSync(join(nested, "tracked.txt"), "staged\n"); git(current.cwd, "add", ".");
  writeFileSync(join(nested, "tracked.txt"), "dirty\n");
  writeFileSync(join(nested, "ignored.txt"), "keep ignored"); writeFileSync(join(nested, "untracked.txt"), "native fixture copies this untracked input");
  const before = git(current.cwd, "status", "--porcelain=v1", "--ignored"), index = readFileSync(join(current.cwd, ".git/index"));
  const mcp = await connect(current);
  try {
    const admitted = await mcp.call("grok_spawn", { task: "THIN:write-result", cwd: nested, worktree: true, sandbox: "custom-edit" });
    const agentId = admitted.agent_id, result = await done(mcp, agentId), execution = result.execution_cwd, tree = result.worktree_root;
    assert.equal(result.cwd, nested); assert.equal(result.worktree, true); assert.equal(result.sandbox_argument, "custom-edit");
    assert.notEqual(tree, current.cwd); assert.equal(execution, join(tree, "packages", "web"));
    assert.equal(result.sandbox_observation.status, "unavailable"); assert.equal(Object.hasOwn(result, "candidate"), false);
    const utility = current.traces().find(item => item.kind === "worktree_launch"), launch = current.traces().find(item => item.kind === "launch");
    assert.deepEqual(utility.argv, ["--cwd", nested, "--sandbox", "custom-edit", "worktree", "create"]);
    assert.deepEqual(launch.argv, ["--cwd", execution, "--sandbox", "custom-edit", "agent", "--no-leader", "stdio"]);
    assert.equal(launch.cwd, execution); assert.equal(current.traces().find(item => item.kind === "new_session").params.cwd, execution);
    assert.equal(current.traces().find(item => item.kind === "source_before_edit").source, "dirty\n");
    assert.equal(readFileSync(join(execution, "untracked.txt"), "utf8"), "native fixture copies this untracked input");
    assert.equal(readFileSync(join(execution, "tracked.txt"), "utf8"), "collaborator implementation\n");
    assert.ok(result.files.some(item => item.source === "native" && item.path === join(execution, "result.txt")));
    assert.equal(git(current.cwd, "status", "--porcelain=v1", "--ignored"), before); assert.deepEqual(readFileSync(join(current.cwd, ".git/index")), index);
    assert.equal(readFileSync(join(nested, "tracked.txt"), "utf8"), "dirty\n"); assert.equal(readFileSync(join(nested, "ignored.txt"), "utf8"), "keep ignored");
    assert.equal(existsSync(join(nested, "result.txt")), false);
    const guidance = current.traces().find(item => item.kind === "prompt_received").params.prompt[1].text;
    assert.ok(guidance.includes(nested)); assert.ok(guidance.includes(execution));
    await mcp.call("grok_send", { agent_id: agentId, task: "THIN:echo:Same isolated directory." }); await done(mcp, agentId);
    assert.equal(current.traces().filter(item => item.kind === "worktree_created").length, 1);
    await mcp.call("grok_close", { agent_id: agentId });
    await until(() => read(mcp, agentId), value => value.status === "closed", "isolated close");
    assert.equal(readFileSync(join(execution, "result.txt"), "utf8"), "Useful collaborator result.\n"); current.agents.delete(agentId);
  } finally { await clean(current, mcp); }
});

function initWorktreeSource(current) {
  git(current.cwd, "init", "--quiet"); writeFileSync(join(current.cwd, "tracked.txt"), "base\n");
  git(current.cwd, "add", "."); git(current.cwd, "commit", "--quiet", "-m", "Disposable native provisioning source");
}
for (const mode of ["refuse", "root-fallback", "lost-output"]) test(`native worktree ${mode} preserves failure custody without launching in the source or blindly provisioning again`, { timeout: 30_000 }, async () => {
  const current = fixture({ GROKPAIR_THIN_WORKTREE_MODE: mode }); initWorktreeSource(current);
  const nested = join(current.cwd, "empty-subdirectory"); mkdirSync(nested);
  const cwd = mode === "root-fallback" ? nested : current.cwd, mcp = await connect(current);
  try {
    const input = { task: "THIN:echo:Must never run.", cwd, worktree: true, sandbox: "restricted-custom", key: `failure-${mode}` };
    const admitted = await mcp.call("grok_spawn", input), agentId = admitted.agent_id;
    const failed = await until(() => read(mcp, agentId), value => value.status === "disconnected", "native worktree failure");
    assert.equal(failed.execution_cwd, null); assert.equal(failed.cwd, cwd); assert.equal(failed.sandbox_argument, "restricted-custom");
    assert.equal(current.traces().filter(item => item.kind === "worktree_launch").length, 1);
    assert.equal(current.traces().filter(item => item.kind === "launch").length, 0);
    assert.equal(current.traces().filter(item => item.kind === "prompt_received").length, 0);
    assert.ok(["failed", "outcome_unknown"].includes(failed.provisioning.status), JSON.stringify(failed.provisioning));
    if (mode === "refuse") assert.match(JSON.stringify(failed), /Fixture native provisioning refused/);
    if (mode === "lost-output") assert.equal(failed.provisioning.status, "outcome_unknown");
    const retained = await mcp.call("grok_spawn", input);
    assert.equal(retained.call_status, "existing"); assert.equal(retained.agent_id, agentId);
    const conflict = await mcp.call("grok_spawn", { ...input, sandbox: "off" }, true);
    assert.equal(conflict.error.code, "spawn_key_conflict"); assert.equal(conflict.error.details.agent_id, agentId);
    assert.equal(current.traces().filter(item => item.kind === "worktree_launch").length, 1);
    const created = current.traces().find(item => item.kind === "worktree_created");
    if (created) assert.ok(existsSync(created.root), "failed provisioning never deletes a native result to imitate rollback");
  } finally { await clean(current, mcp); }
});

test("resident close retains unknown provisioner custody and its spawn key after the utility exits", { timeout: 30_000 }, async () => {
  const current = fixture(); initWorktreeSource(current);
  current.env.GROKPAIR_THIN_WORKTREE_GATE = join(current.root, "release-provisioner");
  const mcp = await connect(current); let original, agentId;
  try {
    const input = { task: "THIN:echo:Must not be sent.", cwd: current.cwd, worktree: true, key: "unknown-provisioner" };
    const admitted = await mcp.call("grok_spawn", input); agentId = admitted.agent_id;
    await until(() => read(mcp, agentId), value => value.provisioning?.status === "running" && typeof value.provisioning.returned_cwd === "string", "resident provisioning gate");
    original = workerClaim(current, agentId);
    assert.equal(processIdentityStatus(original.worker), "alive"); assert.equal(processIdentityStatus(original.provisioner), "alive");
    // Fault-inject the durable state left when launch intent commits but the
    // child's identity cannot be observed. The real resident close aborts the
    // fixture utility; its exit callback then rejects unknown absence custody.
    const db = new DatabaseSync(join(current.root, "runtime", "runtime-v2", "agents", agentId, "agent.sqlite"));
    try {
      db.exec("BEGIN IMMEDIATE");
      const claim = JSON.parse(db.prepare("SELECT value FROM state WHERE key='worker'").get().value);
      db.prepare("UPDATE state SET value=? WHERE key='worker'").run(JSON.stringify({ ...claim, provisioner: null, provisioner_state: "launching" }));
      const meta = JSON.parse(db.prepare("SELECT value FROM state WHERE key='meta'").get().value);
      const { process: _, ...provisioning } = meta.provisioning;
      db.prepare("UPDATE state SET value=? WHERE key='meta'").run(JSON.stringify({ ...meta, provisioning: { ...provisioning, status: "starting" } }));
      db.exec("COMMIT");
    } finally { db.close(); }
    const closing = await mcp.call("grok_close", { agent_id: agentId });
    const result = await until(() => read(mcp, agentId), value => value.operations.some(item => item.operation_id === closing.operation_id && !["admitted", "started"].includes(item.status)), "resident close settled");
    await until(async () => [original.worker, original.provisioner].map(processIdentityStatus), value => value.every(item => item === "absent"), "fixture worker and provisioner exited");
    assert.equal(result.status, "disconnected");
    const close = result.operations.find(item => item.operation_id === closing.operation_id);
    assert.equal(close.status, "outcome_unknown"); assert.match(close.error.message, /provisioner identity is unknown/i);
    assert.equal(result.provisioning.status, "outcome_unknown"); assert.ok(existsSync(result.provisioning.returned_cwd));
    assert.equal(result.execution_cwd, null); assert.equal(storedState(current, agentId, "meta").phase, "disconnected");
    assert.equal(workerClaim(current, agentId).provisioner_state, "launching"); assert.equal(workerClaim(current, agentId).provisioner, null);
    const retained = await mcp.call("grok_spawn", input);
    assert.equal(retained.call_status, "existing"); assert.equal(retained.agent_id, agentId);
    const deniedClose = await mcp.call("grok_close", { agent_id: agentId }, true);
    assert.match(deniedClose.error.message, /provisioner identity is unknown/i);
    assert.equal(current.traces().filter(item => item.kind === "worktree_launch").length, 1);
    assert.equal(current.traces().filter(item => item.kind === "launch").length, 0);
  } finally {
    writeFileSync(current.env.GROKPAIR_THIN_WORKTREE_GATE, "release fixture on assertion failure");
    if (original?.provisioner && processIdentityStatus(original.provisioner) === "alive") signalProcess(original.provisioner, "SIGTERM");
    if (original && processIdentityStatus(original.worker) === "alive") {
      try { await mcp.call("grok_close", { agent_id: agentId }); } catch {}
    }
    if (original) await until(async () => [original.worker, original.provisioner].map(processIdentityStatus), value => value.every(item => item === "absent"), "fault-injection processes ended");
    if (agentId) current.agents.delete(agentId);
    await clean(current, mcp);
  }
});

test("worker death during native provisioning preserves exact live utility custody and close durably records uncertainty", { timeout: 40_000 }, async () => {
  const current = fixture(); initWorktreeSource(current);
  current.env.GROKPAIR_THIN_WORKTREE_GATE = join(current.root, "release-provisioner");
  const mcp = await connect(current); let original;
  try {
    const admitted = await mcp.call("grok_spawn", { task: "THIN:echo:Must not be sent.", cwd: current.cwd, worktree: true });
    const agentId = admitted.agent_id;
    await until(() => read(mcp, agentId), value => value.provisioning?.status === "running" && typeof value.provisioning.returned_cwd === "string", "native provisioner waiting after returning directory");
    original = workerClaim(current, agentId);
    assert.ok(original.provisioner); assert.equal(processIdentityStatus(original.provisioner), "alive"); assert.equal(original.provider, null);
    signalProcess(original.worker, "SIGKILL");
    await until(async () => processIdentityStatus(original.worker), value => value === "absent", "provisioning worker absent");
    assert.equal(processIdentityStatus(original.provisioner), "alive", "native utility survives its worker and retains custody");
    const before = storedState(current, agentId, "meta");
    const observed = await read(mcp, agentId);
    assert.equal(observed.status, "disconnected"); assert.equal(observed.provisioning.status, "outcome_unknown");
    assert.deepEqual(storedState(current, agentId, "meta"), before, "passive read does not claim a durable provisioning outcome");
    await mcp.call("grok_send", { agent_id: agentId, task: "THIN:echo:Cannot resume over live utility.", resume: true }, true);
    const deniedClose = await mcp.call("grok_close", { agent_id: agentId }, true);
    assert.match(JSON.stringify(deniedClose.error), /provisioner absence/i);
    assert.equal(current.traces().filter(item => item.kind === "worktree_launch").length, 1);
    assert.equal(current.traces().filter(item => item.kind === "launch").length, 0);
    signalProcess(original.provisioner, "SIGTERM");
    await until(async () => processIdentityStatus(original.provisioner), value => value === "absent", "native provisioner absent");
    const absent = await read(mcp, agentId);
    assert.equal(absent.provisioning.status, "outcome_unknown"); assert.equal(storedState(current, agentId, "meta").provisioning.status, "running");
    await mcp.call("grok_close", { agent_id: agentId });
    const closed = await until(() => read(mcp, agentId), value => value.status === "closed", "retired provisioning collaborator");
    assert.equal(closed.provisioning.status, "outcome_unknown");
    assert.equal(storedState(current, agentId, "meta").provisioning.status, "outcome_unknown");
    assert.equal(closed.execution_cwd, null); assert.ok(existsSync(closed.provisioning.returned_cwd));
    assert.equal(current.traces().filter(item => item.kind === "worktree_created").length, 1); current.agents.delete(agentId);
  } finally {
    if (original?.provisioner && processIdentityStatus(original.provisioner) === "alive") signalProcess(original.provisioner, "SIGTERM");
    await clean(current, mcp);
  }
});

for (const startupFailure of [false, true]) test(`successful provisioning discards stderr even when later ACP startup ${startupFailure ? "fails" : "succeeds"}`, { timeout: 30_000 }, async () => {
  const marker = "SUCCESSFUL PROVISIONER STDERR MUST NOT BE RETAINED";
  const current = fixture({ GROKPAIR_THIN_WORKTREE_STDERR: marker, GROKPAIR_THIN_STARTUP_FAILURE: String(startupFailure) }); initWorktreeSource(current);
  const mcp = await connect(current);
  try {
    const admitted = await mcp.call("grok_spawn", { task: "THIN:echo:Provisioned contribution.", cwd: current.cwd, worktree: true });
    const result = startupFailure
      ? await until(() => read(mcp, admitted.agent_id), value => value.status === "disconnected", "ACP startup failure after successful provisioning")
      : await done(mcp, admitted.agent_id);
    assert.equal(result.provisioning.status, "completed"); assert.deepEqual(result.provisioning.exit, { code: 0, signal: null });
    assert.equal(JSON.stringify(result).includes(marker), false);
    assert.equal(JSON.stringify(storedState(current, admitted.agent_id, "meta")).includes(marker), false);
    if (startupFailure) {
      assert.equal(result.counts.pending_operations, 0, "disconnected startup failure carries its settled operation and diagnostic");
      assert.match(JSON.stringify(result), /Fixture native custom profile is unavailable/);
    }
  } finally { await clean(current, mcp); }
});

test("native startup failure retains the provisioned path, exact stderr and native exit with no profile fallback", { timeout: 30_000 }, async () => {
  const current = fixture({ GROKPAIR_THIN_STARTUP_FAILURE: "true" }); initWorktreeSource(current);
  const mcp = await connect(current);
  try {
    const admitted = await mcp.call("grok_spawn", { task: "THIN:echo:Must never run.", cwd: current.cwd, worktree: true });
    const result = await until(() => read(mcp, admitted.agent_id), value => value.status === "disconnected", "native startup rejected profile");
    assert.equal(result.counts.pending_operations, 0, "disconnected startup failure is not a premature process-exit observation");
    const created = current.traces().find(item => item.kind === "worktree_created");
    assert.equal(result.worktree_root, created.root); assert.ok(existsSync(created.root)); assert.equal(result.provisioning.returned_cwd, created.execution);
    assert.match(JSON.stringify(result), /Fixture native custom profile is unavailable/);
    assert.match(JSON.stringify(result), /23/);
    for (const launch of current.traces().filter(item => ["worktree_launch", "launch"].includes(item.kind))) assert.equal(launch.argv.includes("--sandbox"), false);
    assert.equal(current.traces().filter(item => item.kind === "launch").length, 1); assert.equal(current.traces().filter(item => item.kind === "worktree_created").length, 1);
  } finally { await clean(current, mcp); }
});

for (const sandbox of [undefined, "custom-resume"]) test(`explicit resume reuses native worktree and ${sandbox === undefined ? "omitted" : "explicit"} sandbox instead of reprovisioning`, { timeout: 40_000 }, async () => {
  const current = fixture(); initWorktreeSource(current); const mcp = await connect(current);
  try {
    const admitted = await mcp.call("grok_spawn", { task: "THIN:crash-after", cwd: current.cwd, worktree: true, ...(sandbox === undefined ? {} : { sandbox }) });
    const failed = await until(() => read(mcp, admitted.agent_id), value => value.status === "disconnected", "isolated native crash");
    await until(async () => workerClaim(current, admitted.agent_id), claim => !claim || [claim.worker, claim.provider].filter(Boolean).every(identity => processIdentityStatus(identity) === "absent"), "predecessor processes absent");
    await mcp.call("grok_send", { agent_id: admitted.agent_id, resume: true, task: "THIN:echo:Explicit isolated follow-up." });
    const result = await done(mcp, admitted.agent_id);
    assert.equal(result.execution_cwd, failed.execution_cwd); assert.equal(result.worktree_root, failed.worktree_root);
    assert.equal(result.cwd, current.cwd); assert.equal(result.sandbox_argument, sandbox ?? null);
    assert.equal(current.traces().filter(item => item.kind === "worktree_created").length, 1);
    const launches = current.traces().filter(item => item.kind === "launch"); assert.equal(launches.length, 2); assert.deepEqual(launches[0].argv, launches[1].argv);
    assert.equal(current.traces().find(item => item.kind === "resume_session").params.cwd, failed.execution_cwd);
    assert.ok(contentText(result).includes("Explicit isolated follow-up."));
  } finally { await clean(current, mcp); }
});

test("explicit resume refuses a missing native tree without recreating it or falling back to source", { timeout: 40_000 }, async () => {
  const current = fixture(); initWorktreeSource(current); const mcp = await connect(current); let original, moved;
  try {
    const admitted = await mcp.call("grok_spawn", { task: "THIN:crash-after", cwd: current.cwd, worktree: true });
    const failed = await until(() => read(mcp, admitted.agent_id), value => value.status === "disconnected", "isolated native crash");
    await until(async () => workerClaim(current, admitted.agent_id), claim => !claim || [claim.worker, claim.provider].filter(Boolean).every(identity => processIdentityStatus(identity) === "absent"), "predecessor processes absent");
    original = failed.worktree_root; moved = original + ".retained"; renameSync(original, moved);
    const response = await mcp.call("grok_send", { agent_id: admitted.agent_id, resume: true, task: "THIN:echo:Do not recreate context." }, true);
    assert.equal(response.error.admission, "none"); assert.match(JSON.stringify(response.error), /missing|unavailable|ENOENT|does not exist/i);
    assert.equal(current.traces().filter(item => item.kind === "worktree_created").length, 1); assert.equal(current.traces().filter(item => item.kind === "launch").length, 1);
    assert.equal(existsSync(original), false); assert.ok(existsSync(moved));
  } finally { if (moved && existsSync(moved)) renameSync(moved, original); await clean(current, mcp); }
});

test("MCP explicit references and images retain the requested native modalities and leave originals unchanged", { timeout: 25_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const inputs = [["note.md", Buffer.from("\ufeff# Exact\r\nOriginal line\r\n")], ["document.pdf", Buffer.from("%PDF-1.7\noriginal fixture\n%%EOF")],
      ["image.png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])]];
    const attachments = inputs.map(([name, bytes], index) => { const path = join(current.root, name); writeFileSync(path, bytes); return { path, kind: index === 2 ? "image" : "reference" }; });
    const admitted = await mcp.call("grok_spawn", { task: "THIN:echo:Attachments arrived.", cwd: current.cwd, attachments });
    const result = await done(mcp, admitted.agent.agent_id);
    assert.equal(contentText(result), "Attachments arrived.");
    const blocks = current.traces().find(item => item.kind === "prompt_received").params.prompt;
    assert.equal(blocks[0].text, "THIN:echo:Attachments arrived."); assert.equal(blocks[1].type, "text");
    assert.equal(blocks.length, 5);
    for (let index = 0; index < inputs.length; index++) {
      const block = blocks[index + 2];
      if (attachments[index].kind === "reference") {
        assert.equal(block.type, "resource_link");
        assert.equal(block.uri, pathToFileURL(attachments[index].path).href);
        assert.equal("resource" in block, false);
      } else {
        assert.equal(block.type, "image");
        assert.deepEqual(Buffer.from(block.data, "base64"), inputs[index][1]);
      }
      assert.deepEqual(readFileSync(attachments[index].path), inputs[index][1]);
    }
  } finally { await clean(current, mcp); }
});

test("native omitted image advertisement does not block exact image bytes or fixture consumption", { timeout: 20_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), path = join(current.root, "image.png"); writeFileSync(path, bytes);
    const admitted = await mcp.call("grok_spawn", { task: "THIN:image-consumption", cwd: current.cwd, attachments: [{ path, kind: "image" }] });
    const result = await done(mcp, admitted.agent.agent_id);
    assert.equal(contentText(result), `Consumed image bytes: ${bytes.toString("hex")}`);
    assert.deepEqual(current.traces().find(item => item.kind === "advertised_prompt_capabilities").promptCapabilities, { embeddedContext: true });
    const consumed = current.traces().find(item => item.kind === "image_consumed");
    assert.deepEqual(Buffer.from(consumed.bytes), bytes); assert.equal(consumed.mime_type, "image/png");
    assert.deepEqual(readFileSync(path), bytes);
  } finally { await clean(current, mcp); }
});

test("an image prompt encoded above 32 MiB reaches the native peer byte-exactly without payload trace duplication", { timeout: 90_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    // The deterministic peer tests transport and original-byte fidelity, not
    // provider image decoding: a recognized PNG signature is sufficient here.
    const bytes = Buffer.alloc(25 * 1024 * 1024, 0x61);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    const path = join(current.root, "large-image.png"); writeFileSync(path, bytes);
    const admitted = await mcp.call("grok_spawn", { task: "THIN:large-image", cwd: current.cwd, attachments: [{ path, kind: "image" }] });
    const result = await done(mcp, admitted.agent_id);
    assert.equal(contentText(result), "Large image bytes received exactly.");
    const consumed = current.traces().find(item => item.kind === "large_image_consumed");
    assert.ok(consumed.encoded_prompt_bytes > 32 * 1024 * 1024, "the one incoming ACP prompt crosses the peer's default frame limit");
    assert.deepEqual([consumed.bytes, consumed.sha256, consumed.mime_type], [bytes.length, sha256(bytes), "image/png"]);
    assert.equal(sha256(readFileSync(path)), sha256(bytes), "the original image was not rewritten or staged");
    const traced = current.traces().find(item => item.kind === "prompt_received").params.prompt.find(block => block.type === "image");
    assert.equal(Object.hasOwn(traced, "data"), false); assert.equal(traced.base64_chars, Math.ceil(bytes.length / 3) * 4);
    assert.ok(readFileSync(join(current.root, "native.jsonl")).length < 100_000, "fixture traces retain counts/digests, not base64 image copies");
    await mcp.call("grok_send", { agent_id: admitted.agent_id, task: "THIN:echo:After the giant image." });
    assert.equal(contentText(await done(mcp, admitted.agent_id)), "Large image bytes received exactly.After the giant image.");
    assert.equal(current.traces().filter(item => item.kind === "new_session").length, 1);
  } finally { await clean(current, mcp); }
});

test("initialize capabilities remain exact evidence and audio files are explicit references, not invented audio blocks", { timeout: 25_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:echo:Capability evidence.");
    const initial = await done(mcp, agentId);
    const native = current.traces().find(item => item.kind === "initialize_returned").result;
    const record = initial.records.find(item => item.type === "native_capabilities");
    assert.deepEqual(record, { type: "native_capabilities", protocol_version: native.protocolVersion,
      agent_info: native.agentInfo, capabilities: native.agentCapabilities });
    assert.equal(Object.hasOwn(record.capabilities.promptCapabilities, "audio"), false);
    assert.equal(record.capabilities._meta["x.ai/capabilities"].toolOverrides.x_user_search, false);
    assert.ok(initial.native_options.length > 0, "capability evidence does not replace model/effort catalog");
    const path = join(current.root, "input.wav"); writeFileSync(path, Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]));
    const admitted = await mcp.call("grok_send", { agent_id: agentId, task: "THIN:echo:Audio reference.", attachments: [{ path, kind: "reference" }] });
    const completed = await until(() => read(mcp, agentId), value => value.operations.find(item => item.operation_id === admitted.operation_id)?.status === "completed", "audio reference accepted");
    const prompt = current.traces().filter(item => item.kind === "prompt_received").at(-1);
    assert.equal(prompt.params.prompt.at(-1).type, "resource_link");
    assert.equal(prompt.params.prompt.at(-1).uri, pathToFileURL(path).href);
    assert.equal(current.traces().filter(item => item.kind === "prompt_received").length, 2);
    assert.deepEqual(completed.records.find(item => item.type === "native_capabilities"), record);
  } finally { await clean(current, mcp); }
});

for (const [name, bytes, capability] of [["note.txt", Buffer.from("\ufeffline\r\n"), "embeddedContext"], ["document.pdf", Buffer.from("%PDF-1.7\nfixture\n%%EOF"), "embeddedContext"]]) test(`native missing ${capability} does not block explicit reference ${name}`, { timeout: 20_000 }, async () => {
  const current = fixture({ GROKPAIR_THIN_DISABLE_CAPABILITY: capability }), mcp = await connect(current);
  try {
    const path = join(current.root, name); writeFileSync(path, bytes);
    const admitted = await mcp.call("grok_spawn", { task: "THIN:echo:Reference accepted.", cwd: current.cwd, attachments: [{ path, kind: "reference" }] });
    const result = await done(mcp, admitted.agent.agent_id);
    assert.equal(result.operations[0].status, "completed");
    const prompt = current.traces().find(item => item.kind === "prompt_received");
    assert.equal(prompt.params.prompt.at(-1).type, "resource_link");
    assert.equal(prompt.params.prompt.at(-1).uri, pathToFileURL(path).href);
    assert.equal(contentText(result), "Reference accepted."); assert.deepEqual(readFileSync(path), bytes);
  } finally { await clean(current, mcp); }
});

test("configuration is session-level, valid during active work, and publishes model-dependent effort options", { timeout: 25_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:echo:Native defaults.");
    const initial = await done(mcp, agentId);
    assert.equal(current.traces().filter(item => item.kind === "configure").length, 0);
    assert.ok(initial.native_options.find(item => item.id === "model").options.some(item => item.value === "fixture-alternate"));
    await mcp.call("grok_send", { agent_id: agentId, task: "THIN:hold" });
    await until(async () => current.traces(), value => value.some(item => item.kind === "hold_ready"), "active configured prompt");
    const admitted = await mcp.call("grok_send", { agent_id: agentId, action: "configure", model: "fixture-alternate", effort: "turbo" });
    const changed = await until(() => read(mcp, agentId), value => value.operations.find(item => item.operation_id === admitted.operation_id)?.status === "completed", "active session configured");
    assert.equal(changed.status, "working");
    assert.deepEqual(current.traces().filter(item => item.kind === "configure").map(item => [item.params.configId, item.params.value]), [["model", "fixture-alternate"], ["reasoning_effort", "turbo"]]);
    assert.equal(changed.native_options.find(item => item.id === "model").currentValue, "fixture-alternate");
    assert.equal(changed.native_options.find(item => item.id === "reasoning_effort").currentValue, "turbo");
    assert.equal(current.traces().filter(item => item.kind === "prompt_received").length, 2, "configure creates no prompt");
    assert.deepEqual(changed.operations.find(item => item.operation_id === admitted.operation_id).effects.configuration, { model: { value: "fixture-alternate", status: "applied" }, effort: { value: "turbo", status: "applied" } });
    await mcp.call("grok_send", { agent_id: agentId, task: "THIN:echo:Invalid per-prompt selection.", model: "fixture-model" }, true);
    assert.equal(current.traces().filter(item => item.kind === "configure").length, 2);
    const future = await mcp.call("grok_send", { agent_id: agentId, action: "configure", model: "fixture-future" });
    const accepted = await until(() => read(mcp, agentId), value => value.operations.find(item => item.operation_id === future.operation_id)?.status === "completed", "native accepts value outside prior choice snapshot");
    assert.equal(accepted.native_options.find(item => item.id === "model").currentValue, "fixture-future");
  } finally { await clean(current, mcp); }
});

for (const crash of [false, true]) test(`spawn configuration preserves applied model and ${crash ? "unknown" : "rejected"} effort without allocating a prompt`, { timeout: 25_000 }, async () => {
  const current = fixture(crash ? { GROKPAIR_THIN_CONFIG_CRASH: "reasoning_effort" } : {}), mcp = await connect(current);
  try {
    const admitted = await mcp.call("grok_spawn", { task: "Exact original task must not dispatch.", cwd: current.cwd, model: "fixture-alternate", effort: "not-a-native-effort" });
    const result = await until(() => read(mcp, admitted.agent_id), value => value.operations.some(item => item.operation_id === admitted.operation_id && ["failed", "outcome_unknown"].includes(item.status)), "partial configuration settlement");
    const operation = result.operations.find(item => item.operation_id === admitted.operation_id);
    assert.equal(operation.status, crash ? "outcome_unknown" : "failed");
    assert.equal(operation.effects.configuration.model.status, "applied");
    assert.equal(operation.effects.configuration.effort.status, crash ? "unknown" : "rejected");
    assert.match(operation.error.action, /native_options/);
    assert.match(operation.error.action, /no rollback/);
    assert.match(operation.error.action, /do not replay/);
    assert.equal(operation.error.details.configuration_field, "effort");
    assert.equal(operation.error.details.setter, "reasoning_effort");
    assert.equal(operation.error.details.requested_value, "not-a-native-effort");
    assert.deepEqual(operation.error.details.applied_fields, ["model"]);
    assert.equal(operation.error.details.rollback, "not_performed");
    assert.equal(typeof operation.error.details.cause.message, "string");
    if (!crash) assert.match(JSON.stringify(operation.error.details.cause), /Selection rejected by fixture/);
    assert.deepEqual(operation.effects.prompt, { status: "not_sent" });
    assert.equal(operation.native_prompt_id, undefined);
    assert.equal(result.native_options.find(item => item.id === "model").currentValue, "fixture-alternate");
    assert.equal(current.traces().filter(item => item.kind === "configure_received").length, 2);
    assert.equal(current.traces().filter(item => item.kind === "prompt_received").length, 0);
  } finally { await clean(current, mcp); }
});

test("close admitted during fatal native cleanup retires atomically and preserves unknown configuration", { timeout: 25_000 }, async () => {
  const current = fixture({ GROKPAIR_THIN_CONFIG_DISCONNECT: "reasoning_effort" }), gate = join(current.root, "fatal-exit-release");
  current.env.GROKPAIR_THIN_EXIT_GATE = gate;
  const mcp = await connect(current);
  try {
    const admitted = await mcp.call("grok_spawn", { task: "Must never dispatch.", cwd: current.cwd, model: "fixture-alternate", effort: "turbo" });
    await until(async () => current.traces(), value => value.some(item => item.kind === "exit_gate_waiting"), "native disconnected while process exit is held");
    // The worker has observed the transport end (and so entered fatal cleanup)
    // once the bootstrap setter it was awaiting is settled as unknown.
    await until(() => read(mcp, admitted.agent_id), value => value.operations.find(item => item.operation_id === admitted.operation_id)?.status === "outcome_unknown", "worker observed the native transport end");
    const original = workerClaim(current, admitted.agent_id);
    assert.equal(processIdentityStatus(original.worker), "alive");
    assert.equal(processIdentityStatus(original.provider), "alive");
    const close = await mcp.call("grok_close", { agent_id: admitted.agent_id });
    writeFileSync(gate, "allow native process exit");
    const result = await until(() => read(mcp, admitted.agent_id), value => value.status === "closed", "fatal close honored");
    const closed = result.operations.find(item => item.operation_id === close.operation_id);
    assert.equal(closed.status, "completed", "absence-proved local retirement is distinct from native closure");
    assert.equal(closed.result.retired, true);
    assert.equal(closed.result.native, null, "no native session-close receipt is invented");
    assert.equal(closed.result.process.code, 0);
    const initial = result.operations.find(item => item.operation_id === admitted.operation_id);
    assert.equal(initial.effects.configuration.model.status, "applied");
    assert.equal(initial.effects.configuration.effort.status, "unknown");
    assert.equal(initial.effects.prompt.status, "not_sent");
    assert.equal(current.traces().filter(item => item.kind === "close").length, 0, "cleanup does not replay native closure after transport failure");
    assert.equal(current.traces().filter(item => item.kind === "launch").length, 1);
    await until(async () => workerClaim(current, admitted.agent_id), value => value === null, "fatal close worker released");
    await until(async () => [original.worker, original.provider].map(processIdentityStatus), value => value.every(status => status === "absent"), "fatal close exact processes ended");
    current.agents.delete(admitted.agent_id);
  } finally { writeFileSync(gate, "release fixture process"); await clean(current, mcp); }
});

test("initial selectors cannot be overtaken by follow-up prompt submission", { timeout: 25_000 }, async () => {
  const current = fixture(), gate = join(current.root, "model-response-release");
  current.env.GROKPAIR_THIN_CONFIGURE_MODEL_GATE = gate;
  const mcp = await connect(current);
  try {
    const admitted = await mcp.call("grok_spawn", { task: "THIN:echo:First.", cwd: current.cwd, model: "fixture-alternate", effort: "turbo" });
    await until(async () => current.traces(), value => value.some(item => item.kind === "response_gate_waiting" && item.name === "configure_model"), "initial model response held");
    await mcp.call("grok_send", { agent_id: admitted.agent_id, task: "THIN:echo:Second." });
    await pause(250);
    assert.equal(current.traces().filter(item => item.kind === "prompt_received").length, 0);
    const preparing = await read(mcp, admitted.agent_id);
    assert.equal(preparing.operations.every(item => item.native_prompt_id === undefined), true);
    writeFileSync(gate, "release model setter response");
    const complete = await done(mcp, admitted.agent_id);
    assert.equal(contentText(complete), "First.Second.");
    assert.deepEqual(current.traces().filter(item => item.kind === "prompt_received").map(item => item.text), ["THIN:echo:First.", "THIN:echo:Second."]);
  } finally { writeFileSync(gate, "release test-owned gate"); await clean(current, mcp); }
});

test("known terminal prompt defeats its stale queue row but an unseen native prompt remains active", { timeout: 25_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:stale-terminal"), result = await done(mcp, agentId);
    assert.ok(result.queue.runningPromptId, "native stale queue is preserved rather than rewritten");
    assert.equal(result.turns.find(turn => turn.prompt_id === result.queue.runningPromptId).status, "completed");
    await mcp.call("grok_send", { agent_id: agentId, action: "side_question", task: "THIN:unknown-queue" });
    const unknown = await until(() => read(mcp, agentId), value => value.status === "working" && value.queue.runningPromptId?.startsWith("unseen-"), "new unknown native prompt remains active");
    assert.equal(unknown.turns.some(turn => turn.prompt_id === unknown.queue.runningPromptId), false);
    assert.equal(unknown.turns.find(turn => turn.prompt_id === result.queue.runningPromptId).status, "completed");
    await mcp.call("grok_send", { agent_id: agentId, action: "side_question", task: "THIN:clear-queue" });
    await until(() => read(mcp, agentId), value => value.status === "idle", "native queue cleared");
  } finally { await clean(current, mcp); }
});

test("large side answers are paged separate records, not root text or unbounded operation results", { timeout: 25_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:echo:Root only."); await done(mcp, agentId);
    const admitted = await mcp.call("grok_send", { agent_id: agentId, action: "side_question", task: "THIN:large-side" });
    const result = await until(() => read(mcp, agentId, { max_chars: 3_000 }), value => value.operations.find(item => item.operation_id === admitted.operation_id)?.status === "completed", "side result retained");
    assert.equal(contentText(result), "Root only.");
    assert.equal(result.side_answers.filter(item => item.operation_id === admitted.operation_id).map(item => item.text).join(""), "Side-only λ\r\n".repeat(8_000));
    assert.ok(JSON.stringify(result.operations.find(item => item.operation_id === admitted.operation_id)).length < 1_000);
    let cursor, pages = 0, text = "";
    do {
      const page = await readPage(mcp, agentId, { view: "records", max_chars: 4_000, ...(cursor ? { cursor } : {}) });
      assert.ok(JSON.stringify(page).length <= 4_000);
      text += page.records.filter(item => item.type === "side_answer").map(item => item.text).join("");
      cursor = page.has_more ? page.cursor : undefined; pages++;
    } while (cursor && pages < 1_000);
    assert.equal(text, "Side-only λ\r\n".repeat(8_000)); assert.ok(pages > 20);
  } finally { await clean(current, mcp); }
});

test("typed search forwards exact native per-prompt metadata without altering task", { timeout: 25_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const search = { webSearch: { allowedDomains: ["example.com"] }, xSearch: { dateBound: { fromDate: "2026-01-01", toDate: "2026-02-01" } } };
    const admitted = await mcp.call("grok_spawn", { task: "THIN:echo:Search controls.", cwd: current.cwd, search });
    const result = await done(mcp, admitted.agent.agent_id);
    assert.equal(contentText(result), "Search controls.");
    const received = current.traces().find(item => item.kind === "prompt_received");
    assert.deepEqual(received.params._meta.toolOverrides, search); assert.equal(received.params.prompt[0].text, "THIN:echo:Search controls.");
  } finally { await clean(current, mcp); }
});

test("queued document edits reject before native effect; exact removal is not execution", { timeout: 25_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:hold");
    await until(async () => current.traces(), value => value.some(item => item.kind === "hold_ready"), "queue root hold");
    const path = join(current.root, "queued.md"); writeFileSync(path, "\ufeffQueued original\r\n");
    const admitted = await mcp.call("grok_send", { agent_id: agentId, task: "THIN:echo:Must never execute queued.", attachments: [{ path, kind: "reference" }] });
    const queued = await until(() => read(mcp, agentId), value => value.queue.entries.length === 1, "document queued");
    const promptId = queued.queue.entries[0].id;
    await mcp.call("grok_send", { agent_id: agentId, action: "edit", prompt_id: promptId, task: "THIN:echo:Discard document." }, true);
    assert.equal(current.traces().filter(item => item.kind === "edit").length, 0);
    await mcp.call("grok_interrupt", { agent_id: agentId, prompt_id: promptId });
    const removed = await until(() => read(mcp, agentId), value => value.operations.find(item => item.operation_id === admitted.operation_id)?.result?._meta?.completionKind === "removedFromQueue", "native exact queue removal");
    assert.equal(removed.queue.entries.length, 0); assert.equal(removed.status, "working");
    assert.equal(current.traces().filter(item => item.kind === "prompt_started" && item.prompt_id === promptId).length, 0);
    assert.equal(current.traces().find(item => item.kind === "remove").params.id, promptId);
    assert.equal(contentText(removed), "Before cancellation.");
  } finally { await clean(current, mcp); }
});

for (const media of ["image", "audio"]) test(`native structured ${media} result yields a live reference without a frozen media tool roster`, { timeout: 25_000 }, async () => {
  const current = fixture(); current.env.GROKPAIR_THIN_OUTPUT_DIR = join(current.root, "native-output"); mkdirSync(current.env.GROKPAIR_THIN_OUTPUT_DIR);
  const mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, media === "image" ? "THIN:media-reference" : "THIN:audio-reference"), result = await done(mcp, agentId);
    const path = join(current.env.GROKPAIR_THIN_OUTPUT_DIR, media === "image" ? "fixture-image.png" : "fixture-audio.wav");
    assert.ok(result.files.some(item => item.source === "native" && item.path === path));
    const before = result.files;
    writeFileSync(path, "changed native-owned bytes");
    const after = await read(mcp, agentId);
    assert.deepEqual(after.files, before); assert.equal(readFileSync(path, "utf8"), "changed native-owned bytes");
    assert.equal(after.files.some(item => item.sha256 || item.acquired_path), false);
  } finally { await clean(current, mcp); }
});

test("native tool failure retains compact code, message, title and prompt identity without suppressing root", { timeout: 25_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:tool-failure"), result = await done(mcp, agentId);
    const issue = result.issues.find(item => item.code === "native_tool_failed");
    assert.equal(issue.native_code, "native_fixture_limit"); assert.equal(issue.message, "Precise native tool rejection");
    assert.equal(issue.title, "Native diagnostic title"); assert.equal(issue.tool_call_id, "failed-native-tool");
    assert.equal(issue.prompt_id, result.operations[0].native_prompt_id);
    assert.equal(contentText(result), "Root result remains available despite native tool failure.");
  } finally { await clean(current, mcp); }
});

test("native tool diagnostic codes are lossless, source-labelled and finite without altering valid values", async () => {
  const { build } = await import("esbuild");
  const bundle = await build({ stdin: { contents: 'export { nativeToolFailure } from "./src/native.ts";',
    resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "ts" },
    bundle: true, platform: "node", format: "esm", write: false });
  const { nativeToolFailure } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64" )}`);
  const huge = nativeToolFailure({ rawOutput: { error: { message: "Actual failure", code: "C".repeat(1_000_000) } } });
  assert.equal(huge.native_code, "C".repeat(1_000_000));
  assert.equal(huge.native_code_source, "rawOutput.error.code");
  assert.equal(Object.hasOwn(huge, "diagnostics_truncated"), false);
  assert.equal(huge.message, "Actual failure");
  for (const code of [0, -0, -32000, 1.5, Number.MAX_VALUE, "", "E_NATIVE", "B".repeat(1000)]) {
    const result = nativeToolFailure({ rawOutput: { code } });
    assert.ok(Object.is(result.native_code, code));
    assert.equal(result.native_code_source, "rawOutput.code");
    assert.equal(result.diagnostics_truncated, undefined);
  }
  for (const code of [NaN, Infinity, -Infinity]) {
    const result = nativeToolFailure({ rawOutput: { code } });
    assert.equal(Object.hasOwn(result, "native_code"), false);
    assert.equal(Object.hasOwn(result, "native_code_source"), false);
    assert.equal(nativeToolFailure({ rawOutput: { code, error: { code: "E_FALLBACK" } } }).native_code, "E_FALLBACK");
  }
  const structured = nativeToolFailure({ content: [{ type: "content", content: { type: "text",
    text: JSON.stringify({ code: "J".repeat(1001), message: "JSON failure" }) } }] });
  assert.equal(structured.native_code, "J".repeat(1001));
  assert.equal(structured.native_code_source, "content[0].content.text.code");
  assert.equal(Object.hasOwn(structured, "diagnostics_truncated"), false);
});

test("native tool diagnostics preserve complete explicit provenance without turning tool transcripts into output", { timeout: 25_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:tool-failure-diagnostics"), result = await done(mcp, agentId);
    const byTool = name => result.issues.find(item => item.code === "native_tool_failed" && item.tool_call_id === name);
    const nested = byTool("nested-first");
    assert.equal(nested.message, "Nested primary failure"); assert.equal(nested.native_code, "nested_code");
    assert.equal(nested.diagnostic_source, "rawOutput.error.message");
    assert.ok(nested.diagnostics.some(item => item.source === "rawOutput.message" && item.message === "Sibling diagnostic message"));
    assert.ok(nested.diagnostics.some(item => item.source === "rawOutput.cause.message" && item.message === "Native explicit cause"));
    const sibling = byTool("sibling-first");
    assert.equal(sibling.message, "Sibling primary failure");
    assert.ok(sibling.diagnostics.some(item => item.source === "rawOutput.error" && item.message === "String error detail"));
    const structured = byTool("json-content");
    assert.equal(structured.message, "Structured JSON failure");
    assert.equal(structured.diagnostic_source, "content[0].content.text.error.message");
    assert.ok(structured.diagnostics.some(item => item.source === "content[0].content.text.cause.message" && item.message === "Structured cause"));
    const untrusted = byTool("untrusted-content");
    assert.equal(untrusted.message, "Native tool reported failure");
    assert.equal(JSON.stringify(result.issues).includes("SECRET"), false);
    assert.equal(JSON.stringify(result.issues).includes("STDOUT MUST NOT"), false);
    const bounded = byTool("bounded");
    assert.equal(bounded.message, "P".repeat(5000));
    assert.equal(Object.hasOwn(bounded, "diagnostics_truncated"), false);
    assert.equal(bounded.diagnostics.length, 5);
    assert.equal(bounded.diagnostics.reduce((sum, item) => sum + item.message.length, 0), 25_000);
    assert.ok(bounded.diagnostics.every(item => !Object.hasOwn(item, "truncated")));
    assert.ok(bounded.diagnostics.every(item => item.source.startsWith("rawOutput.")));
    for (const issue of result.issues.filter(item => item.code === "native_tool_failed")) assert.equal(issue.prompt_id, result.operations[0].native_prompt_id);
    assert.equal(contentText(result), "Useful root survives diagnostic extraction.");
  } finally { await clean(current, mcp); }
});

test("multi-agent wait delivers independent parallel work once through opaque cursors", { timeout: 25_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const first = await mcp.call("grok_spawn", { task: "THIN:delayed:Parallel A.", cwd: current.cwd });
    const second = await mcp.call("grok_spawn", { task: "THIN:delayed:Parallel B.", cwd: current.cwd });
    const ids = [first.agent.agent_id, second.agent.agent_id];
    assert.equal(Object.hasOwn(first.agent, "cursor"), false, "mutation receipt carries no read cursor");
    const cursors = new Map();
    const text = new Map(ids.map(id => [id, ""])); const completed = new Set();
    for (let iteration = 0; completed.size < ids.length && iteration < 25; iteration++) {
      const waited = await mcp.call("grok_wait", { targets: ids.map(agent_id => ({ agent_id, cursor: cursors.get(agent_id) })), timeout_ms: 5_000 });
      assert.equal(waited.call_status, "settled");
      for (const result of waited.agents) {
        text.set(result.agent_id, text.get(result.agent_id) + contentText(result));
        cursors.set(result.agent_id, result.cursor);
        if (result.status === "idle" && result.counts.pending_operations === 0 && !result.has_more) completed.add(result.agent_id);
      }
    }
    assert.equal(completed.size, 2);
    assert.equal(text.get(ids[0]), "Parallel A."); assert.equal(text.get(ids[1]), "Parallel B.");
    const events = current.traces();
    const starts = events.map((event, index) => event.kind === "prompt_started" ? index : -1).filter(index => index >= 0);
    assert.equal(starts.length, 2);
    assert.ok(starts[1] < events.findIndex(event => event.kind === "prompt_returned"), "both native peers started before either returned");
    assert.equal(new Set(events.filter(event => event.kind === "prompt_started").map(event => event.pid)).size, 2);
    const snapshot = await mcp.call("grok_wait", { targets: ids.map(agent_id => ({ agent_id, cursor: cursors.get(agent_id) })), timeout_ms: 0 });
    assert.equal(snapshot.call_status, "timeout");
    assert.ok(snapshot.agents.every(agent => contentText(agent) === ""));
  } finally { await clean(current, mcp); }
});

const toolNames = ["grok_spawn", "grok_send", "grok_wait", "grok_read", "grok_list", "grok_respond", "grok_interrupt", "grok_close"];
test("MCP lists eight tools without host result overrides; a server beneath a collaborator lists none", { timeout: 30_000 }, async () => {
  const current = fixture(), mcp = await connect(current);
  try {
    const listed = await mcp.client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name), toolNames);
    for (const tool of listed.tools) {
      assert.equal(tool._meta, undefined, tool.name + " must not override native host result handling");
    }
  } finally { await mcp.close(); }
  const nested = fixture({ GROKPAIR_COLLABORATOR: "agent_12345678-1234-4123-8123-123456789abc" }), inner = await connect(nested);
  try {
    assert.equal(inner.client.getServerCapabilities()?.tools, undefined);
    await assert.rejects(inner.client.listTools());
    await assert.rejects(inner.client.callTool({ name: "grok_spawn", arguments: { task: "THIN:echo:Must not start.", cwd: nested.cwd } }));
    assert.equal(existsSync(join(nested.root, "runtime")), false); assert.deepEqual(nested.traces(), []);
  } finally { await inner.close(); }
});

test("the worker marks the provider environment, so a grokpair started by the collaborator refuses tool calls", { timeout: 30_000 }, async () => {
  const current = fixture({ GROKPAIR_THIN_ENTRYPOINT: entrypoint }), mcp = await connect(current);
  try {
    const agentId = await spawn(mcp, current, "THIN:nested"), result = await done(mcp, agentId);
    assert.equal(contentText(result), "Nested call observed.");
    const nested = current.traces().find(item => item.kind === "nested_cli");
    assert.equal(nested.marker, agentId);
    assert.equal(nested.status, 1); assert.equal(nested.stdout, "");
    assert.equal(JSON.parse(nested.stderr).error.code, "nested_collaborator");
  } finally { await clean(current, mcp); }
});

test("the command line mirrors the tools: compact JSON, exit status from call_status, stdin input and usage errors", { timeout: 60_000 }, async () => {
  const current = fixture(), bin = join(dirname(entrypoint), "..", "bin", "grokpair");
  const cli = (args, { input = "", env = current.env, command = entrypoint } = {}) =>
    spawnSync(process.execPath, [command, ...args], { cwd: current.cwd, env, input, encoding: "utf8", timeout: 20_000 });
  const json = (result, status = 0) => {
    assert.equal(result.status, status, result.stderr); assert.equal(result.stderr.replace(/^\(node:\d+\) ExperimentalWarning: SQLite.*\n(\(Use `node --trace-warnings.*\n)?/gmu, ""), "");
    assert.match(result.stdout, /^\{.*\}\n$/u, "one compact JSON line"); return JSON.parse(result.stdout);
  };
  const failure = (result, status, code) => {
    assert.equal(result.status, status); assert.equal(result.stdout, "");
    const value = JSON.parse(result.stderr.trim().split("\n").at(-1));
    assert.equal(value.call_status, "error"); assert.equal(value.error.code, code); return value;
  };
  const agent_id = "agent_12345678-1234-4123-8123-123456789abc";
  const version = spawnSync(process.execPath, [bin, "version"], { encoding: "utf8" });
  assert.equal(version.status, 0);
  assert.deepEqual(JSON.parse(version.stdout), { product: "grokpair", version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version, schema_version: "3" });
  const usage = cli([]);
  assert.equal(usage.status, 0); assert.match(usage.stdout, /^usage: grokpair <command>/u, "no arguments prints usage rather than serving MCP");
  assert.deepEqual(json(cli(["list", "{}"])), { schema_version: "3", call_status: "ok", agents: [], page: { has_more: false } });
  assert.equal(json(cli(["list"])).call_status, "ok", "a missing argument is an empty input object");
  assert.equal(json(cli(["grok_list", "-"], { input: '{"include_closed":true,"key":"absent"}' })).call_status, "ok");
  const missing = json(cli(["read", JSON.stringify({ agent_id })]), 1);
  assert.equal(missing.call_status, "error"); assert.equal(missing.error.code, "collaborator_not_found");
  assert.equal(json(cli(["list", '{"view":"recent"}']), 1).error.code, "invalid_input");
  failure(cli(["list", "not json"]), 1, "invalid_input");
  failure(cli(["list", "-"], { input: "{" }), 1, "invalid_input");
  for (const args of [["frobnicate"], ["list", "{}", "extra"], ["mcp", "extra"], ["version", "extra"]]) failure(cli(args), 2, "invalid_command");
  failure(cli(["list", "{}"], { env: { ...current.env, GROKPAIR_COLLABORATOR: agent_id } }), 1, "nested_collaborator");
  failure(cli(["internal-worker", agent_id, "launch-token"], { env: { ...current.env, GROKPAIR_COLLABORATOR: agent_id } }), 1, "nested_collaborator");
  assert.equal(existsSync(join(current.root, "runtime")), false, "read-only and rejected calls create no runtime state");
  let spawned;
  try {
    const input = { task: "THIN:echo:From the command line.", cwd: current.cwd, key: "cli-key" };
    spawned = json(cli(["spawn", JSON.stringify(input)]));
    assert.equal(spawned.call_status, "admitted"); assert.equal(spawned.agent.key, "cli-key");
    const waited = json(cli(["wait", "-"], { input: JSON.stringify({ targets: [{ agent_id: spawned.agent_id }], timeout_ms: 15_000 }) }));
    assert.equal(waited.call_status, "settled"); assert.equal(waited.agents[0].status, "idle");
    assert.deepEqual(waited.agents[0].turns.map(turn => [turn.operation_id, turn.status, turn.text]), [[spawned.operation_id, "completed", "From the command line."]]);
    const conflict = json(cli(["spawn", JSON.stringify({ ...input, task: "THIN:echo:Not started." })]), 1);
    assert.equal(conflict.call_status, "error"); assert.equal(conflict.error.code, "spawn_key_conflict"); assert.equal(conflict.error.admission, "none");
    const existing = json(cli(["spawn", JSON.stringify(input)]));
    assert.equal(existing.call_status, "existing"); assert.equal(existing.agent_id, spawned.agent_id);
    assert.equal(json(cli(["close", JSON.stringify({ agent_id: spawned.agent_id })])).call_status, "admitted");
    await until(async () => json(cli(["read", JSON.stringify({ agent_id: spawned.agent_id })])).agent.status, value => value === "closed", "command-line close");
    await until(async () => workerClaim(current, spawned.agent_id), value => value === null, "command-line worker released");
    assert.deepEqual(current.traces().filter(item => item.kind === "prompt_received").map(item => item.text), ["THIN:echo:From the command line."]);
  } finally {
    if (spawned && workerClaim(current, spawned.agent_id)) cli(["close", JSON.stringify({ agent_id: spawned.agent_id })]);
  }
});
