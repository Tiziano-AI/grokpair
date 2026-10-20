import assert from "node:assert/strict";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "grokpair-thin-service-")));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const bundle = join(scratch, "service.mjs");
await build({ stdin: { contents: 'export * from "./src/agent-service.ts"; export * from "./src/agent-store.ts"; export { parseAttention } from "./src/attention.ts"; export { observeProcess, processIdentityStatus } from "./src/process.ts"; export { workspaceBoundaries } from "./src/filesystem.ts";', resolveDir: new URL("../", import.meta.url).pathname, loader: "ts" }, outfile: bundle, bundle: true, platform: "node", format: "esm" });
const { AgentService, AgentStore, WorkerLaunchError, parseAttention, observeProcess, processIdentityStatus, workspaceBoundaries } = await import(bundle);
function fixture({ launcher, claimed = true, queueObserved = true } = {}) {
  const root = realpathSync(mkdtempSync(join(scratch, "case-"))), cwd = join(root, "workspace"); mkdirSync(cwd);
  const env = { ...process.env, GROKPAIR_HOME: join(root, "runtime") }, launches = [];
  const service = new AgentService(env, launcher ?? ((...args) => { launches.push(args); }));
  const meta = { agent_id: `agent_${randomUUID()}`, cwd, worktree: false, sandbox_argument: null, execution_cwd: null, created_at: new Date().toISOString(), phase: "opening" };
  const store = AgentStore.create(meta, env);
  const reservation = store.admitLaunch({ task: "initial" }, { operation_id: `operation_${randomUUID()}`, resume: false });
  const claim = claimed ? store.claim(reservation.launch.token) : null;
  if (claim) {
    store.updateOperation(claim, reservation.operation.operation_id, { status: "started" });
    store.updateOperation(claim, reservation.operation.operation_id, { status: "completed" });
    store.setMeta(claim, { phase: "ready" });
    if (queueObserved) store.setObservation(claim, "queue", { entries: [] });
  }
  return { root, cwd, env, service, store, claim, reservation, agentId: meta.agent_id, launches };
}
const call = (f, name, input = {}) => f.service.invoke(name, { agent_id: f.agentId, ...input });
const of = (agent, type) => (agent.records ?? []).filter(row => row.type === type);
const textOf = agent => of(agent, "content").map(row => row.text).join("");
/** Caller-facing text of one result-view page: every turn's text in page order. */
const turnText = agent => (agent.turns ?? []).map(turn => turn.text ?? "").join("");
/** Drain the full typed record stream (records view). */
async function drain(f, input = {}) {
  input = { view: "records", ...input };
  const records = [], fragments = new Map();
  for (let count = 0; count < 2000; count++) {
    const result = await call(f, "grok_read", input); assert.equal(result.call_status, "ok", JSON.stringify(result));
    const page = result.agent; records.push(...(page.records ?? []));
    if (page.fragment_reset !== undefined) fragments.delete(page.fragment_reset);
    for (const fragment of page.fragments ?? []) {
      const previous = fragments.get(fragment.record_id) ?? "";
      assert.equal(fragment.offset, previous.length);
      const json = previous + fragment.json;
      if (fragment.complete) { records.push(JSON.parse(json)); fragments.delete(fragment.record_id); }
      else fragments.set(fragment.record_id, json);
    }
    if (!page.has_more) return { ...page, records };
    input = { ...input, cursor: page.cursor };
  }
  assert.fail("pagination did not advance");
}
/** Drain result-view pages; each page is returned as the caller received it. */
async function drainResult(f, input = {}) {
  const pages = [];
  for (let count = 0; count < 1000; count++) {
    const result = await call(f, "grok_read", input); assert.equal(result.call_status, "ok", JSON.stringify(result));
    const page = result.agent; assert.equal(Object.hasOwn(page, "records"), false, "result view carries no record stream");
    pages.push(page);
    if (!page.has_more) return pages;
    input = { ...input, cursor: page.cursor };
  }
  assert.fail("pagination did not advance");
}
/** A receipt names its durable operation; admission is stated by call_status alone. */
function compact(result, store) {
  assert.equal(result.call_status, "admitted", JSON.stringify(result));
  assert.equal(Object.hasOwn(result, "admission"), false, "receipts carry no top-level admission field");
  assert.match(result.operation_id, /^operation_[0-9a-f-]{36}$/u); assert.equal(result.agent_id, result.agent.agent_id);
  if (store) assert.equal(store.operation(result.operation_id)?.operation_id, result.operation_id);
  for (const key of ["records", "cursor", "content", "operations", "native_options", "turns"]) assert.equal(Object.hasOwn(result.agent, key), false, key);
}
test("spawn preflight precedes admission; ambiguous launch stays confirmed and close fences it", async () => {
  let observed;
  const f = fixture({ launcher: (agentId, meta, env, token) => {
    const store = AgentStore.open(agentId, env, { readonly: true });
    try { observed = { meta, token, operation: store.operations()[0], launch: store.launch() }; } finally { store.close(); }
    throw new Error("launch outcome not observed");
  } });
  const invalid = await f.service.invoke("grok_spawn", { task: "invalid", cwd: "/" });
  assert.equal(invalid.error.admission, "none"); assert.equal(observed, undefined);
  const result = await f.service.invoke("grok_spawn", { task: "original\r\n", cwd: f.cwd });
  assert.equal(result.schema_version, "3"); assert.equal(result.error.admission, "confirmed");
  assert.equal(observed.operation.input.task, "original\r\n"); assert.equal(observed.operation.status, "admitted");
  assert.equal(result.error.operation_id, observed.operation.operation_id); assert.equal(observed.token, observed.launch.token);
  const close = await f.service.invoke("grok_close", { agent_id: result.error.agent_id }); compact(close); assert.equal(close.agent.status, "closed"); f.store.close();
});
test("mistyped image spawn and follow-up fail before admission, without a held key or new operation", async () => {
  const f = fixture(), path = join(f.cwd, "not-an-image.png");
  writeFileSync(path, "A document, not image bytes.");
  const before = (await f.service.invoke("grok_list", { include_closed: true })).agents.map(agent => agent.agent_id);
  try {
    for (const key of [undefined, "mistyped-image"]) {
      const result = await f.service.invoke("grok_spawn", { task: "Inspect", cwd: f.cwd, attachments: [{ path, kind: "image" }], ...(key ? { key } : {}) });
      assert.equal(result.error.code, "attachment_not_admitted"); assert.equal(result.error.admission, "none");
      assert.equal(result.error.agent_id, undefined); assert.equal(result.error.operation_id, undefined);
    }
    const result = await call(f, "grok_send", { task: "Inspect", attachments: [{ path, kind: "image" }] });
    assert.equal(result.error.code, "attachment_not_admitted"); assert.equal(result.error.admission, "none");
    assert.equal(f.store.operations().length, 1); assert.equal(f.launches.length, 0);
    assert.deepEqual((await f.service.invoke("grok_list", { include_closed: true })).agents.map(agent => agent.agent_id), before);
    assert.equal(existsSync(join(f.root, "runtime", "runtime-v2", "keys.sqlite")), false);
  } finally { f.store.close(); }
});

test("definitive no-child launch settles not-sent", async () => {
  const f = fixture({ launcher: () => { throw new WorkerLaunchError(new Error("no child")); } });
  const result = await f.service.invoke("grok_spawn", { task: "original", cwd: f.cwd }); assert.equal(result.error.admission, "confirmed");
  const store = AgentStore.open(result.error.agent_id, f.env);
  assert.equal(store.operations()[0].status, "not_sent"); assert.equal(store.launch().state, "fenced"); store.close();
  // Nothing can still claim it, so it reads disconnected and an explicit resume starts it.
  assert.equal((await f.service.invoke("grok_read", { agent_id: result.error.agent_id })).agent.status, "disconnected");
  const launches = [], retry = new AgentService(f.env, (...args) => { launches.push(args); });
  const resumed = await retry.invoke("grok_send", { agent_id: result.error.agent_id, task: "again", resume: true });
  assert.equal(resumed.call_status, "admitted"); assert.equal(launches.length, 1); f.store.close();
});
test("a launch failure reported after the child claimed leaves the outcome to that child", async () => {
  const f = fixture({ launcher: (agentId, _meta, env, token) => {
    const child = AgentStore.open(agentId, env); child.claim(token); child.close();
    throw new WorkerLaunchError(new Error("reported late"));
  } });
  const result = await f.service.invoke("grok_spawn", { task: "original", cwd: f.cwd }); compact(result);
  const store = AgentStore.open(result.agent_id, f.env);
  assert.equal(store.launch().state, "claimed"); assert.equal(store.operations()[0].status, "admitted"); store.close(); f.store.close();
});
test("single cursor drains Unicode, retains prompt selection and omits private inputs", async () => {
  const f = fixture(), original = "x".repeat(999) + "😀" + "λ".repeat(2600) + "\r\n";
  f.store.appendContent(f.claim, { prompt_id: "p1", block_index: 0, text: original });
  f.store.appendContent(f.claim, { prompt_id: "p2", block_index: 0, text: "other" });
  f.store.appendContent(f.claim, { prompt_id: "p1", native_message_id: "m", block_index: 1, text: "tail" });
  f.store.admit("follow_up", { task: "private input must not repeat" });
  let cursor, reconstruction = "", pages = 0;
  do {
    const result = await call(f, "grok_read", { view: "records", max_chars: 2000, ...(cursor ? { cursor } : {}) });
    assert.equal(result.call_status, "ok"); const page = result.agent;
    assert.ok(JSON.stringify(result).length <= 2000); assert.equal(JSON.stringify(page).includes("private input"), false);
    for (const row of of(page, "content")) assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(row.text));
    reconstruction += textOf(page); cursor = page.cursor; pages++;
    if (!page.has_more) break;
  } while (pages < 200);
  assert.equal(reconstruction, original + "othertail"); assert.ok(pages > 3);
  const selected = (await call(f, "grok_read", { view: "records", prompt_id: "p1", max_chars: 1000 })).agent;
  assert.equal((await call(f, "grok_read", { prompt_id: "p2", cursor: selected.cursor })).call_status, "error");
  assert.equal((await call(f, "grok_read", { prompt_id: "unknown" })).call_status, "error");
  const rest = await drain(f, { cursor: selected.cursor, max_chars: 1000 });
  assert.equal(textOf(selected) + textOf(rest), original + "tail"); assert.equal(rest.records.every(row => row.prompt_id === "p1"), true);
  assert.equal(f.launches.length, 0); f.store.close();
});
test("characters alone bound a page; large attention remains wholly retrievable through fragments", async () => {
  const f = fixture(), before = (await drain(f)).cursor;
  for (let index = 0; index < 90; index++) f.store.upsertFile(f.claim, { uri: `file:///output/${index}` });
  const payload = { native: "x".repeat(40_000) };
  f.store.upsertAttention(f.claim, { request_id: `request_${randomUUID()}`, method: "elicitation/create", payload, status: "pending" });
  // No record count ends a page: every file fits in one, and the large attention waits for the next.
  const first = await call(f, "grok_read", { cursor: before, max_chars: 30_000 }); let page = first.agent;
  assert.ok(JSON.stringify(first).length <= 30_000); assert.equal(of(page, "file").length, 90); assert.equal(page.has_more, true);
  const whole = (await call(f, "grok_read", { cursor: before, max_chars: 500_000 })).agent;
  assert.equal(of(whole, "file").length, 90); assert.equal(of(whole, "attention").length, 1); assert.equal(whole.has_more, false);
  const all = await drain(f, { cursor: before, max_chars: 2000 }), files = of(all, "file"), attention = of(all, "attention")[0];
  assert.equal(files.length, 90); assert.equal(new Set(files.map(row => row.reference_id)).size, 90); assert.deepEqual(attention.payload, payload); f.store.close();
});
test("side answers paginate losslessly apart from root text", async () => {
  const f = fixture(), side = f.store.admit("side_question", { task: "private question" }), answer = "side 😀\r\n".repeat(500);
  f.store.appendContent(f.claim, { prompt_id: "p", block_index: 0, text: "root" });
  f.store.appendSideAnswer(f.claim, { operation_id: side.operation_id, text: answer });
  const all = await drain(f, { max_chars: 2000 }); assert.equal(textOf(all), "root");
  assert.equal(of(all, "side_answer").map(row => row.text).join(""), answer);
  assert.equal(of(all, "side_answer").every(row => row.operation_id === side.operation_id), true); f.store.close();
});
test("moving a current observation during text draining cannot skip other records", async () => {
  const f = fixture(), before = (await drain(f)).cursor, original = "😀".repeat(1800);
  f.store.setObservation(f.claim, "queue", { entries: [{ id: "first" }] });
  f.store.appendContent(f.claim, { prompt_id: "p", block_index: 0, text: original });
  f.store.setObservation(f.claim, "native_options", { options: [{ id: "effort" }] });
  const first = (await call(f, "grok_read", { cursor: before, max_chars: 1000 })).agent; assert.equal(first.has_more, true);
  f.store.setObservation(f.claim, "queue", { entries: [{ id: "second" }] });
  const rest = await drain(f, { cursor: first.cursor, max_chars: 1000 }); assert.equal(textOf(first) + textOf(rest), original);
  assert.equal(of(rest, "native_options").length, 1); assert.deepEqual(of(rest, "queue").map(row => row.entries), [[{ id: "second" }]]);
  assert.deepEqual((await drain(f, { cursor: rest.cursor })).records, []); f.store.close();
});
test("max_chars bounds the whole result in both views, whatever the text escapes to", async () => {
  const f = fixture(), before = { result: (await drainResult(f)).at(-1).cursor, records: (await drain(f)).cursor };
  const original = Array.from({ length: 400 }, (_, index) => `"q${index}" \\ tab\t nul\u0000 😀 λ\r\n`).join("");
  f.store.appendContent(f.claim, { prompt_id: "p", block_index: 0, block_start: true, text: original });
  for (const max_chars of [2_000, 5_000, 32_000]) {
    for (const view of ["result", "records"]) {
      let cursor = before[view], text = "", pages = 0;
      do {
        const result = await call(f, "grok_read", { view, max_chars, cursor }), page = result.agent, size = JSON.stringify(result).length;
        assert.equal(page.oversized, undefined); assert.ok(size <= max_chars, `${view} page of ${size} characters over ${max_chars}`);
        text += view === "result" ? turnText(page) : textOf(page); pages++;
        cursor = page.has_more ? page.cursor : undefined;
      } while (cursor && pages < 500);
      assert.equal(text, original, `${view} at ${max_chars}`);
    }
  }
  f.store.close();
});
test("a budget too small for a continuation envelope returns an error without advancing", async () => {
  const f = fixture(), before = (await drain(f)).cursor, original = "x".repeat(40);
  f.store.appendContent(f.claim, { prompt_id: "p", block_index: 0, text: original });
  const revision = f.store.revision(), failed = await call(f, "grok_read", { view: "records", max_chars: 100, cursor: before });
  assert.equal(failed.call_status, "error"); assert.equal(failed.error.code, "response_budget_too_small");
  assert.equal(failed.error.admission, "none"); assert.equal(Object.hasOwn(failed, "agent"), false);
  assert.deepEqual(f.store.revision(), revision);
  assert.equal(textOf(await drain(f, { cursor: before, max_chars: 2000 })), original);
  f.store.close();
});
test("turn files follow committed state only and never collide by case", async () => {
  const f = fixture(), put = f.store.putRecord;
  f.store.upsertTurn(f.claim, { prompt_id: "p", status: "running", source: "native" });
  f.store.appendContent(f.claim, { prompt_id: "p", block_index: 0, text: "kept" });
  // A stop that rolls back leaves the turn running and writes no file.
  f.store.putRecord = function (...args) { const stored = put.apply(this, args); if (args[0] === "turn") throw new Error("abort"); return stored; };
  assert.throws(() => f.store.upsertTurn(f.claim, { prompt_id: "p", status: "completed", source: "native" }), /abort/);
  f.store.putRecord = put;
  assert.equal(f.store.turn("p").status, "running"); assert.equal(f.store.turnFile("p"), null);
  f.store.upsertTurn(f.claim, { prompt_id: "p", status: "completed", source: "native" });
  assert.match(readFileSync(f.store.turnFile("p"), "utf8"), /\n---\n\nkept\n$/u);
  for (const id of ["Q", "q"]) f.store.upsertTurn(f.claim, { prompt_id: id, status: "completed", source: "native" });
  assert.notEqual(f.store.turnFile("Q").toLowerCase(), f.store.turnFile("q").toLowerCase());
  assert.match(f.store.turnFile("Q"), /\/turns\/[0-9a-f]{64}\.md$/u); assert.match(f.store.turnFile("q"), /\/turns\/q\.md$/u);
  f.store.close();
});
for (const change of ["late text", "stop metadata"]) test(`failed turn file rewrite omits stale ${change} even when cleanup is denied`, async () => {
  const f = fixture();
  f.store.appendContent(f.claim, { prompt_id: "p", block_index: 0, text: "original" });
  f.store.upsertTurn(f.claim, { prompt_id: "p", status: "completed", source: "native", stop_reason: "end_turn" });
  const path = f.store.turnFile("p"), directory = join(path, ".."), original = readFileSync(path, "utf8");
  assert.match(original, /\n---\n\noriginal\n$/u);
  chmodSync(directory, 0o500);
  try {
    // Real filesystem denial leaves the old file readable but prevents replacing or removing it.
    assert.throws(() => unlinkSync(path), error => ["EACCES", "EPERM"].includes(error.code));
    if (change === "late text") {
      assert.doesNotThrow(() => f.store.appendContent(f.claim, { prompt_id: "p", block_index: 1, block_start: true, text: "late" }));
    } else {
      assert.doesNotThrow(() => f.store.upsertTurn(f.claim, { prompt_id: "p", status: "completed", source: "native", stop_reason: "max_tokens" }));
    }
    assert.equal(readFileSync(path, "utf8"), original, "failed rewrite really left the earlier derived file in place");
    for (const view of ["result", "records"]) {
      const result = await call(f, "grok_read", { view, prompt_id: "p" });
      assert.equal(result.call_status, "ok"); assert.equal(result.agent.status, "idle");
      const turn = view === "result" ? result.agent.turns[0] : of(result.agent, "turn")[0];
      assert.equal(turn.text_file, undefined, `${view} must not publish stale complete text`);
      assert.equal(turn.status, "completed"); assert.equal(turn.stop_reason, change === "late text" ? "end_turn" : "max_tokens");
      assert.equal(view === "result" ? turn.text : textOf(result.agent), change === "late text" ? (view === "result" ? "original\n\nlate" : "originallate") : "original");
    }
    const reopened = AgentStore.open(f.agentId, f.env, { readonly: true });
    try { assert.equal(reopened.turnFile("p"), null, "freshness survives store reopen"); } finally { reopened.close(); }
    chmodSync(directory, 0o700);
    f.store.upsertTurn(f.claim, f.store.turn("p"));
    assert.equal(f.store.turnFile("p"), path, "a successful rewrite publishes the file again");
    assert.notEqual(readFileSync(path, "utf8"), original);
    assert.equal(f.launches.length, 0);
  } finally { chmodSync(directory, 0o700); f.store.close(); }
});
test("wait ignores token arrival even until change, then settles on exact completion", async () => {
  const f = fixture(); f.store.upsertTurn(f.claim, { prompt_id: "p", status: "running", source: "native" });
  const before = (await drainResult(f)).at(-1).cursor;
  const timer = setTimeout(() => f.store.appendContent(f.claim, { prompt_id: "p", block_index: 0, block_start: true, text: "partial" }), 20);
  const start = performance.now(), timeout = await f.service.invoke("grok_wait", { targets: [{ agent_id: f.agentId, cursor: before }], until: "change", timeout_ms: 160 }); clearTimeout(timer);
  assert.equal(timeout.call_status, "timeout"); assert.ok(performance.now() - start >= 145);
  // The turn record was read before the cursor; the page still reports the turn's current status.
  assert.deepEqual(timeout.agents[0].turns, [{ prompt_id: "p", status: "running", text: "partial" }]);
  const finish = setTimeout(() => f.store.upsertTurn(f.claim, { prompt_id: "p", status: "completed", source: "native", stop_reason: "end_turn" }), 20);
  const result = await f.service.invoke("grok_wait", { targets: [{ agent_id: f.agentId, cursor: timeout.agents[0].cursor }], timeout_ms: 1000 }); clearTimeout(finish);
  assert.equal(result.call_status, "settled"); assert.equal(result.agents[0].status, "idle");
  const [turn] = result.agents[0].turns;
  assert.deepEqual(turn, { prompt_id: "p", status: "completed", stop_reason: "end_turn", text_file: f.store.turnFile("p") });
  // The finished turn is also a private plain file: its complete text after exact front matter.
  assert.equal(readFileSync(turn.text_file, "utf8"), `---\nagent_id: ${JSON.stringify(f.agentId)}\nprompt_id: "p"\nstatus: "completed"\nstop_reason: "end_turn"\ncwd: ${JSON.stringify(f.cwd)}\nexecution_cwd: null\nworktree_root: null\nsandbox_argument: null\nsandbox_observation: "unavailable"\n---\n\npartial\n`);
  assert.equal(statSync(turn.text_file).mode & 0o777, 0o600); assert.equal(statSync(join(turn.text_file, "..")).mode & 0o777, 0o700);
  // Text arriving after the turn stopped reaches the file too.
  f.store.appendContent(f.claim, { prompt_id: "p", block_index: 1, block_start: true, text: "late" });
  assert.match(readFileSync(turn.text_file, "utf8"), /\n---\n\npartial\n\nlate\n$/u);
  assert.equal(f.launches.length, 0); f.store.close();
});
test("wait drains has_more immediately and isolates malformed sibling cursor in either view", async () => {
  const f = fixture(), otherId = `agent_${randomUUID()}`; f.store.appendContent(f.claim, { prompt_id: "p", block_index: 0, text: "z".repeat(130_000) });
  const other = AgentStore.create({ ...f.store.meta(), agent_id: otherId }, f.env); other.close();
  const first = (await call(f, "grok_read")).agent; assert.equal(first.has_more, true);
  const start = performance.now();
  const drained = await f.service.invoke("grok_wait", { targets: [{ agent_id: f.agentId, cursor: first.cursor }], timeout_ms: 1000 });
  assert.ok(performance.now() - start < 500, "unread retained text is new without a wake"); assert.equal(drained.call_status, "settled");
  assert.ok(turnText(drained.agents[0]).length > 30_000);
  const head = (await drain(f)).cursor;
  const result = await f.service.invoke("grok_wait", { targets: [{ agent_id: f.agentId, cursor: first.cursor }, { agent_id: otherId, cursor: "bad" }], timeout_ms: 1000, max_chars: 200_000 });
  const valid = result.agents.find(agent => agent.agent_id === f.agentId), invalid = result.agents.find(agent => agent.agent_id === otherId);
  assert.equal(result.call_status, "settled"); assert.ok(turnText(valid).length > 0); assert.equal(invalid.status, "unavailable");
  assert.equal(invalid.cursor, null); assert.equal(Object.hasOwn(invalid, "records"), false);
  assert.equal(invalid.issues.length, 1); assert.equal(invalid.issues[0].code, "invalid_cursor");
  const records = await f.service.invoke("grok_wait", { targets: [{ agent_id: f.agentId, cursor: head }, { agent_id: otherId, cursor: "bad" }], view: "records", timeout_ms: 1000 });
  const validRecords = records.agents.find(agent => agent.agent_id === f.agentId), invalidRecords = records.agents.find(agent => agent.agent_id === otherId);
  assert.equal(records.call_status, "settled"); assert.deepEqual(validRecords.records, []); assert.equal(validRecords.status, "idle");
  assert.equal(Object.hasOwn(invalidRecords, "issues"), false);
  assert.deepEqual(invalidRecords.records.map(({ type, code }) => [type, code]), [["issue", "invalid_cursor"]]); f.store.close();
});
test("respond reserves one validated response for exact pending native attention", async () => {
  const f = fixture(), requestId = `request_${randomUUID()}`;
  const native = parseAttention("session/request_permission", { sessionId: "s", toolCall: { toolCallId: "t", title: "Read input" }, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }] });
  f.store.upsertAttention(f.claim, { ...native, request_id: requestId, status: "pending" }); const before = f.store.operations().length;
  const wrong = await call(f, "grok_respond", { request_id: requestId, response: { outcome: { outcome: "selected", optionId: "other" } } });
  assert.equal(wrong.error.code, "invalid_attention_response");
  assert.match(wrong.error.action, /response|option|request/i);
  assert.equal(Object.hasOwn(wrong.error, "operation_id"), false);
  assert.equal(f.store.getAttention(requestId).status, "pending");
  assert.equal(f.store.getAttention(requestId).response_operation_id, undefined);
  assert.equal(wrong.error.admission, "none"); assert.equal(f.store.operations().length, before);
  compact(await call(f, "grok_respond", { request_id: requestId, response: { outcome: { outcome: "selected", optionId: "allow" } } }), f.store);
  const duplicate = await call(f, "grok_respond", { request_id: requestId, response: { outcome: { outcome: "cancelled" } } });
  assert.equal(duplicate.error.code, "attention_already_responded"); assert.equal(duplicate.error.admission, "none");
  assert.equal(Object.hasOwn(duplicate.error, "operation_id"), false);
  assert.equal(f.store.operations().length, before + 1); f.store.close();
});
test("edit needs exact queue and prepared non-document inputs; active configure is task-free", async () => {
  const f = fixture(); f.store.setObservation(f.claim, "queue", { entries: [{ id: "pdf" }, { id: "image" }, { id: "unknown" }] });
  f.store.setPromptInput(f.claim, "pdf", { attachments: [{ path: join(f.cwd, "input.pdf"), kind: "pdf", mime_type: "application/pdf", bytes: 12 }] });
  f.store.setPromptInput(f.claim, "image", { attachments: [{ path: join(f.cwd, "input.png"), kind: "image", mime_type: "image/png", bytes: 12 }] });
  for (const prompt_id of ["missing", "pdf", "unknown"]) assert.equal((await call(f, "grok_send", { action: "edit", prompt_id, task: "new" })).call_status, "error");
  compact(await call(f, "grok_send", { action: "edit", prompt_id: "image", task: "new" }), f.store);
  compact(await call(f, "grok_send", { action: "configure", model: "explicit", effort: "high" }), f.store); assert.equal(f.store.operations().at(-1).kind, "configure");
  for (const input of [{ task: "new", model: "explicit" }, { action: "configure" }, { action: "configure", task: "new", effort: "high" }]) {
    const result = await call(f, "grok_send", input); assert.equal(result.error.code, "invalid_input"); assert.equal(result.error.admission, "none");
  }
  f.store.close();
});
test("summary excludes exact terminal queue identities, never unseen native activity", async () => {
  const f = fixture(); f.store.setObservation(f.claim, "queue", { entries: [{ id: "done" }], runningPromptId: "done" });
  f.store.upsertTurn(f.claim, { prompt_id: "done", status: "completed", source: "native" });
  let view = await drain(f); assert.equal(view.status, "idle"); assert.equal(view.counts.queued_prompts, 0);
  f.store.setObservation(f.claim, "queue", { entries: [{ id: "new" }], runningPromptId: "new" });
  view = await drain(f); assert.equal(view.status, "working"); assert.equal(view.counts.queued_prompts, 1); f.store.close();
});
test("close has no unread gate, blocks new work and fences late unclaimed worker", async () => {
  const f = fixture(); f.store.appendContent(f.claim, { prompt_id: "p", block_index: 0, text: "unread" });
  compact(await call(f, "grok_close"), f.store); assert.equal((await call(f, "grok_send", { task: "late" })).call_status, "error"); f.store.close();
  const delayed = fixture({ claimed: false }), closed = await call(delayed, "grok_close"); compact(closed, delayed.store); assert.equal(closed.agent.status, "closed");
  assert.throws(() => delayed.store.claim(delayed.reservation.launch.token), /fence/i); assert.equal(delayed.store.operations()[0].status, "not_sent");
  assert.equal(delayed.launches.length, 0); delayed.store.close();
});
test("read is passive; resume admits only new work after worker absence and keeps old uncertainty", async () => {
  const f = fixture({ claimed: false });
  const child = spawn(process.execPath, ["--input-type=module", "-e", `const {AgentStore}=await import(process.argv[1]);const {id,env,token,operation}=JSON.parse(process.argv[2]);const s=AgentStore.open(id,env),c=s.claim(token);s.updateOperation(c,operation,{status:'started',native_prompt_id:'old'});s.setMeta(c,{phase:'ready',native_session_id:'native-session'});s.close();`, bundle, JSON.stringify({ id: f.agentId, env: f.env, token: f.reservation.launch.token, operation: f.reservation.operation.operation_id })], { stdio: "ignore" });
  assert.equal((await once(child, "close"))[0], 0); assert.equal((await drain(f)).status, "disconnected");
  assert.equal((await f.service.invoke("grok_wait", { targets: [{ agent_id: f.agentId }], timeout_ms: 0 })).call_status, "settled"); assert.equal(f.launches.length, 0);
  assert.equal((await call(f, "grok_send", { task: "implicit" })).call_status, "error");
  compact(await call(f, "grok_send", { task: "new explicit task", resume: true }), f.store); assert.equal(f.launches.length, 1); assert.equal(f.launches[0][3], f.store.launch().token);
  assert.equal(f.store.operations()[0].status, "outcome_unknown"); assert.equal(f.store.operations()[1].input.task, "new explicit task");
  assert.equal((await call(f, "grok_send", { task: "competing", resume: true })).call_status, "error"); assert.equal(f.launches.length, 1); f.store.close();
});
test("list is summary-only with separate pagination and isolated damaged siblings", async () => {
  const f = fixture(); f.store.appendContent(f.claim, { prompt_id: "p", block_index: 0, text: "private contribution" });
  const otherId = `agent_${randomUUID()}`, other = AgentStore.create({ ...f.store.meta(), agent_id: otherId, created_at: "2000-01-01T00:00:00.000Z" }, f.env); other.close();
  const damagedId = `agent_${randomUUID()}`, damagedRoot = join(f.env.GROKPAIR_HOME, "runtime-v2", "agents", damagedId); mkdirSync(damagedRoot); writeFileSync(join(damagedRoot, "agent.sqlite"), "damaged");
  const first = await f.service.invoke("grok_list", { limit: 1 }); assert.equal(first.agents[0].agent_id, f.agentId); assert.equal(first.page.has_more, true);
  assert.equal(JSON.stringify(first).includes("private contribution"), false); assert.equal(Object.hasOwn(first.agents[0], "records"), false);
  assert.equal(Object.hasOwn(first.agents[0], "key"), false, "an unkeyed collaborator has no key");
  for (const filters of [{ include_closed: true }, { key: "other filter" }]) {
    const rebound = await f.service.invoke("grok_list", { ...filters, cursor: first.page.next_cursor });
    assert.equal(rebound.error.code, "invalid_cursor", "a list cursor is bound to the filters that produced it");
  }
  const rest = await f.service.invoke("grok_list", { cursor: first.page.next_cursor }); assert.equal(rest.agents[0].agent_id, otherId); assert.equal(rest.agents[1].status, "unavailable"); assert.equal(rest.agents[1].agent_id, damagedId); f.store.close();
});
test("root coalescing preserves message, prompt, block and nonadjacent boundaries", async () => {
  const f = fixture(); const before = (await drain(f)).cursor;
  const rows = [{ prompt_id: "p", block_index: 0, text: "a" }, { prompt_id: "p", block_index: 0, text: "b" },
    { prompt_id: "p", block_index: 1, text: "c" }, { prompt_id: "p", block_index: 0, text: "d" },
    { prompt_id: "p", block_index: 0, native_message_id: "m1", text: "e" }, { prompt_id: "p", block_index: 0, native_message_id: "m2", text: "f" },
    { prompt_id: "p", block_index: 0, native_message_id: "m1", text: "g" }, { prompt_id: "other", block_index: 0, native_message_id: "m1", text: "h" },
    { prompt_id: "p", block_index: 0, native_message_id: "m1", text: "i" }];
  for (const row of rows) f.store.appendContent(f.claim, row);
  const expected = [{ ...rows[0], text: "ab" }, ...rows.slice(2)].map(row => ({ ...row, type: "content" }));
  assert.deepEqual((await drain(f, { cursor: before })).records, expected); assert.deepEqual((await drain(f, { prompt_id: "p" })).records, expected.filter(row => row.prompt_id === "p")); f.store.close();
});
test("hundreds of fragments drain exactly and later token deltas do not wake wait", async () => {
  const f = fixture(), before = (await drain(f)).cursor;
  const fragments = [...Array(333).fill("xxx"), "😀" + "λ".repeat(2100) + "\r\n", ...Array(300).fill("尾 ")];
  for (const text of fragments) f.store.appendContent(f.claim, { prompt_id: "p", native_message_id: "m", block_index: 0, text });
  const all = await drain(f, { cursor: before, max_chars: 4000 }); assert.equal(textOf(all), fragments.join("")); assert.ok(all.records.length < 10);
  const added = "\r\ndelta😀 complete"; f.store.appendContent(f.claim, { prompt_id: "p", native_message_id: "m", block_index: 0, text: added });
  const result = await f.service.invoke("grok_wait", { targets: [{ agent_id: f.agentId, cursor: all.cursor }], timeout_ms: 0 });
  assert.equal(result.call_status, "timeout"); assert.equal(textOf(result.agents[0]), added);
  assert.deepEqual((await f.service.invoke("grok_wait", { targets: [{ agent_id: f.agentId, cursor: result.agents[0].cursor }], timeout_ms: 0 })).agents[0].records, []); f.store.close();
});

test("missing collaborator directory alone is not_found; missing database retains damaged-state diagnosis", async () => {
  const f = fixture(), missing = `agent_${randomUUID()}`, damaged = `agent_${randomUUID()}`;
  mkdirSync(join(f.env.GROKPAIR_HOME, "runtime-v2", "agents", damaged));
  for (const name of ["grok_read", "grok_send", "grok_close"]) {
    const input = name === "grok_send" ? { task: "not admitted" } : {};
    const absent = await f.service.invoke(name, { agent_id: missing, ...input });
    assert.equal(absent.error.code, "collaborator_not_found"); assert.equal(absent.error.agent_id, missing);
    assert.equal(absent.error.admission, "none"); assert.equal(Object.hasOwn(absent.error, "operation_id"), false);
    assert.match(absent.error.action, /agent_id|collaborator|list/i);
    const broken = await f.service.invoke(name, { agent_id: damaged, ...input });
    assert.notEqual(broken.error.code, "collaborator_not_found");
    assert.equal(broken.error.agent_id, damaged); assert.equal(broken.error.admission, "none");
  }
  assert.throws(() => AgentStore.open(missing, f.env));
  assert.equal(f.launches.length, 0); f.store.close();
});

test("nonexistent cwd fails before identity or operation admission", async () => {
  const f = fixture(), result = await f.service.invoke("grok_spawn", { task: "not admitted", cwd: join(f.cwd, "nonexistent") });
  assert.equal(result.call_status, "error"); assert.equal(result.error.admission, "none");
  assert.equal(Object.hasOwn(result.error, "operation_id"), false); assert.equal(Object.hasOwn(result.error, "agent_id"), false);
  assert.match(result.error.message, /existing canonical directory/); assert.equal(f.launches.length, 0); f.store.close();
});

test("transactional close race rejects with no phantom operation while confirmed and unknown retain exact IDs", async () => {
  const f = fixture(), before = f.store.operations(), admit = AgentStore.prototype.admit;
  AgentStore.prototype.admit = function (...args) {
    if (this.agentId === f.agentId) f.store.setMeta(f.claim, { phase: "closed" });
    return admit.apply(this, args);
  };
  let closed;
  try { closed = await call(f, "grok_send", { task: "racing close" }); }
  finally { AgentStore.prototype.admit = admit; }
  assert.equal(closed.error.code, "collaborator_closed"); assert.equal(closed.error.admission, "none");
  assert.equal(closed.error.agent_id, f.agentId); assert.equal(Object.hasOwn(closed.error, "operation_id"), false);
  assert.deepEqual(f.store.operations(), before); f.store.close();
  for (const unknown of [false, true]) {
    const g = fixture(), operation = AgentStore.prototype.operation; let admittedId, failLookup = false;
    AgentStore.prototype.admit = function (...args) {
      const result = admit.apply(this, args);
      if (this.agentId === g.agentId) { admittedId = result.operation_id; failLookup = unknown; throw new Error("fixture lost admission receipt"); }
      return result;
    };
    AgentStore.prototype.operation = function (...args) {
      if (this.agentId === g.agentId && failLookup && args[0] === admittedId) throw new Error("fixture unavailable outcome lookup");
      return operation.apply(this, args);
    };
    let result;
    try { result = await call(g, "grok_send", { task: "exact newly admitted input" }); }
    finally { AgentStore.prototype.admit = admit; AgentStore.prototype.operation = operation; }
    assert.equal(result.error.admission, unknown ? "unknown" : "confirmed");
    assert.equal(result.error.operation_id, admittedId); assert.equal(result.error.agent_id, g.agentId);
    assert.equal(g.store.operation(admittedId).input.task, "exact newly admitted input");
    assert.equal(g.store.operations().length, 2); assert.equal(g.launches.length, 0); g.store.close();
  }
});

test("native capabilities wake once, remain exact and unscoped, and reuse a gp1 records cursor across reopen", async () => {
  const f = fixture(), baseline = (await drain(f)).cursor;
  assert.match(baseline, /^gp1\.(?!list\.)/u);
  const payload = { protocol_version: 1, agent_info: { name: "native", version: "exact", _meta: { future: null } },
    capabilities: { promptCapabilities: { image: false, audio: true }, loadSession: false, _meta: { arbitrary: [false, null] } } };
  f.store.setObservation(f.claim, "native_capabilities", payload);
  const first = await f.service.invoke("grok_wait", { targets: [{ agent_id: f.agentId, cursor: baseline }], timeout_ms: 0 });
  assert.equal(first.schema_version, "3"); assert.equal(first.call_status, "settled");
  assert.deepEqual(of(first.agents[0], "native_capabilities"), [{ ...payload, type: "native_capabilities" }]);
  f.store.setObservation(f.claim, "native_capabilities", structuredClone(payload));
  const unchanged = await f.service.invoke("grok_wait", { targets: [{ agent_id: f.agentId, cursor: first.agents[0].cursor }], timeout_ms: 0 });
  assert.equal(unchanged.call_status, "timeout"); assert.deepEqual(unchanged.agents[0].records, []);
  f.store.appendContent(f.claim, { prompt_id: "native:prompt", block_index: 0, text: "contribution" });
  const filtered = await drain(f, { prompt_id: "native:prompt" });
  assert.equal(of(filtered, "native_capabilities").length, 0); assert.equal(textOf(filtered), "contribution");
  assert.deepEqual(of(await drain(f), "native_capabilities"), [{ ...payload, type: "native_capabilities" }]);
  f.store.setObservation(f.claim, "native_capabilities", { protocol_version: 2 });
  const changedCursor = unchanged.agents[0].cursor;
  f.store.close();
  const changed = await drain(f, { cursor: changedCursor });
  assert.deepEqual(of(changed, "native_capabilities"), [{ type: "native_capabilities", protocol_version: 2 }]);
  assert.match(changed.cursor, /^gp1\.(?!list\.)/u); assert.equal(f.launches.length, 0);
});

test("large native capabilities are reconstructed without skipping later text or files", async () => {
  const f = fixture(), cursor = (await drain(f)).cursor;
  const payload = { protocol_version: 1, capabilities: { _meta: { extension: "😀 exact\r\n".repeat(5000) } } };
  f.store.setObservation(f.claim, "native_capabilities", payload);
  f.store.appendContent(f.claim, { prompt_id: "p", block_index: 0, text: "after native capabilities" });
  for (let index = 0; index < 70; index++) f.store.upsertFile(f.claim, { path: `/native/${index}` });
  const first = await call(f, "grok_read", { cursor, max_chars: 2000 });
  assert.equal(first.call_status, "ok", JSON.stringify(first));
  assert.ok(JSON.stringify(first).length <= 2000); assert.equal(Object.hasOwn(first.agent, "oversized"), false);
  assert.equal(first.agent.fragments[0].record_type, "native_capabilities"); assert.equal(first.agent.fragments[0].complete, false);
  const rest = await drain(f, { cursor, max_chars: 2000 });
  assert.equal(textOf(rest), "after native capabilities"); assert.equal(of(rest, "file").length, 70);
  assert.deepEqual(of(rest, "native_capabilities"), [{ ...payload, type: "native_capabilities" }]);
  assert.deepEqual((await drain(f, { cursor: rest.cursor })).records, []); f.store.close();
});

test("cancelled attention projects exact expiry and rejects late answer without a new operation", async () => {
  const f = fixture(), request_id = `request_${randomUUID()}`, prompt_id = "cancelled:attention";
  const native = parseAttention("session/request_permission", { sessionId: "s", toolCall: { toolCallId: "native:t", title: "Exact request" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] });
  f.store.upsertAttention(f.claim, { ...native, request_id, prompt_id, status: "pending" });
  const before = (await drain(f)).cursor;
  f.store.upsertTurn(f.claim, { prompt_id, status: "cancelled", source: "turn_completed" });
  const view = await drain(f, { cursor: before });
  assert.equal(view.counts.pending_attention, 0); assert.notEqual(view.status, "attention");
  const attention = of(view, "attention")[0];
  assert.equal(attention.request_id, request_id); assert.equal(attention.prompt_id, prompt_id);
  assert.equal(attention.status, "expired"); assert.equal(attention.reason, "prompt_cancelled"); assert.deepEqual(attention.payload, native.payload);
  const operations = f.store.operations();
  const result = await call(f, "grok_respond", { request_id, response: { outcome: { outcome: "selected", optionId: "allow" } } });
  assert.equal(result.error.code, "attention_not_pending"); assert.equal(result.error.admission, "none");
  assert.equal(Object.hasOwn(result.error, "operation_id"), false); assert.deepEqual(f.store.operations(), operations); f.store.close();
});

test("attention cancellation racing validated response admission leaves none and preserves expired request", async () => {
  const f = fixture(), request_id = `request_${randomUUID()}`, prompt_id = "native:cancel-race";
  const native = parseAttention("session/request_permission", { sessionId: "s", toolCall: { toolCallId: "t" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] });
  f.store.upsertAttention(f.claim, { ...native, request_id, prompt_id, status: "pending" });
  const operations = f.store.operations(), admit = AgentStore.prototype.admit;
  AgentStore.prototype.admit = function (...args) {
    if (this.agentId === f.agentId) f.store.upsertTurn(f.claim, { prompt_id, status: "cancelled", source: "prompt_response" });
    return admit.apply(this, args);
  };
  let result;
  try { result = await call(f, "grok_respond", { request_id, response: { outcome: { outcome: "selected", optionId: "allow" } } }); }
  finally { AgentStore.prototype.admit = admit; }
  assert.equal(result.error.code, "attention_not_pending"); assert.equal(result.error.admission, "none");
  assert.equal(Object.hasOwn(result.error, "operation_id"), false); assert.deepEqual(f.store.operations(), operations);
  assert.equal(f.store.getAttention(request_id).status, "expired");
  assert.equal(f.store.getAttention(request_id).response_operation_id, undefined); f.store.close();
});

test("pending close is an actionable collaborator_closing rejection without a phantom operation", async () => {
  const f = fixture(); compact(await call(f, "grok_close"), f.store); const before = f.store.operations();
  const rejected = await call(f, "grok_send", { task: "cannot enter closing collaborator" });
  assert.equal(rejected.error.code, "collaborator_closing"); assert.equal(rejected.error.admission, "none");
  assert.equal(Object.hasOwn(rejected.error, "operation_id"), false); assert.deepEqual(f.store.operations(), before); f.store.close();
});

test("connected quiet with unknown queue is ready, not idle; observed empty establishes idle", async () => {
  const f = fixture({ queueObserved: false });
  let view = await drain(f);
  assert.equal(view.status, "ready"); assert.equal(view.counts.queued_prompts, null);
  assert.equal(view.queue_observation.status, "unknown"); assert.equal(typeof view.queue_observation.reason, "string");
  assert.ok(view.queue_observation.reason.length > 0);
  const unknownCursor = view.cursor;
  f.store.setObservation(f.claim, "queue", { entries: [] });
  const changed = await f.service.invoke("grok_wait", { targets: [{ agent_id: f.agentId, cursor: unknownCursor }], timeout_ms: 0 });
  assert.equal(changed.call_status, "settled");
  view = changed.agents[0]; assert.equal(view.status, "idle"); assert.equal(view.counts.queued_prompts, 0);
  assert.deepEqual(view.queue_observation, { status: "observed" });
  f.store.setObservation(f.claim, "queue", { unavailable: true, reason: "Native queue is no longer observed" });
  view = await drain(f);
  assert.equal(view.status, "ready"); assert.equal(view.counts.queued_prompts, null);
  assert.deepEqual(view.queue_observation, { status: "unknown", reason: "Native queue is no longer observed" });
  assert.equal(f.launches.length, 0); f.store.close();
});

test("read accepts a page beyond the former max_chars cap and long exact IDs survive cursor reuse", async () => {
  const f = fixture(), before = (await drain(f)).cursor, text = "λ".repeat(600_000);
  f.store.appendContent(f.claim, { prompt_id: "large-page", block_index: 0, text });
  const large = await call(f, "grok_read", { cursor: before, max_chars: 700_000 });
  assert.equal(large.call_status, "ok"); assert.equal(textOf(large.agent), text); assert.equal(large.agent.has_more, false);
  const prompt_id = "native:prompt:" + "p".repeat(24_000), native_message_id = "native:message:" + "m".repeat(12_000);
  const longText = "exact 😀\r\n".repeat(10_000);
  f.store.appendContent(f.claim, { prompt_id, native_message_id, block_index: 0, text: longText });
  const first = await call(f, "grok_read", { view: "records", prompt_id, max_chars: 80_000 });
  assert.equal(first.call_status, "ok"); assert.ok(first.agent.cursor.length > 16_384); assert.equal(first.agent.has_more, true);
  const rest = await drain(f, { cursor: first.agent.cursor, max_chars: 80_000 });
  assert.equal(textOf(first.agent) + textOf(rest), longText);
  for (const row of [...first.agent.records, ...rest.records]) {
    assert.equal(row.prompt_id, prompt_id); assert.equal(row.native_message_id, native_message_id);
  }
  const unchanged = await f.service.invoke("grok_wait", { targets: [{ agent_id: f.agentId, cursor: rest.cursor }], timeout_ms: 0, max_chars: 700_000 });
  assert.equal(unchanged.call_status, "timeout"); assert.deepEqual(unchanged.agents[0].records, []); f.store.close();
});

test("list supports more than 100 entries and wait supports more than eight distinct collaborators", async () => {
  const f = fixture(), identities = [f.agentId];
  for (let index = 0; index < 109; index++) {
    const agent_id = `agent_${randomUUID()}`;
    const store = AgentStore.create({ ...f.store.meta(), agent_id }, f.env); store.close(); identities.push(agent_id);
  }
  const listed = await f.service.invoke("grok_list", { limit: 110 });
  assert.equal(listed.call_status, "ok"); assert.equal(listed.agents.length, 110); assert.equal(listed.page.has_more, false);
  assert.deepEqual(new Set(listed.agents.map(agent => agent.agent_id)), new Set(identities));
  const targets = identities.slice(0, 11).map(agent_id => ({ agent_id }));
  const waited = await f.service.invoke("grok_wait", { targets, timeout_ms: 0 });
  assert.equal(waited.call_status, "settled"); assert.equal(waited.agents.length, targets.length);
  assert.deepEqual(waited.agents.map(agent => agent.agent_id), targets.map(target => target.agent_id));
  assert.equal(waited.agents.some(agent => agent.status === "unavailable"), false);
  assert.equal(f.launches.length, 0); f.store.close();
});

test("more than 128 issues survive retention and a huge diagnostic is wholly reconstructible", async () => {
  const f = fixture(), before = (await drain(f)).cursor;
  for (let index = 0; index < 160; index++) f.store.issue(f.claim, { code: `native_issue_${index}`, message: `Exact failure ${index}` });
  const huge = { code: "native_code:" + "C".repeat(20_000), message: "Native diagnostic\r\n".repeat(40_000),
    title: "title:" + "T".repeat(12_000), tool_call_id: "native-tool:" + "I".repeat(12_000),
    diagnostics: Array.from({ length: 12 }, (_, index) => ({ source: `error.causes[${index}].message`, message: `Cause ${index}: ${"D".repeat(5000)}` })) };
  f.store.issue(f.claim, huge);
  const all = await drain(f, { cursor: before, max_chars: 4000 }), issues = of(all, "issue");
  assert.equal(issues.length, 161);
  assert.deepEqual(issues.slice(0, 160).map(issue => issue.code), Array.from({ length: 160 }, (_, index) => `native_issue_${index}`));
  assert.deepEqual(issues.at(-1), { type: "issue", ...huge });
  assert.deepEqual((await drain(f, { cursor: all.cursor })).records, []); f.store.close();
});

test("explicit queued interrupt captures its exact version and rejects running, missing and unknown targets", async () => {
  const f = fixture(), prompt_id = "queued:" + "p".repeat(12_000);
  f.store.setObservation(f.claim, "queue", { entries: [{ id: prompt_id, version: 7 }, { id: "no-version" }], runningPromptId: "running" });
  const accepted = await call(f, "grok_interrupt", { prompt_id }); compact(accepted, f.store);
  const operation = f.store.operation(accepted.operation_id);
  assert.deepEqual(operation.input.queue_target, { id: prompt_id, version: 7 });
  f.store.setObservation(f.claim, "queue", { entries: [{ id: prompt_id, version: 8 }, { id: "no-version" }], runningPromptId: "running" });
  assert.deepEqual(f.store.operation(accepted.operation_id).input.queue_target, { id: prompt_id, version: 7 }, "admitted removal never refreshes to a newer queued version");
  for (const [target, code] of [["running", "prompt_running"], ["missing", "prompt_not_queued"], ["no-version", "queue_version_unknown"]]) {
    const before = f.store.operations();
    const rejected = await call(f, "grok_interrupt", { prompt_id: target });
    assert.equal(rejected.error.code, code); assert.equal(rejected.error.admission, "none");
    assert.equal(Object.hasOwn(rejected.error, "operation_id"), false); assert.deepEqual(f.store.operations(), before);
  }
  f.store.setObservation(f.claim, "queue", { unavailable: true, reason: "No current native snapshot" });
  const before = f.store.operations(), rejected = await call(f, "grok_interrupt", { prompt_id });
  assert.equal(rejected.error.code, "queue_not_observed"); assert.equal(rejected.error.admission, "none");
  assert.deepEqual(f.store.operations(), before);
  const stop = await call(f, "grok_interrupt"); compact(stop, f.store);
  assert.equal(Object.hasOwn(f.store.operation(stop.operation_id).input, "queue_target"), false);
  f.store.close();
});

test("queued-to-running race rejects interrupt transactionally without reserving a phantom operation", async () => {
  const f = fixture(), prompt_id = "native:queued-to-running";
  f.store.setObservation(f.claim, "queue", { entries: [{ id: prompt_id, version: 3 }] });
  const before = f.store.operations(), admit = AgentStore.prototype.admit;
  AgentStore.prototype.admit = function (...args) {
    if (this.agentId === f.agentId && args[0] === "interrupt") {
      f.store.setObservation(f.claim, "queue", { entries: [], runningPromptId: prompt_id });
      f.store.upsertTurn(f.claim, { prompt_id, status: "running", source: "native" });
    }
    return admit.apply(this, args);
  };
  let result;
  try { result = await call(f, "grok_interrupt", { prompt_id }); }
  finally { AgentStore.prototype.admit = admit; }
  assert.equal(result.error.code, "prompt_running"); assert.equal(result.error.admission, "none");
  assert.equal(Object.hasOwn(result.error, "operation_id"), false); assert.deepEqual(f.store.operations(), before);
  assert.equal(f.store.turn(prompt_id).status, "running"); assert.equal(f.launches.length, 0); f.store.close();
});

/** Another resident collaborator in the same runtime, claimed by this process. */
function sibling(f, { text } = {}) {
  const meta = { agent_id: `agent_${randomUUID()}`, cwd: f.cwd, worktree: false, sandbox_argument: null, execution_cwd: null, created_at: new Date().toISOString(), phase: "opening" };
  const store = AgentStore.create(meta, f.env);
  const reservation = store.admitLaunch({ task: "initial" }, { operation_id: `operation_${randomUUID()}`, resume: false });
  const claim = store.claim(reservation.launch.token);
  store.updateOperation(claim, reservation.operation.operation_id, { status: "started" });
  store.updateOperation(claim, reservation.operation.operation_id, { status: "completed" });
  store.setMeta(claim, { phase: "ready" }); store.setObservation(claim, "queue", { entries: [] });
  if (text !== undefined) store.appendContent(claim, { prompt_id: "p", block_index: 0, block_start: true, text });
  return { store, claim, agentId: meta.agent_id };
}

test("result view groups a page by turn, separates native blocks and keeps only what the caller acts on", async () => {
  const f = fixture(), s = f.store, c = f.claim;
  const before = (await drainResult(f)).at(-1).cursor, recordsBefore = (await drain(f)).cursor;
  const settle = (kind, input, patches) => {
    const op = s.admit(kind, input);
    for (const patch of patches) s.updateOperation(c, op.operation_id, patch);
    return s.operation(op.operation_id);
  };
  const sent = settle("follow_up", { task: "a" }, [{ status: "started", native_prompt_id: "pA" }, { status: "completed", result: { stop_reason: "end_turn" } }]);
  const failed = settle("send_now", { task: "b" }, [{ status: "started", native_prompt_id: "pB" }, { status: "failed", error: { code: "native_rejected" } }]);
  const quiet = [
    settle("configure", { model: "m" }, [{ status: "started" }, { status: "completed" }]),
    settle("interrupt", {}, [{ status: "started" }, { status: "completed" }]),
    settle("steer", { task: "s" }, [{ status: "started" }, { status: "completed" }]),
    settle("follow_up", { task: "queued" }, []),
    settle("follow_up", { task: "running" }, [{ status: "started" }]),
  ];
  const unknown = settle("follow_up", { task: "uncertain" }, [{ status: "started", native_prompt_id: "pU" }, { status: "outcome_unknown" }]);
  const unsent = settle("follow_up", { task: "never" }, [{ status: "not_sent" }]);
  const side = settle("side_question", { task: "q" }, [{ status: "started" }, { status: "completed", result: { side_answer: true } }]);
  quiet.push(sent, side);
  for (const row of [
    { prompt_id: "pA", native_message_id: "m0", block_index: 0, block_start: true, text: "Hello" },
    { prompt_id: "pA", native_message_id: "m0", block_index: 0, text: " world" },
    { prompt_id: "pB", native_message_id: "mB", block_index: 0, block_start: true, text: "B text" },
    { prompt_id: "pA", native_message_id: "m1", block_index: 1, block_start: true, text: "Second" },
    { prompt_id: "pA", native_message_id: "m1", block_index: 1, text: " block" },
    { prompt_id: "native-origin", block_index: 0, block_start: true, text: "native" },
  ]) s.appendContent(c, row);
  s.upsertTurn(c, { prompt_id: "pA", status: "completed", source: "prompt_response", stop_reason: "end_turn" });
  s.upsertTurn(c, { prompt_id: "pB", status: "cancelled", source: "prompt_response", stop_reason: "cancelled" });
  s.upsertTurn(c, { prompt_id: "native-origin", status: "running", source: "live_update" });
  s.appendSideAnswer(c, { operation_id: side.operation_id, text: "side reply" });
  s.upsertAttention(c, { request_id: "request-pending", method: "_x.ai/exit_plan_mode", payload: { planContent: "exact" }, status: "pending" });
  s.upsertAttention(c, { request_id: "request-resolved", method: "_x.ai/exit_plan_mode", payload: {}, status: "pending" });
  s.resolveAttention(c, "request-resolved", { response: { outcome: "approved" } });
  s.upsertAttention(c, { request_id: "request-expired", method: "_x.ai/exit_plan_mode", payload: {}, status: "expired", reason: "interaction_resolved" });
  const file = s.upsertFile(c, { path: "/native/out.png", prompt_id: "pA" });
  s.issue(c, { code: "native_tool_failed", message: "exact" });
  s.upsertObservation(c, "background", "task-1", { task_id: "task-1", status: "running" });
  s.setObservation(c, "queue", { entries: [{ id: "q1", version: 0 }] });
  s.setObservation(c, "native_options", { options: [{ id: "model" }] });
  s.setObservation(c, "native_capabilities", { protocol_version: 1 });
  s.upsertObservation(c, "elicitation_completion", "e1", { method: "elicitation/complete", payload: {} });

  const page = (await call(f, "grok_read", { cursor: before, max_chars: 500_000 })).agent;
  assert.equal(page.has_more, false);
  assert.deepEqual(page.turns, [
    { prompt_id: "pA", operation_id: sent.operation_id, status: "completed", stop_reason: "end_turn", text: "Hello world\n\nSecond block", text_file: s.turnFile("pA") },
    { prompt_id: "pB", operation_id: failed.operation_id, status: "cancelled", stop_reason: "cancelled", text: "B text", text_file: s.turnFile("pB") },
    { prompt_id: "native-origin", status: "running", text: "native" },
  ]);
  // A running turn has no file yet; a stopped one keeps its operation and brief in front matter.
  assert.equal(s.turnFile("native-origin"), null);
  assert.match(readFileSync(s.turnFile("pA"), "utf8"), new RegExp(`^---\\n[^]*\\noperation_id: "${sent.operation_id}"\\n[^]*\\ntask: "[^"]*"\\n---\\n\\nHello world\\n\\nSecond block\\n$`, "u"));
  // The records view carries the same file on its turn records.
  const recordsTurn = (await call(f, "grok_read", { cursor: recordsBefore, max_chars: 500_000 })).agent.records.find(row => row.type === "turn" && row.prompt_id === "pA");
  assert.equal(recordsTurn.text_file, s.turnFile("pA"));
  assert.deepEqual(page.side_answers, [{ operation_id: side.operation_id, text: "side reply" }]);
  assert.deepEqual(page.attention.map(item => [item.request_id, item.status]), [["request-pending", "pending"], ["request-expired", "expired"]]);
  assert.deepEqual(page.attention[0].payload, { planContent: "exact" });
  assert.deepEqual(page.files, [file]);
  assert.deepEqual(page.issues, [{ code: "native_tool_failed", message: "exact" }]);
  assert.deepEqual(page.operations.map(op => [op.operation_id, op.kind, op.status]),
    [[failed.operation_id, "send_now", "failed"], [unknown.operation_id, "follow_up", "outcome_unknown"], [unsent.operation_id, "follow_up", "not_sent"]]);
  assert.deepEqual(page.operations[0].error, { code: "native_rejected" });
  assert.equal(page.operations.some(op => Object.hasOwn(op, "input") || Object.hasOwn(op, "type")), false);
  assert.deepEqual(page.background, [{ task_id: "task-1", status: "running" }]);
  for (const key of ["records", "queue", "native_options", "native_capabilities", "elicitation_completion", "content", "turn", "side_answer", "operation", "file", "issue"]) {
    assert.equal(Object.hasOwn(page, key), false, key);
  }

  // The records view of the same range keeps everything, strips the private block marker and coalesces chunks.
  const records = (await call(f, "grok_read", { cursor: recordsBefore, max_chars: 500_000 })).agent.records;
  assert.deepEqual(new Set(records.map(row => row.type)), new Set(["operation", "content", "turn", "side_answer", "attention", "file", "issue", "background", "queue", "native_options", "native_capabilities", "elicitation_completion"]));
  const operationIds = new Set(records.filter(row => row.type === "operation").map(row => row.operation_id));
  for (const op of [...quiet, failed, unknown, unsent]) assert.ok(operationIds.has(op.operation_id), op.kind + " " + op.status);
  assert.ok(records.some(row => row.type === "attention" && row.status === "resolved"));
  const content = records.filter(row => row.type === "content");
  assert.deepEqual(content.map(row => row.text), ["Hello world", "B text", "Second block", "native"]);
  assert.equal(content.some(row => Object.hasOwn(row, "block_start")), false);
  assert.equal(s.records({ limit: 1000 }).filter(row => row.type === "content" && row.value.block_start === true).length, 4, "the store keeps the block marker");
  f.store.close();
});

test("result pages rebuild every turn exactly across Unicode splits without repeating block separators", async () => {
  const f = fixture(), s = f.store, c = f.claim, before = (await drainResult(f)).at(-1).cursor;
  const first = "x".repeat(999) + "😀" + "λ".repeat(1500), second = "😀".repeat(700) + "\r\n", other = "other " + "y".repeat(1200);
  for (const row of [
    { prompt_id: "p1", native_message_id: "m0", block_index: 0, block_start: true, text: first.slice(0, 500) },
    { prompt_id: "p1", native_message_id: "m0", block_index: 0, text: first.slice(500) },
    { prompt_id: "p2", native_message_id: "n0", block_index: 0, block_start: true, text: other },
    { prompt_id: "p1", native_message_id: "m1", block_index: 1, block_start: true, text: second },
    { prompt_id: "p1", native_message_id: "m2", block_index: 2, block_start: true, text: "tail" },
    { prompt_id: "p1", native_message_id: "m2", block_index: 2, text: " λ" },
  ]) s.appendContent(c, row);
  const texts = {}, pages = await drainResult(f, { cursor: before, max_chars: 2000 });
  for (const page of pages) for (const turn of page.turns ?? []) {
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(turn.text), "no page splits a surrogate pair");
    texts[turn.prompt_id] = (texts[turn.prompt_id] ?? "") + turn.text;
  }
  assert.deepEqual(texts, { p1: `${first}\n\n${second}\n\ntail λ`, p2: other });
  assert.ok(pages.length > 1); assert.ok(pages.filter(page => page.turns?.some(turn => turn.prompt_id === "p1")).length > 1); f.store.close();
});

test("records the result view omits spend no budget or record count, and an omitted tail is drained", async () => {
  const f = fixture(), s = f.store, c = f.claim;
  const before = (await drainResult(f)).at(-1).cursor, recordsBefore = (await drain(f)).cursor;
  s.setObservation(c, "queue", { entries: [{ id: "queued", text: "q".repeat(50_000) }] });
  s.setObservation(c, "native_options", { options: [{ id: "model", description: "o".repeat(50_000) }] });
  s.setObservation(c, "native_capabilities", { protocol_version: 1, capabilities: { _meta: { large: "c".repeat(50_000) } } });
  s.appendContent(c, { prompt_id: "p", block_index: 0, block_start: true, text: "useful text" });
  for (let index = 0; index < 200; index++) s.upsertObservation(c, "elicitation_completion", `e${index}`, { method: "elicitation/complete", payload: { index } });
  const page = (await call(f, "grok_read", { cursor: before, max_chars: 2000 })).agent;
  assert.deepEqual(page.turns, [{ prompt_id: "p", text: "useful text" }]);
  assert.equal(page.oversized, undefined);
  assert.equal(page.has_more, false, "a tail of omitted records is drained, not reported as more");
  const recordsResult = await call(f, "grok_read", { cursor: recordsBefore, max_chars: 2000 }), records = recordsResult.agent;
  assert.ok(JSON.stringify(recordsResult).length <= 2000);
  assert.equal(Object.hasOwn(records, "oversized"), false);
  assert.equal(records.fragments[0].record_type, "queue", "the records view pays for observations through fragments");
  const again = (await call(f, "grok_read", { cursor: page.cursor, max_chars: 2000 })).agent;
  assert.equal(again.has_more, false);
  for (const key of ["turns", "operations", "files", "issues", "attention", "side_answers", "background"]) assert.equal(Object.hasOwn(again, key), false, key);
  assert.equal((await f.service.invoke("grok_wait", { targets: [{ agent_id: f.agentId, cursor: page.cursor }], timeout_ms: 0 })).call_status, "timeout");
  for (let index = 200; index < 400; index++) s.upsertObservation(c, "elicitation_completion", `e${index}`, { method: "elicitation/complete", payload: { index } });
  const file = s.upsertFile(c, { path: "/native/after-omitted" });
  const next = (await call(f, "grok_read", { cursor: page.cursor, max_chars: 2000 })).agent;
  assert.deepEqual(next.files, [file], "an included record after hundreds of omitted ones is reached in the same page");
  assert.equal(next.has_more, false);
  f.store.close();
});

test("a cursor keeps its view and prompt filter; any mismatch is invalid_cursor", async () => {
  const f = fixture(), s = f.store, c = f.claim;
  s.appendContent(c, { prompt_id: "p1", block_index: 0, block_start: true, text: "one" });
  s.appendContent(c, { prompt_id: "p2", block_index: 0, block_start: true, text: "two" });
  const result = (await call(f, "grok_read")).agent, records = (await call(f, "grok_read", { view: "records" })).agent;
  assert.equal(Object.hasOwn(result, "records"), false); assert.ok(Array.isArray(records.records));
  for (const [cursor, view] of [[result.cursor, "records"], [records.cursor, "result"]]) {
    const rejected = await call(f, "grok_read", { cursor, view });
    assert.equal(rejected.error.code, "invalid_cursor"); assert.equal(rejected.error.admission, "none");
  }
  s.appendContent(c, { prompt_id: "p1", block_index: 0, text: " more" });
  const keptResult = (await call(f, "grok_read", { cursor: result.cursor })).agent;
  assert.deepEqual(keptResult.turns, [{ prompt_id: "p1", text: " more" }]); assert.equal(Object.hasOwn(keptResult, "records"), false);
  const keptRecords = (await call(f, "grok_read", { cursor: records.cursor })).agent;
  assert.deepEqual(keptRecords.records.map(({ type, text }) => [type, text]), [["content", " more"]]);
  const selected = (await call(f, "grok_read", { prompt_id: "p1" })).agent;
  assert.deepEqual(selected.turns, [{ prompt_id: "p1", text: "one more" }]);
  for (const input of [{ prompt_id: "p2" }, { view: "records" }]) assert.equal((await call(f, "grok_read", { cursor: selected.cursor, ...input })).error.code, "invalid_cursor");
  s.appendContent(c, { prompt_id: "p2", block_index: 0, text: " filtered out" });
  s.appendContent(c, { prompt_id: "p1", native_message_id: "m1", block_index: 1, block_start: true, text: "next" });
  assert.deepEqual((await call(f, "grok_read", { cursor: selected.cursor })).agent.turns, [{ prompt_id: "p1", text: "\n\nnext" }],
    "a page that begins a later block carries its separator, so pages concatenate");
  const waited = await f.service.invoke("grok_wait", { targets: [{ agent_id: f.agentId, cursor: records.cursor }], view: "result", timeout_ms: 0 });
  assert.equal(waited.agents[0].status, "unavailable"); assert.equal(waited.agents[0].issues[0].code, "invalid_cursor");
  const other = sibling(f); other.store.close();
  const listed = await f.service.invoke("grok_list", { limit: 1 }); assert.equal(listed.page.has_more, true);
  assert.equal((await call(f, "grok_read", { cursor: listed.page.next_cursor })).error.code, "invalid_cursor");
  assert.equal((await f.service.invoke("grok_list", { limit: 1, cursor: result.cursor })).error.code, "invalid_cursor");
  f.store.close();
});

test("wait until settled returns only for a settled target with something new; until change returns on any wake", async () => {
  const f = fixture(), s = f.store, c = f.claim;
  s.upsertTurn(c, { prompt_id: "p", status: "running", source: "live_update" });
  const uncursored = performance.now(), first = await f.service.invoke("grok_wait", { targets: [{ agent_id: f.agentId }], until: "change", timeout_ms: 5000 });
  assert.equal(first.call_status, "changed", "without a cursor everything retained is new"); assert.equal(first.agents[0].status, "working");
  assert.ok(performance.now() - uncursored < 2500);
  let cursor = (await drainResult(f)).at(-1).cursor;
  const wait = async (until, timeout_ms, event) => {
    const timer = setTimeout(event, 20), start = performance.now();
    try {
      const result = await f.service.invoke("grok_wait", { targets: [{ agent_id: f.agentId, cursor }], ...(until ? { until } : {}), timeout_ms });
      cursor = result.agents[0].cursor; return { result, elapsed: performance.now() - start };
    } finally { clearTimeout(timer); }
  };
  const working = await wait(undefined, 250, () => s.upsertFile(c, { path: "/native/while-working" }));
  assert.equal(working.result.call_status, "timeout"); assert.ok(working.elapsed >= 240, "a change while working does not settle");
  assert.equal(working.result.agents[0].status, "working"); assert.deepEqual(working.result.agents[0].files.map(file => file.path), ["/native/while-working"]);
  const changed = await wait("change", 5000, () => s.upsertFile(c, { path: "/native/second" }));
  assert.equal(changed.result.call_status, "changed"); assert.ok(changed.elapsed < 2500); assert.equal(changed.result.agents[0].status, "working");
  const attention = await wait("settled", 5000, () => s.upsertAttention(c, { request_id: "request-q", method: "_x.ai/exit_plan_mode", payload: {}, status: "pending", prompt_id: "p" }));
  assert.equal(attention.result.call_status, "settled"); assert.equal(attention.result.agents[0].status, "attention");
  s.resolveAttention(c, "request-q", { response: { outcome: "approved" } });
  const done = await wait("settled", 5000, () => s.upsertTurn(c, { prompt_id: "p", status: "completed", source: "prompt_response", stop_reason: "end_turn" }));
  assert.equal(done.result.call_status, "settled"); assert.equal(done.result.agents[0].status, "idle");
  const stale = await wait("settled", 150, () => {});
  assert.equal(stale.result.call_status, "timeout", "idle with nothing new since the cursor is not a result");
  assert.ok(stale.elapsed >= 140);
  const fresh = await f.service.invoke("grok_wait", { targets: [{ agent_id: f.agentId }], timeout_ms: 5000 });
  assert.equal(fresh.call_status, "settled", "without a cursor an idle collaborator settles at once");
  // One settled target with news settles the call even while a sibling keeps working.
  const busy = sibling(f); busy.store.upsertTurn(busy.claim, { prompt_id: "b", status: "running", source: "live_update" });
  const busyCursor = (await f.service.invoke("grok_read", { agent_id: busy.agentId })).agent.cursor;
  const timer = setTimeout(() => busy.store.upsertFile(busy.claim, { path: "/native/busy" }), 20);
  const mixed = await f.service.invoke("grok_wait", { targets: [{ agent_id: f.agentId, cursor }, { agent_id: busy.agentId, cursor: busyCursor }], timeout_ms: 250 });
  clearTimeout(timer);
  assert.equal(mixed.call_status, "timeout"); assert.deepEqual(mixed.agents[1].files.map(file => file.path), ["/native/busy"]);
  busy.store.close(); f.store.close();
});

test("wait fits one aggregate max_chars budget and delivers only pages whose cursors the caller can keep", async () => {
  const f = fixture(), text = "a".repeat(20_000); f.store.appendContent(f.claim, { prompt_id: "p", block_index: 0, block_start: true, text });
  const other = sibling(f, { text });
  const one = await f.service.invoke("grok_wait", { targets: [{ agent_id: f.agentId }], max_chars: 10_000, timeout_ms: 0 });
  assert.ok(turnText(one.agents[0]).length > 9_000);
  const two = await f.service.invoke("grok_wait", { targets: [{ agent_id: f.agentId }, { agent_id: other.agentId }], max_chars: 10_000, timeout_ms: 0 });
  assert.ok(JSON.stringify(two).length <= 10_000);
  assert.ok(two.agents.length >= 1 && two.agents.length <= 2);
  assert.equal(two.agents[0].agent_id, f.agentId, "the triggering target is delivered");
  assert.ok(turnText(two.agents[0]).length > 3_000); assert.equal(two.agents[0].has_more, true);
  for (const agent of two.agents) assert.ok([f.agentId, other.agentId].includes(agent.agent_id));
  other.store.close(); f.store.close();
});

test("keyed spawn retries the same request, releases only on close and retains unverifiable holders", async () => {
  const f = fixture(), agents = join(f.env.GROKPAIR_HOME, "runtime-v2", "agents");
  const spawnKeyed = (key, task = "keyed work") => f.service.invoke("grok_spawn", { task, cwd: f.cwd, key });
  const rejected = await f.service.invoke("grok_spawn", { task: "refused", cwd: "/", key: "review:1" });
  assert.equal(rejected.error.admission, "none");
  const first = await spawnKeyed("review:1"); compact(first); assert.equal(first.agent.key, "review:1"); assert.equal(f.launches.length, 1);
  assert.equal(statSync(join(f.env.GROKPAIR_HOME, "runtime-v2", "keys.sqlite")).mode & 0o777, 0o600, "keys live privately in the runtime store");
  const again = await spawnKeyed("review:1");
  assert.deepEqual(Object.keys(again).sort(), ["agent", "agent_id", "call_status", "schema_version"]);
  assert.equal(again.call_status, "existing"); assert.equal(again.agent_id, first.agent_id);
  assert.equal(again.agent.agent_id, first.agent_id); assert.equal(again.agent.key, "review:1"); assert.equal(again.agent.status, "starting");
  assert.equal(f.launches.length, 1, "an existing holder admits and launches nothing");
  const holder = AgentStore.open(first.agent_id, f.env, { readonly: true });
  assert.deepEqual(holder.operations().map(op => op.input.task), ["keyed work"]); holder.close();
  const second = await spawnKeyed("review:2"); compact(second); assert.notEqual(second.agent_id, first.agent_id);
  const ids = result => result.agents.map(agent => agent.agent_id);
  assert.deepEqual(ids(await f.service.invoke("grok_list", { key: "review:1" })), [first.agent_id]);
  assert.deepEqual(new Set(ids(await f.service.invoke("grok_list", {}))), new Set([f.agentId, first.agent_id, second.agent_id]));
  compact(await f.service.invoke("grok_close", { agent_id: first.agent_id }));
  assert.deepEqual(ids(await f.service.invoke("grok_list", { key: "review:1" })), [], "closed collaborators are listed only with include_closed");
  assert.equal(ids(await f.service.invoke("grok_list", {})).includes(first.agent_id), false);
  const closedListed = await f.service.invoke("grok_list", { include_closed: true, key: "review:1" });
  assert.deepEqual(closedListed.agents.map(agent => [agent.agent_id, agent.status]), [[first.agent_id, "closed"]]);
  const reopened = await spawnKeyed("review:1"); compact(reopened); assert.notEqual(reopened.agent_id, first.agent_id);
  assert.equal(f.launches.length, 3);
  const page = await f.service.invoke("grok_list", { include_closed: true, key: "review:1", limit: 1 });
  assert.equal(page.agents.length, 1); assert.equal(page.page.has_more, true);
  const rest = await f.service.invoke("grok_list", { include_closed: true, key: "review:1", limit: 1, cursor: page.page.next_cursor });
  assert.deepEqual(new Set([...ids(page), ...ids(rest)]), new Set([first.agent_id, reopened.agent_id])); assert.equal(rest.page.has_more, false);
  for (const filters of [{ key: "review:1" }, { include_closed: true }, { include_closed: true, key: "review:2" }]) {
    assert.equal((await f.service.invoke("grok_list", { ...filters, limit: 1, cursor: page.page.next_cursor })).error.code, "invalid_cursor");
  }
  rmSync(join(agents, reopened.agent_id), { recursive: true });
  const afterMissing = await spawnKeyed("review:1");
  assert.equal(afterMissing.call_status, "error"); assert.equal(afterMissing.error.code, "spawn_key_unverifiable");
  assert.equal(afterMissing.error.admission, "none"); assert.equal(afterMissing.error.details.agent_id, reopened.agent_id);
  assert.equal(f.launches.length, 3, "a missing holder is not permission to replay its work");
  writeFileSync(join(agents, second.agent_id, "agent.sqlite"), "damaged");
  const held = await spawnKeyed("review:2");
  assert.equal(held.call_status, "error"); assert.equal(held.error.code, "spawn_key_unverifiable");
  assert.equal(held.error.admission, "none"); assert.equal(held.error.details.agent_id, second.agent_id);
  assert.deepEqual(ids(await f.service.invoke("grok_list", { key: "review:2" })), [second.agent_id], "listing by key finds a holder whose state is unreadable");
  assert.equal(f.launches.length, 3); f.store.close();
});
test("a spawn key cannot retarget its holder's cwd, worktree or sandbox selection", async () => {
  const f = fixture(), other = join(f.root, "other"); mkdirSync(other);
  const input = { task: "keyed original", cwd: f.cwd, key: "fixed-selection" };
  const first = await f.service.invoke("grok_spawn", input); compact(first);
  assert.equal(first.agent.execution_cwd, null, "admission is not observation of a provider launch");
  assert.equal(first.agent.sandbox_argument, null); assert.equal(first.agent.worktree, false);
  for (const changed of [{ cwd: other }, { worktree: true }, { sandbox: "workspace" }, { sandbox: "off" }, { task: "different brief" }]) {
    const conflict = await f.service.invoke("grok_spawn", { ...input, ...changed });
    assert.equal(conflict.call_status, "error", JSON.stringify(conflict));
    assert.equal(conflict.error.code, "spawn_key_conflict", JSON.stringify(conflict));
    assert.equal(conflict.error.details.agent_id, first.agent_id);
    assert.equal(conflict.error.admission, "none");
  }
  const same = await f.service.invoke("grok_spawn", { ...input, worktree: false, attachments: [] });
  assert.equal(same.call_status, "existing"); assert.equal(same.agent_id, first.agent_id); assert.equal(f.launches.length, 1);
  const stored = AgentStore.open(first.agent_id, f.env, { readonly: true });
  assert.deepEqual(stored.operations().map(op => op.input.task), [input.task]); stored.close(); f.store.close();
});

test("unavailable process identity does not bypass a keyed holder's known execution selection", async () => {
  const f = fixture(), other = join(f.root, "other"); mkdirSync(other);
  const input = { task: "original", cwd: f.cwd, key: "unknown-process-selection" };
  const first = await f.service.invoke("grok_spawn", input); compact(first);
  const holder = AgentStore.open(first.agent_id, f.env);
  const claim = holder.claim(holder.launch().token); holder.close();
  // Persist an unobservable identity without making the metadata unreadable.
  const db = new DatabaseSync(join(f.env.GROKPAIR_HOME, "runtime-v2", "agents", first.agent_id, "agent.sqlite"));
  db.prepare("UPDATE state SET value=? WHERE key='worker'").run(JSON.stringify({ ...claim, worker: { ...claim.worker, birth: "" } }));
  db.close();
  const same = await f.service.invoke("grok_spawn", input);
  assert.equal(same.call_status, "existing"); assert.equal(same.agent.status, "unavailable");
  assert.equal(same.agent.cwd, f.cwd); assert.equal(same.agent.sandbox_argument, null);
  for (const changed of [{ cwd: other }, { worktree: true }, { sandbox: "strict" }]) {
    const conflict = await f.service.invoke("grok_spawn", { ...input, ...changed });
    assert.equal(conflict.error?.code, "spawn_key_conflict", JSON.stringify(conflict));
    assert.equal(conflict.error.admission, "none");
    assert.equal(conflict.error.details.agent_id, first.agent_id);
    assert.equal(conflict.error.details.agent.status, "unavailable");
  }
  assert.equal(f.launches.length, 1); f.store.close();
});

test("keyed spawn claims the key again when its holder closes during the claim", async () => {
  const f = fixture(), spawnKeyed = task => f.service.invoke("grok_spawn", { task, cwd: f.cwd, key: "race" });
  const first = await spawnKeyed("first"); compact(first);
  // The holder is observed open, then closes before its summary is read.
  const isOpen = f.service.isOpen; let closedDuringClaim = false;
  f.service.isOpen = function (agentId) {
    const open = isOpen.call(this, agentId);
    if (!closedDuringClaim && agentId === first.agent_id) { closedDuringClaim = true; compact(this.control("grok_close", { agent_id: agentId }, { admission: "none" })); }
    return open;
  };
  const second = await spawnKeyed("second"); compact(second);
  assert.equal(closedDuringClaim, true); assert.notEqual(second.agent_id, first.agent_id);
  assert.equal(second.agent.key, "race"); assert.equal(f.launches.length, 2); f.store.close();
});

test("a reservation whose launched worker is proved gone reads disconnected and accepts an explicit resume", async () => {
  const f = fixture({ claimed: false }), worker = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  try {
    const observed = observeProcess(worker.pid); assert.equal(observed.status, "observed");
    f.store.setLaunched(f.reservation.launch.token, observed.identity);
    assert.equal((await call(f, "grok_read")).agent.status, "starting");
    const early = await call(f, "grok_send", { task: "too early", resume: true });
    assert.equal(early.call_status, "error"); assert.equal(early.error.admission, "none"); assert.equal(f.launches.length, 0);
    const ended = once(worker, "close"); worker.kill(); await ended;
    for (let attempt = 0; attempt < 40 && processIdentityStatus(observed.identity) !== "absent"; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal((await call(f, "grok_read")).agent.status, "disconnected");
    const waited = await f.service.invoke("grok_wait", { targets: [{ agent_id: f.agentId }], timeout_ms: 0 });
    assert.equal(waited.call_status, "settled"); assert.equal(waited.agents[0].status, "disconnected");
    assert.equal((await call(f, "grok_send", { task: "implicit" })).error.code, "collaborator_disconnected");
    const resumed = await call(f, "grok_send", { task: "explicit new work", resume: true }); compact(resumed, f.store);
    assert.equal(f.launches.length, 1); assert.equal(f.launches[0][3], f.store.launch().token);
    assert.equal(f.store.operation(f.reservation.operation.operation_id).status, "not_sent");
    assert.equal(f.store.operation(resumed.operation_id).input.task, "explicit new work");
  } finally { if (worker.exitCode === null && worker.signalCode === null) worker.kill(); f.store.close(); }
});

test("every agent home and the grokpair store are refused as workspaces before admission", async () => {
  const f = fixture(), homes = {};
  for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME", "PI_CODING_AGENT_DIR"]) { homes[name] = join(f.root, name.toLowerCase()); mkdirSync(join(homes[name], "inside"), { recursive: true }); }
  const env = { ...f.env, ...homes }, service = new AgentService(env, (...args) => f.launches.push(args));
  mkdirSync(join(env.GROKPAIR_HOME, "inside"));
  for (const cwd of [...Object.values(homes).flatMap(home => [home, join(home, "inside")]), env.GROKPAIR_HOME, join(env.GROKPAIR_HOME, "inside")]) {
    const result = await service.invoke("grok_spawn", { task: "refused", cwd });
    assert.equal(result.error.code, "workspace_not_admitted", cwd); assert.equal(result.error.admission, "none");
  }
  compact(await service.invoke("grok_spawn", { task: "allowed", cwd: f.cwd }));
  assert.equal(f.launches.length, 1); f.store.close();
});

test("a key index that is not a regular single-link file refuses keyed spawn and is never written through", async () => {
  const f = fixture(), keys = join(f.env.GROKPAIR_HOME, "runtime-v2", "keys.sqlite");
  const foreign = join(f.root, "foreign.sqlite"), planted = join(f.root, "planted.sqlite");
  new DatabaseSync(foreign).close();
  const tables = () => { const db = new DatabaseSync(foreign); try { return db.prepare("SELECT name FROM sqlite_master").all().map(row => row.name); } finally { db.close(); } };
  const agents = async () => new Set((await f.service.invoke("grok_list", { include_closed: true, limit: 100 })).agents.map(agent => agent.agent_id));
  const before = await agents();
  for (const [label, plant] of [["symlink to a database", () => symlinkSync(foreign, keys)], ["dangling symlink", () => symlinkSync(planted, keys)], ["second hard link", () => linkSync(foreign, keys)]]) {
    plant();
    const result = await f.service.invoke("grok_spawn", { task: "keyed", cwd: f.cwd, key: "review:custody" });
    assert.equal(result.call_status, "error", label); assert.equal(result.error.admission, "none", label);
    assert.equal(f.launches.length, 0, label); assert.deepEqual(await agents(), before, label);
    assert.deepEqual(tables(), [], `${label}: the linked database is not written`); assert.equal(existsSync(planted), false, `${label}: nothing is created through the link`);
    rmSync(keys);
  }
  compact(await f.service.invoke("grok_spawn", { task: "keyed", cwd: f.cwd, key: "review:custody" }), undefined);
  assert.equal(statSync(keys).mode & 0o777, 0o600); f.store.close();
});

test("every agent home is protected at its default location and wherever its variable points", () => {
  const home = realpathSync(userInfo().homedir), root = realpathSync(mkdtempSync(join(scratch, "homes-")));
  const variables = ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME", "PI_CODING_AGENT_DIR", "GROKPAIR_HOME"];
  const defaults = [[".codex", "Codex state"], [".claude", "Claude Code state"], [".grok", "Grok state"], [".pi", "Pi state"], [".local/state/grokpair", "grokpair state"]]
    .map(([path, label]) => ({ path: join(home, path), label }));
  const sorted = roots => [...roots].sort((a, b) => `${a.path}|${a.label}`.localeCompare(`${b.path}|${b.label}`));
  const unset = workspaceBoundaries({});
  assert.equal(unset.user_home, home); assert.deepEqual(sorted(unset.protected_roots), sorted(defaults));
  const moved = Object.fromEntries(variables.map(name => [name, join(root, name.toLowerCase())]));
  assert.deepEqual(sorted(workspaceBoundaries(moved).protected_roots),
    sorted([...defaults, ...variables.map((name, index) => ({ path: moved[name], label: defaults[index].label }))]), "an override adds its location and keeps the default");
  const same = Object.fromEntries(variables.map((name, index) => [name, defaults[index].path]));
  assert.deepEqual(sorted(workspaceBoundaries(same).protected_roots), sorted(defaults), "an override naming the default adds no duplicate");
});
