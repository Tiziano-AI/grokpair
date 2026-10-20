import assert from "node:assert/strict";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Real SQLite state and the public service seam; no native provider or private home.
const scratch = realpathSync(mkdtempSync("/private/tmp/grokpair-thin-paging-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const bundle = join(scratch, "service.mjs");
await build({ stdin: { contents: 'export * from "./src/agent-service.ts"; export * from "./src/agent-store.ts"; export { parseAttention } from "./src/attention.ts";', resolveDir: new URL("../", import.meta.url).pathname, loader: "ts" }, outfile: bundle, bundle: true, platform: "node", format: "esm" });
const { AgentService, AgentStore, parseAttention } = await import(bundle);

function fixture(t, environment) {
  const root = realpathSync(mkdtempSync(join(scratch, "case-"))), cwd = join(root, "workspace"); mkdirSync(cwd);
  const env = environment ?? { ...process.env, GROKPAIR_HOME: join(root, "runtime") }, launches = [];
  const launcher = (...args) => { launches.push(args); assert.fail("passive paging must not launch a worker"); };
  const meta = { agent_id: `agent_${randomUUID()}`, cwd, worktree: false, sandbox_argument: null, execution_cwd: null, created_at: new Date().toISOString(), phase: "opening" };
  const store = AgentStore.create(meta, env);
  const reservation = store.admitLaunch({ task: "initial private input", cwd, worktree: false }, { operation_id: `operation_${randomUUID()}`, resume: false });
  const claim = store.claim(reservation.launch.token);
  store.updateOperation(claim, reservation.operation.operation_id, { status: "started" });
  store.updateOperation(claim, reservation.operation.operation_id, { status: "completed" });
  store.setMeta(claim, { phase: "ready" }); store.setObservation(claim, "queue", { entries: [] });
  const f = { root, cwd, env, store, claim, agentId: meta.agent_id, service: new AgentService(env, launcher), launcher, launches };
  t.after(() => { assert.equal(launches.length, 0); store.close(); });
  return f;
}
const call = (f, name, input = {}) => f.service.invoke(name, { agent_id: f.agentId, ...input });
const rowsOf = (records, type) => records.filter(record => record.type === type);
const textOf = records => rowsOf(records, "content").map(record => record.text).join("");
const validBoundary = text => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(text);

/** A caller collects only delivered pages. Fragment offsets are not text offsets. */
function collector(view, budget) {
  const records = [], pending = new Map(), pages = [], resets = [], frames = [];
  const lists = { attention: "attention", files: "file", issues: "issue", operations: "operation", background: "background" };
  return {
    records, pending, pages, resets, frames,
    add(response, page = response.agent) {
      assert.ok(JSON.stringify(response).length <= budget, `response exceeds ${budget} characters`);
      assert.ok(page.cursor); pages.push(page);
      if (page.fragment_reset !== undefined) { resets.push(page.fragment_reset); pending.delete(page.fragment_reset); }
      if (view === "records") records.push(...(page.records ?? []));
      else {
        assert.equal(Object.hasOwn(page, "records"), false);
        for (const turn of page.turns ?? []) if (turn.text !== undefined) records.push({ type: "content", ...turn });
        for (const [key, type] of Object.entries(lists)) records.push(...(page[key] ?? []).map(record => ({ ...record, type })));
      }
      for (const fragment of page.fragments ?? []) {
        assert.match(fragment.record_id, /^\d+:\d+$/u); assert.equal(typeof fragment.complete, "boolean");
        assert.ok(fragment.json.length > 0); assert.ok(validBoundary(fragment.json));
        const previous = pending.get(fragment.record_id) ?? "";
        assert.equal(fragment.offset, previous.length, "each version resumes its exact delivered prefix");
        const json = previous + fragment.json; frames.push(fragment);
        if (fragment.complete) {
          const record = JSON.parse(json); assert.equal(record.type, fragment.record_type);
          records.push(record); pending.delete(fragment.record_id);
        } else pending.set(fragment.record_id, json);
      }
      return page;
    },
  };
}
async function readAll(f, { view = "records", max_chars = 2000, cursor, collected = collector(view, max_chars) } = {}) {
  for (let index = 0; index < 2000; index++) {
    const response = await call(f, "grok_read", { view, max_chars, ...(cursor ? { cursor } : {}) });
    assert.equal(response.call_status, "ok", JSON.stringify(response));
    const page = collected.add(response); cursor = page.cursor;
    if (!page.has_more) { assert.equal(collected.pending.size, 0, "terminal page leaves no incomplete representation"); return { ...collected, cursor }; }
  }
  assert.fail("a finite retained record stream did not drain");
}

test("serialized response budgets preserve controls, escaping and Unicode with useful text progress in both views", async t => {
  for (const view of ["records", "result"]) for (const budget of [2000, 4096]) {
    const f = fixture(t), cursor = (await readAll(f, { view })).cursor;
    const text = ('\0\0\0"\\\u0001\b\f\n\r\t😀λ').repeat(400);
    f.store.appendContent(f.claim, { prompt_id: "p", block_index: 0, text });
    const all = await readAll(f, { view, cursor, max_chars: budget });
    assert.equal(textOf(all.records), text); assert.ok(all.pages.length > 1);
    assert.ok(rowsOf(all.records, "content").every(record => validBoundary(record.text)));
    assert.ok(Math.max(...rowsOf(all.records, "content").map(record => [...record.text].filter(char => char === "\0").length)) > 50,
      "escaping must not collapse a useful page into tiny text pieces");
    assert.equal(JSON.stringify(all.records).includes("initial private input"), false);
  }
});

test("a complete endpoint that exactly fits is delivered whole rather than rejected by a partial-frame search", async t => {
  for (const view of ["records", "result"]) {
    const f = fixture(t), cursor = (await readAll(f, { view })).cursor, text = "exact 😀\\\0".repeat(90);
    f.store.appendContent(f.claim, { prompt_id: "p", block_index: 0, text });
    const whole = await call(f, "grok_read", { view, cursor, max_chars: 100_000 });
    assert.equal(whole.call_status, "ok"); assert.equal(whole.agent.has_more, false);
    const exact = await call(f, "grok_read", { view, cursor, max_chars: JSON.stringify(whole).length });
    assert.deepEqual(exact, whole); assert.equal(Object.hasOwn(exact.agent, "fragments"), false);
  }
});

test("a three-code-unit Unicode tail advances when its surrogate pair fits but the complete endpoint does not", async t => {
  for (const view of ["records", "result"]) {
    // The four-code-unit control tail reaches the same valid pair through a
    // different binary-search midpoint. Both cursors come from public reads.
    const target = fixture(t), control = fixture(t);
    const afterA = async (f, text) => {
      const cursor = (await readAll(f, { view })).cursor;
      f.store.appendContent(f.claim, { prompt_id: "p", block_index: 0, text });
      const whole = await call(f, "grok_read", { view, cursor, max_chars: 100_000 }), size = JSON.stringify(whole).length;
      for (let budget = size - 16; budget < size; budget++) {
        const response = await call(f, "grok_read", { view, cursor, max_chars: budget });
        const text = view === "records" ? textOf(response.agent?.records ?? []) : (response.agent?.turns ?? []).map(turn => turn.text ?? "").join("");
        if (response.call_status === "ok" && text === "A" && response.agent.has_more) return response.agent.cursor;
      }
      assert.fail("fixture must obtain a genuine public text cursor immediately before the surrogate pair");
    };
    const targetCursor = await afterA(target, "A😀x"), controlCursor = await afterA(control, "A😀xx");
    const whole = await call(target, "grok_read", { view, cursor: targetCursor, max_chars: 100_000 });
    const size = JSON.stringify(whole).length; let budget, witness;
    for (let candidate = size - 8; candidate < size; candidate++) {
      const response = await call(control, "grok_read", { view, cursor: controlCursor, max_chars: candidate });
      const text = view === "records" ? textOf(response.agent?.records ?? []) : (response.agent?.turns ?? []).map(turn => turn.text ?? "").join("");
      if (response.call_status === "ok" && text === "😀") { budget = candidate; witness = response; break; }
    }
    assert.ok(witness, "a real public continuation must prove the whole surrogate pair fits below the complete endpoint's budget");
    assert.ok(JSON.stringify(witness).length <= budget);
    const response = await call(target, "grok_read", { view, cursor: targetCursor, max_chars: budget });
    assert.equal(response.call_status, "ok", JSON.stringify(response));
    const text = view === "records" ? textOf(response.agent.records ?? []) : (response.agent.turns ?? []).map(turn => turn.text ?? "").join("");
    assert.equal(text, "😀"); assert.equal(response.agent.has_more, true); assert.ok(JSON.stringify(response).length <= budget);
    const last = await call(target, "grok_read", { view, cursor: response.agent.cursor, max_chars: 100_000 });
    assert.equal(last.call_status, "ok"); assert.equal(last.agent.has_more, false);
    assert.equal(view === "records" ? textOf(last.agent.records ?? []) : last.agent.turns[0].text, "x");
  }
});

test("fitting freezes optional turn-file observations within a page, not across later reads", async t => {
  const f = fixture(t), cursor = (await readAll(f, { view: "result" })).cursor;
  f.store.appendContent(f.claim, { prompt_id: "p", block_index: 0, text: "x".repeat(6000) });
  f.store.upsertTurn(f.claim, { prompt_id: "p", status: "completed", source: "turn_completed" });
  const original = AgentStore.prototype.turnFile, appeared = join(f.cwd, "appeared-between-observations.md"); let observations = 0;
  AgentStore.prototype.turnFile = function (promptId) {
    if (this.agentId === f.agentId && promptId === "p") return ++observations === 1 ? null : appeared;
    return original.call(this, promptId);
  };
  try {
    const first = await call(f, "grok_read", { cursor, view: "result", max_chars: 2000 });
    assert.equal(first.call_status, "ok"); assert.equal(first.agent.has_more, true);
    assert.equal(first.agent.turns[0].text_file, undefined, "binary fitting cannot switch to a later optional file observation");
    const next = await call(f, "grok_read", { cursor: first.agent.cursor, view: "result", max_chars: 2000 });
    assert.equal(next.call_status, "ok"); assert.equal(next.agent.turns[0].text_file, appeared, "a new read observes current derived availability");
    assert.ok(JSON.stringify(first).length <= 2000); assert.ok(JSON.stringify(next).length <= 2000);
  } finally { AgentStore.prototype.turnFile = original; }
});

test("permission payload fragments survive reread and service reopen without admitting or duplicating an answer", async t => {
  const f = fixture(t), view = "result", budget = 2000, cursor = (await readAll(f, { view })).cursor;
  const native = parseAttention("session/request_permission", {
    sessionId: "native-session", toolCall: { toolCallId: "native-call", title: "Exact approval", rawInput: { command: "do not execute " + '😀\0"\\'.repeat(1800) } },
    options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
  });
  const attention = { ...native, request_id: `request_${randomUUID()}`, status: "pending" };
  f.store.upsertAttention(f.claim, attention);
  const operations = f.store.operations(), first = await call(f, "grok_read", { view, cursor, max_chars: budget });
  assert.equal(first.call_status, "ok"); assert.equal(first.agent.fragments[0].complete, false);
  assert.equal(first.agent.attention, undefined, "a partial payload is not exposed as a complete actionable attention object");
  assert.deepEqual(await call(f, "grok_read", { view, cursor, max_chars: budget }), first);
  const collected = collector(view, budget); collected.add(first);
  f.service = new AgentService(f.env, f.launcher);
  const all = await readAll(f, { view, max_chars: budget, cursor: first.agent.cursor, collected });
  assert.deepEqual(rowsOf(all.records, "attention"), [{ ...attention, type: "attention" }]);
  assert.equal(new Set(all.frames.map(frame => frame.record_id)).size, 1);
  assert.equal(all.frames.filter(frame => frame.complete).length, 1); assert.equal(all.frames.at(-1).complete, true);
  assert.deepEqual(f.store.operations(), operations, "reading and reopening never submits approval");
  const response = { outcome: { outcome: "selected", optionId: "allow" } };
  const accepted = await call(f, "grok_respond", { request_id: attention.request_id, response });
  assert.equal(accepted.call_status, "admitted");
  const duplicate = await call(f, "grok_respond", { request_id: attention.request_id, response });
  assert.equal(duplicate.error.code, "attention_already_responded"); assert.equal(duplicate.error.admission, "none");
  assert.equal(f.store.operations().length, operations.length + 1);
  f.store.expireAttention(f.claim, attention.request_id, "native_session_ended", "fixture_native_event");
  const expired = rowsOf((await readAll(f, { view })).records, "attention")[0];
  assert.equal(expired.status, "expired"); assert.deepEqual(expired.payload, native.payload);
  const late = await call(f, "grok_respond", { request_id: attention.request_id, response });
  assert.equal(late.error.code, "attention_not_pending"); assert.equal(f.store.operations().length, operations.length + 1);
});

test("huge summaries and huge text metadata use minimal fragment headers, not an unbounded exemption", async t => {
  for (const view of ["records", "result"]) {
    const f = fixture(t), cursor = (await readAll(f, { view })).cursor;
    f.store.setMeta(f.claim, { sandbox_argument: "native-exact-profile-" + "s".repeat(16_000) });
    const content = { prompt_id: "p", native_message_id: "native:" + "😀".repeat(5000), block_index: 0, text: "Retain this exact text 😀\0" };
    f.store.appendContent(f.claim, content);
    const all = await readAll(f, { view, cursor });
    assert.deepEqual(rowsOf(all.records, "content"), [{ ...content, type: "content" }]);
    assert.ok(all.frames.length > 1);
    for (const page of all.pages) {
      assert.equal(Object.hasOwn(page, "sandbox_argument"), false); assert.equal(Object.hasOwn(page, "counts"), false);
      assert.equal(Object.hasOwn(page, "oversized"), false);
    }
  }
});

test("a changed structured partial explicitly resets its old version and cannot skip intervening records", async t => {
  for (const smallReplacement of [false, true]) {
    const f = fixture(t), view = "records", budget = 2000, cursor = (await readAll(f, { view })).cursor;
    f.store.setObservation(f.claim, "native_options", { options: [{ id: "old", value: "old😀".repeat(3000) }] });
    const first = await call(f, "grok_read", { view, cursor, max_chars: budget });
    assert.equal(first.call_status, "ok"); assert.equal(first.agent.fragments[0].complete, false);
    const oldId = first.agent.fragments[0].record_id, collected = collector(view, budget); collected.add(first);
    const file = f.store.upsertFile(f.claim, { path: "/native/between-versions" });
    const replacement = { options: [{ id: "new", value: smallReplacement ? "small" : "newλ".repeat(3000) }] };
    f.store.setObservation(f.claim, "native_options", replacement);
    const all = await readAll(f, { view, max_chars: budget, cursor: first.agent.cursor, collected });
    assert.deepEqual(all.resets, [oldId]);
    assert.deepEqual(rowsOf(all.records, "native_options"), [{ ...replacement, type: "native_options" }]);
    assert.deepEqual(rowsOf(all.records, "file").map(row => row.reference_id), [file.reference_id]);
    const newFrames = all.frames.filter(frame => frame.record_id !== oldId);
    if (smallReplacement) assert.equal(newFrames.length, 0, "a small replacement needs no artificial complete fragment");
    else { assert.ok(newFrames.length > 1); assert.equal(newFrames[0].offset, 0); assert.equal(new Set(newFrames.map(frame => frame.record_id)).size, 1); }
    assert.equal(all.frames.filter(frame => frame.record_id === oldId && frame.complete).length, 0);
  }
});

test("a fragmented file drains an omitted result tail and preserves the next visible record", async t => {
  const f = fixture(t), view = "result", cursor = (await readAll(f, { view })).cursor;
  const huge = f.store.upsertFile(f.claim, { uri: "native://result/" + '😀\0"\\'.repeat(2500), label: "exact mutable reference" });
  for (let index = 0; index < 350; index++) f.store.upsertObservation(f.claim, "elicitation_completion", `done-${index}`, { elicitation_id: `done-${index}`, future: "omitted" });
  const all = await readAll(f, { view, cursor });
  assert.deepEqual(rowsOf(all.records, "file"), [{ ...huge, type: "file" }]);
  assert.equal(all.pages.at(-1).has_more, false); assert.equal(all.frames.at(-1).complete, true);
  const next = f.store.upsertFile(f.claim, { path: "/native/next-visible" });
  const later = await readAll(f, { view, cursor: all.cursor });
  assert.deepEqual(rowsOf(later.records, "file"), [{ ...next, type: "file" }]);
});

test("wait omits undelivered cursors, so caller rotation reaches a brief sibling without losing its beginning", async t => {
  const a = fixture(t), b = fixture(t, a.env), view = "records", budget = 2000;
  const aCursor = (await readAll(a, { view })).cursor, bCursor = (await readAll(b, { view })).cursor;
  a.store.setObservation(a.claim, "native_capabilities", { exact: "large😀\0".repeat(4000) });
  b.store.appendContent(b.claim, { prompt_id: "brief", block_index: 0, text: "The beginning and the end." });
  b.store.upsertTurn(b.claim, { prompt_id: "brief", status: "completed", source: "turn_completed" });
  const inputs = new Map([[a.agentId, aCursor], [b.agentId, bCursor]]);
  const first = await a.service.invoke("grok_wait", { targets: [...inputs].map(([agent_id, cursor]) => ({ agent_id, cursor })), view, max_chars: budget, timeout_ms: 0 });
  assert.equal(first.call_status, "settled"); assert.ok(JSON.stringify(first).length <= budget);
  assert.deepEqual(first.agents.map(agent => agent.agent_id), [a.agentId]);
  assert.equal(Object.hasOwn(first, "deferred"), false); assert.equal(first.agents[0].fragments[0].complete, false);
  for (const delivered of first.agents) { inputs.delete(delivered.agent_id); inputs.set(delivered.agent_id, delivered.cursor); }
  assert.equal(inputs.get(b.agentId), bCursor, "an excluded target retains its exact caller-owned input cursor");
  const second = await a.service.invoke("grok_wait", { targets: [...inputs].map(([agent_id, cursor]) => ({ agent_id, cursor })), view, max_chars: budget, timeout_ms: 0 });
  assert.ok(JSON.stringify(second).length <= budget); assert.equal(second.agents[0].agent_id, b.agentId);
  assert.equal(textOf(second.agents[0].records ?? []), "The beginning and the end.");
  const allA = await readAll(a, { view, cursor: aCursor });
  assert.deepEqual(rowsOf(allA.records, "native_capabilities"), [{ type: "native_capabilities", exact: "large😀\0".repeat(4000) }]);
});

test("wait includes the last target that actually settles even when an earlier busy target has a huge unread tail", async t => {
  const busy = fixture(t), ready = fixture(t, busy.env), view = "records", budget = 2000;
  busy.store.setObservation(busy.claim, "queue", { entries: [], runningPromptId: "running" });
  const busyCursor = (await readAll(busy, { view })).cursor, readyCursor = (await readAll(ready, { view })).cursor;
  busy.store.appendContent(busy.claim, { prompt_id: "running", block_index: 0, text: "unread".repeat(10_000) });
  ready.store.issue(ready.claim, { code: "useful_completion", message: "The last target changed and is settled." });
  const result = await busy.service.invoke("grok_wait", { targets: [{ agent_id: busy.agentId, cursor: busyCursor }, { agent_id: ready.agentId, cursor: readyCursor }], view, max_chars: budget, timeout_ms: 0 });
  assert.equal(result.call_status, "settled"); assert.ok(JSON.stringify(result).length <= budget);
  const trigger = result.agents.find(agent => agent.agent_id === ready.agentId);
  assert.ok(trigger, "the waking target cannot disappear behind an earlier target's payload");
  assert.equal(trigger.status, "idle"); assert.equal(rowsOf(trigger.records ?? [], "issue")[0].code, "useful_completion");
});

test("budget errors advance nothing, and retained fragments remain readable after native close", async t => {
  const f = fixture(t), view = "records", cursor = (await readAll(f, { view })).cursor;
  const payload = { exact: "retained😀\0".repeat(1500) }; f.store.setObservation(f.claim, "native_capabilities", payload);
  const revision = f.store.revision(), operations = f.store.operations();
  for (const name of ["grok_read", "grok_wait"]) {
    const response = name === "grok_read"
      ? await call(f, name, { cursor, view, max_chars: 100 })
      : await f.service.invoke(name, { targets: [{ agent_id: f.agentId, cursor }], view, max_chars: 100, timeout_ms: 0 });
    assert.equal(response.error.code, "response_budget_too_small"); assert.equal(response.error.admission, "none");
    assert.equal(Object.hasOwn(response, "agent"), false); assert.equal(Object.hasOwn(response, "agents"), false);
  }
  assert.deepEqual(f.store.revision(), revision); assert.deepEqual(f.store.operations(), operations);
  const first = await call(f, "grok_read", { view, cursor, max_chars: 2000 }), collected = collector(view, 2000); collected.add(first);
  assert.equal(first.agent.fragments[0].complete, false);
  // Native process identities were never launched; release the synthetic worker,
  // then use the real local-close path rather than pretending a pending close ended.
  f.store.release(f.claim);
  const closed = await call(f, "grok_close"); assert.equal(closed.call_status, "admitted"); assert.equal(closed.agent.status, "closed");
  f.service = new AgentService(f.env, f.launcher);
  const all = await readAll(f, { view, cursor: first.agent.cursor, collected });
  assert.deepEqual(rowsOf(all.records, "native_capabilities"), [{ type: "native_capabilities", ...payload }]);
  assert.equal(all.pages.at(-1).status, "closed");
});

test("an empty drained page cannot discard a large summary to report success", async t => {
  for (const view of ["result", "records"]) for (const name of ["grok_read", "grok_wait"]) {
    await t.test(`${name} ${view}`, async t => {
      const f = fixture(t), cursor = (await readAll(f, { view })).cursor;
      const sandbox = "exact-native-sandbox:" + "s".repeat(40_000);
      f.store.setMeta(f.claim, { sandbox_argument: sandbox });
      const revision = f.store.revision(), operations = f.store.operations();
      const input = name === "grok_read"
        ? { agent_id: f.agentId, cursor, view }
        : { targets: [{ agent_id: f.agentId, cursor }], view, timeout_ms: 0 };
      const small = await f.service.invoke(name, { ...input, max_chars: 32_000 });
      assert.equal(small.call_status, "error", "a successful non-fragment page must carry its complete summary");
      assert.equal(small.error.code, "response_budget_too_small"); assert.equal(small.error.admission, "none");
      assert.equal(Object.hasOwn(small, "agent"), false); assert.equal(Object.hasOwn(small, "agents"), false);
      assert.deepEqual(f.store.revision(), revision); assert.deepEqual(f.store.operations(), operations);
      const larger = await f.service.invoke(name, { ...input, max_chars: 100_000 });
      assert.notEqual(larger.call_status, "error", JSON.stringify(larger)); assert.ok(JSON.stringify(larger).length <= 100_000);
      const page = name === "grok_read" ? larger.agent : larger.agents[0];
      assert.equal(page.sandbox_argument, sandbox); assert.equal(page.has_more, false); assert.ok(page.cursor);
      assert.equal(Object.hasOwn(page, "fragments"), false);
      if (view === "records") assert.deepEqual(page.records, []);
      assert.deepEqual(f.store.revision(), revision); assert.deepEqual(f.store.operations(), operations);
    });
  }
});
