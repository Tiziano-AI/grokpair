import assert from "node:assert/strict";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "grokpair-thin-store-")));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const bundle = join(scratch, "store.mjs");
await build({ stdin: { contents: 'export * from "./src/agent-store.ts"; export * from "./src/process.ts"; export * from "./src/agent-state.ts";', resolveDir: new URL("../", import.meta.url).pathname, loader: "ts" }, outfile: bundle, bundle: true, platform: "node", format: "esm" });
const { AgentStore, runtimeCoordinates, listAgentIds, currentProcessIdentity, processIdentityStatus, observeProcess, summarizeAgent, effectiveQueue, promptActivity, removedFromQueue, RUNTIME_CONTRACT } = await import(bundle);
const operationId = () => "operation_" + randomUUID();
function fixture() {
  const root = realpathSync(mkdtempSync(join(scratch, "case-")));
  const env = { ...process.env, GROKPAIR_HOME: join(root, "state") };
  const meta = { agent_id: "agent_" + randomUUID(), cwd: root, worktree: false, sandbox_argument: null, execution_cwd: null, created_at: new Date().toISOString(), phase: "opening" };
  return { root, env, meta, store: AgentStore.create(meta, env) };
}
function reserve(f, input = { task: "original" }) { return f.store.admitLaunch(input, { operation_id: operationId(), resume: false }); }
function resident(f) { const admission = reserve(f); return { ...admission, claim: f.store.claim(admission.launch.token) }; }
function finish(s, c, op) { s.updateOperation(c, op.operation_id, { status: "started" }); s.updateOperation(c, op.operation_id, { status: "completed" }); }
async function child(code, args = []) {
  const cp = spawn(process.execPath, ["--input-type=module", "-e", code, bundle, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; cp.stdout.on("data", x => stdout += x); cp.stderr.on("data", x => stderr += x);
  const [status] = await once(cp, "close"); assert.equal(status, 0, stderr); return stdout;
}
const openChild = "const {AgentStore}=await import(process.argv[1]);const a=JSON.parse(process.argv[2]);const s=AgentStore.open(a.id,a.env);";
const args = (f, extra = {}) => [JSON.stringify({ id: f.meta.agent_id, env: f.env, ...extra })];
const resume = f => f.store.admitLaunch({ task: "fresh", resume: true }, { operation_id: operationId(), resume: true });

test("launch admission and reservation survive reopen together; other runtime contracts untouched", () => {
  const f = fixture(), others = ["runtime-v0", "runtime-v1", "runtime-v7"];
  for (const version of others) { const old = join(f.env.GROKPAIR_HOME, version); mkdirSync(join(old, "agents"), { recursive: true }); writeFileSync(join(old, "retained"), "prior occurrence"); mkdirSync(join(old, "agents", "agent_" + randomUUID())); }
  const admitted = reserve(f);
  const db = new DatabaseSync(f.store.databasePath, { readOnly: true });
  assert.equal(db.prepare("SELECT value FROM state WHERE key='format'").get().value, "1");
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name), ["prompt_inputs", "records", "state"]); db.close();
  assert.equal(admitted.operation.status, "admitted"); assert.equal(admitted.operation.sequence, 1); assert.equal(f.store.worker(), null);
  assert.equal(admitted.launch.operation_id, admitted.operation.operation_id);
  assert.equal(runtimeCoordinates(f.env), join(f.env.GROKPAIR_HOME, "runtime-v2"));
  const revision = f.store.revision(); assert.throws(() => reserve(f), /already/); assert.deepEqual(f.store.revision(), revision);
  f.store.close(); const read = AgentStore.open(f.meta.agent_id, f.env, { readonly: true });
  assert.deepEqual(read.operation(admitted.operation.operation_id), admitted.operation); assert.deepEqual(read.launch(), admitted.launch);
  assert.throws(() => read.admit("follow_up", {}), /Read-only/); assert.deepEqual(listAgentIds(f.env), [f.meta.agent_id]);
  for (const version of others) assert.equal(readFileSync(join(f.env.GROKPAIR_HOME, version, "retained"), "utf8"), "prior occurrence");
  read.close();
});

test("parallel admissions retain unique stable operation sequences without lost writes", async () => {
  const f = fixture(); resident(f);
  await Promise.all(Array.from({ length: 4 }, (_, writer) => child(openChild + "for(let i=0;i<12;i++)s.admit('follow_up',{writer:a.writer,i});s.close();", args(f, { writer }))));
  const ops = f.store.operations(); assert.equal(ops.length, 49); assert.equal(new Set(ops.map(o => o.operation_id)).size, 49);
  assert.equal(new Set(ops.map(o => o.sequence)).size, 49);
  assert.ok(ops.every((op, i) => i === 0 || ops[i - 1].sequence < op.sequence)); f.store.close();
});

test("atomic response reservation allows exactly one racing admission and survives worker updates", async () => {
  const f = fixture(), { claim } = resident(f), attention = { request_id: "request-exact", method: "_x.ai/ask_user_question", payload: {}, status: "pending" };
  f.store.upsertAttention(claim, attention);
  const outcomes = await Promise.all(Array.from({ length: 6 }, () => child(openChild + "try{const o=s.admit('respond',{request_id:'request-exact',response:{}});console.log(JSON.stringify({accepted:o.operation_id}));}catch(e){console.log(JSON.stringify({error:e.message}));}s.close();", args(f))));
  const accepted = outcomes.map(x => JSON.parse(x)).filter(x => x.accepted); assert.equal(accepted.length, 1);
  assert.equal(f.store.operations().filter(x => x.kind === "respond").length, 1);
  assert.equal(f.store.getAttention(attention.request_id).response_operation_id, accepted[0].accepted);
  f.store.upsertAttention(claim, { ...attention, status: "expired" });
  assert.equal(f.store.getAttention(attention.request_id).response_operation_id, accepted[0].accepted);
  assert.throws(() => f.store.admit("respond", { request_id: attention.request_id }), /not pending/);
  assert.throws(() => f.store.upsertAttention(claim, attention), /reopened/); f.store.close();
});

test("records revise current owners; content never wakes and identical observations do not churn", () => {
  const f = fixture(), s = f.store, { claim, operation } = resident(f);
  assert.throws(() => s.claim("wrong"), /fence/); assert.throws(() => s.setMeta({ ...claim, token: "wrong" }, { phase: "ready" }), /fence/);
  s.setMeta({ ...claim, worker: { ...claim.worker, pgid: claim.worker.pgid + 1 } }, { phase: "ready" });
  const before = s.revision(); s.setMeta(claim, { phase: "ready" }); assert.deepEqual(s.revision(), before);
  const first = s.appendContent(claim, { prompt_id: "p1", block_index: 0, text: "first\n" });
  const second = s.appendContent(claim, { prompt_id: "p1", block_index: 0, text: "second" });
  assert.deepEqual(s.revision(), { change: before.change + 2, wake: before.wake });
  assert.equal(s.record(first.seq).value.text, "first\n"); assert.ok(second.seq > first.seq);
  s.setObservation(claim, "queue", { entries: [{ id: "p2" }], runningPromptId: "p1" });
  const queued = s.records().find(row => row.type === "queue"), revision = s.revision();
  s.setObservation(claim, "queue", { runningPromptId: "p1", entries: [{ id: "p2" }] }); assert.deepEqual(s.revision(), revision);
  s.setObservation(claim, "queue", { entries: [], runningPromptId: "p1" });
  const changed = s.records({ after: revision.change }); assert.equal(changed.length, 1); assert.equal(changed[0].seq, queued.seq); assert.ok(changed[0].change > queued.change);
  assert.equal(s.count("queue"), 1); assert.equal(s.records({ after: 0, through: revision.change }).some(row => row.type === "queue"), false);
  assert.deepEqual(s.records({ prompt_id: "p1" }).map(row => row.type), ["content", "content"]);
  assert.equal(s.hasPrompt("p1"), true); assert.equal(s.hasPrompt("unknown"), false); assert.throws(() => s.records({ after: -1 }), /Invalid/);
  finish(s, claim, operation); assert.equal(s.operation(operation.operation_id).sequence, operation.sequence);
  assert.throws(() => s.updateOperation(claim, operation.operation_id, { status: "started" }), /replay/); s.release(claim);
  assert.equal(s.worker(), null); assert.throws(() => s.appendContent(claim, { prompt_id: "p", block_index: 0, text: "late" }), /fence/); s.close();
});

test("one SQLite snapshot binds revision and records during concurrent writes", () => {
  const f = fixture(), { claim } = resident(f), reader = AgentStore.open(f.meta.agent_id, f.env, { readonly: true });
  reader.snapshot(() => {
    const before = reader.revision(), rows = reader.records();
    f.store.appendContent(claim, { prompt_id: "p", block_index: 0, text: "concurrent" });
    assert.deepEqual(reader.revision(), before); assert.deepEqual(reader.records(), rows);
  });
  assert.equal(reader.records().at(-1).value.text, "concurrent"); reader.close(); f.store.close();
});

test("exact inputs, side answers, terminal turns, files and retained issues have one owner", () => {
  const f = fixture(), s = f.store, { claim } = resident(f);
  const input = { attachments: [{ path: "/input.png", kind: "image", mime_type: "image/png", bytes: 8 }] };
  s.setPromptInput(claim, "queued", input); assert.deepEqual(s.promptInput("queued"), input); assert.equal(s.hasPrompt("queued"), true);
  s.setPromptInput(claim, "queued", input); assert.throws(() => s.setPromptInput(claim, "queued", { attachments: [] }), /immutable/);
  const op = s.admit("side_question", { task: "question" }); s.appendSideAnswer(claim, { operation_id: op.operation_id, text: "answer" });
  const before = s.revision(); s.appendSideAnswer(claim, { operation_id: op.operation_id, text: "answer" }); assert.deepEqual(s.revision(), before);
  assert.throws(() => s.appendSideAnswer(claim, { operation_id: op.operation_id, text: "replacement" }), /immutable/);
  s.upsertTurn(claim, { prompt_id: "p", status: "running", source: "live_update" }); assert.equal(s.runningTurns().length, 1);
  s.upsertTurn(claim, { prompt_id: "p", status: "completed", source: "prompt_response" }); assert.equal(s.runningTurns().length, 0);
  assert.throws(() => s.upsertTurn(claim, { prompt_id: "p", status: "running", source: "late" }), /terminal/);
  s.upsertFile(claim, { path: "/native/output.png", prompt_id: "p" }); assert.equal(s.files().length, 1);
  for (let i = 0; i < 140; i++) s.issue(claim, { code: "fixture", message: String(i) });
  const issues = s.records({ limit: 1000 }).filter(row => row.type === "issue"); assert.equal(issues.length, 140); assert.equal(issues[0].value.message, "0"); assert.doesNotThrow(() => s.records({ limit: 10001 })); s.close();
});

test("unclaimed close fences unknown delayed child; late launch receipts cannot resurrect it", async () => {
  const f = fixture(), { operation, launch } = reserve(f);
  assert.throws(() => resume(f), /Unclaimed/); const closed = f.store.admitClose(operationId());
  assert.equal(closed.status, "completed"); assert.deepEqual(closed.result, { retired: true, native: null, process: null, reason: "unclaimed_launch_fenced" });
  assert.equal(f.store.operation(operation.operation_id).status, "not_sent"); assert.equal(f.store.operation(operation.operation_id).effects.prompt.status, "not_sent");
  const result = await child(openChild + "try{s.claim(a.token);console.log('claimed')}catch(e){console.log(e.message)}s.close();", args(f, { token: launch.token }));
  assert.match(result, /fence/); f.store.setLaunched(launch.token, currentProcessIdentity());
  assert.equal(f.store.launch().state, "fenced"); assert.equal(f.store.worker(), null); assert.throws(() => f.store.admit("follow_up", {}), /closed/); f.store.close();
});

test("a reservation whose own launched worker is proved gone reads disconnected and admits one resume", async () => {
  const f = fixture(), { operation, launch } = reserve(f);
  assert.equal(summarizeAgent(f.store).status, "starting"); assert.throws(() => resume(f), /Unclaimed/);
  const worker = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  try {
    const observed = observeProcess(worker.pid); assert.equal(observed.status, "observed");
    f.store.setLaunched(launch.token, observed.identity);
    // A launched worker that is still alive may yet claim: the reservation keeps starting and blocks resume.
    assert.equal(summarizeAgent(f.store).status, "starting"); assert.throws(() => resume(f), /Unclaimed/);
    const ended = once(worker, "close"); worker.kill(); await ended;
    for (let attempt = 0; attempt < 40 && processIdentityStatus(observed.identity) !== "absent"; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(processIdentityStatus(observed.identity), "absent");
    assert.equal(summarizeAgent(f.store).status, "disconnected");
    const fresh = resume(f);
    assert.equal(f.store.operation(operation.operation_id).status, "not_sent");
    assert.deepEqual(f.store.operation(operation.operation_id).effects.prompt, { status: "not_sent" });
    assert.deepEqual(f.store.pendingOperations().map(op => op.operation_id), [fresh.operation.operation_id]);
    assert.equal(f.store.launch().token, fresh.launch.token); assert.equal(f.store.launch().resume, true);
    assert.equal(summarizeAgent(f.store).status, "starting");
    assert.throws(() => f.store.claim(launch.token), /fence/);
    assert.throws(() => resume(f), /Unclaimed/, "the fresh reservation is itself unclaimed");
  } finally { if (worker.exitCode === null && worker.signalCode === null) worker.kill(); f.store.close(); }
});

test("a reservation left by a gone process that recorded no worker reads disconnected and admits one resume", async () => {
  const f = fixture();
  // The reserving process exits before it launched or recorded any worker.
  const reserved = JSON.parse(await child(openChild + "const r=s.admitLaunch({task:'original'},{operation_id:a.operation,resume:false});console.log(JSON.stringify({token:r.launch.token,operation:r.operation.operation_id}));s.close();", args(f, { operation: operationId() })));
  assert.equal(processIdentityStatus(f.store.launch().launcher), "absent"); assert.equal(f.store.launch().worker, undefined);
  assert.equal(summarizeAgent(f.store).status, "disconnected");
  const fresh = resume(f);
  assert.equal(f.store.operation(reserved.operation).status, "not_sent");
  assert.deepEqual(f.store.pendingOperations().map(op => op.operation_id), [fresh.operation.operation_id]);
  // A late child of the gone process can no longer claim; the live resumer's reservation blocks another resume.
  assert.throws(() => f.store.claim(reserved.token), /fence/);
  assert.equal(summarizeAgent(f.store).status, "starting"); assert.throws(() => resume(f), /Unclaimed/); f.store.close();
});

test("definitive no-child launch failure is not_sent; observed child cannot be relabeled", () => {
  const f = fixture(), { operation, launch } = reserve(f);
  f.store.failLaunch(launch.token, { code: "ENOENT" }); assert.equal(f.store.operation(operation.operation_id).status, "not_sent");
  assert.equal(f.store.operation(operation.operation_id).effects.prompt.status, "not_sent");
  assert.equal(f.store.meta().phase, "disconnected"); assert.equal(f.store.admitClose(operationId()).status, "completed"); f.store.close();
  const g = fixture(), admitted = reserve(g); g.store.setLaunched(admitted.launch.token, currentProcessIdentity());
  assert.throws(() => g.store.failLaunch(admitted.launch.token, {}), /child may exist/);
  // A child that claimed owns the outcome: the failure report changes nothing.
  const claim = g.store.claim(admitted.launch.token); assert.equal(g.store.failLaunch(claim.token, {}), false);
  assert.equal(g.store.operation(admitted.operation.operation_id).status, "admitted"); assert.equal(g.store.launch().state, "claimed"); g.store.close();
});

test("dead worker resume admits only new input, preserves partial effects and expires prior attention", async () => {
  const f = fixture(), { operation, launch } = reserve(f), queued = f.store.admit("follow_up", { task: "never sent" });
  await child(openChild + "const c=s.claim(a.token);s.setMeta(c,{native_session_id:'known',session_open_started:true});s.updateOperation(c,a.operation,{status:'started',effects:{configuration:{model:{status:'applied',value:'m'},effort:{status:'submitted',value:'e'}},prompt:{status:'not_sent'}}});s.upsertAttention(c,{request_id:'q',method:'_x.ai/ask_user_question',payload:{},status:'pending'});s.upsertTurn(c,{prompt_id:'p',status:'running',source:'live_update'});s.close();", args(f, { token: launch.token, operation: operation.operation_id }));
  assert.equal(processIdentityStatus(f.store.worker().worker), "absent");
  const reader = AgentStore.open(f.meta.agent_id, f.env, { readonly: true }); assert.equal(reader.operation(operation.operation_id).status, "started"); reader.close();
  const fresh = resume(f);
  assert.equal(f.store.operation(operation.operation_id).status, "outcome_unknown");
  assert.deepEqual(f.store.operation(operation.operation_id).effects, { configuration: { model: { status: "applied", value: "m" }, effort: { status: "unknown", value: "e" } }, prompt: { status: "not_sent" } });
  assert.equal(f.store.operation(queued.operation_id).status, "not_sent"); assert.equal(f.store.getAttention("q").status, "expired");
  assert.equal(f.store.turn("p").status, "unknown"); assert.equal(f.store.observation("queue").unavailable, true);
  assert.match(readFileSync(f.store.turnFile("p"), "utf8"), /^---\n[^]*\nstatus: "unknown"\n[^]*---\n\n\n$/u, "a turn cut off with its worker is kept as a file");
  assert.deepEqual(f.store.pendingOperations().map(op => op.operation_id), [fresh.operation.operation_id]);
  const claim = f.store.claim(fresh.launch.token); assert.throws(() => f.store.updateOperation(claim, operation.operation_id, { status: "started" }), /replay/);
  finish(f.store, claim, fresh.operation); f.store.release(claim); f.store.close();
});

test("racing resumes create one fresh reservation and never replay abandoned work", async () => {
  const f = fixture(), { launch } = reserve(f);
  await child(openChild + "s.claim(a.token);s.close();", args(f, { token: launch.token }));
  // Each reserving process stays alive while the others try, as a launching server does.
  const attempts = await Promise.all(Array.from({ length: 4 }, () => child(openChild + "try{const r=s.admitLaunch({task:'fresh',resume:true},{operation_id:a.operation,resume:true});console.log(JSON.stringify({accepted:r.operation.operation_id}));}catch(e){console.log(JSON.stringify({error:e.message}));}s.close();await new Promise(r=>setTimeout(r,1500));", args(f, { operation: operationId() }))));
  assert.equal(attempts.map(x => JSON.parse(x)).filter(x => x.accepted).length, 1); assert.equal(f.store.pendingOperations().length, 1); assert.equal(f.store.operations().length, 2); f.store.close();
});

test("dead pending close retires locally without rewriting old unknown outcomes", async () => {
  const f = fixture(), { operation, launch } = reserve(f), closing = f.store.admit("close", {});
  await child(openChild + "const c=s.claim(a.token);s.updateOperation(c,a.operation,{status:'started',native_prompt_id:'p',effects:{prompt:{status:'submitted',prompt_id:'p'}}});s.updateOperation(c,a.close,{status:'started'});s.close();", args(f, { token: launch.token, operation: operation.operation_id, close: closing.operation_id }));
  const retired = f.store.admitClose(operationId());
  assert.equal(retired.status, "completed"); assert.equal(retired.result.retired, true);
  assert.equal(f.store.operation(closing.operation_id).status, "outcome_unknown");
  assert.equal(f.store.operation(operation.operation_id).effects.prompt.status, "unknown");
  assert.equal(f.store.operation(operation.operation_id).status, "outcome_unknown"); f.store.close();
});

test("response identity collision rolls back its attention reservation", () => {
  const f = fixture(), { claim, operation } = resident(f);
  f.store.upsertAttention(claim, { request_id: "q", method: "_x.ai/ask_user_question", payload: {}, status: "pending" });
  const revision = f.store.revision();
  assert.throws(() => f.store.admit("respond", { request_id: "q" }, { operation_id: operation.operation_id }), /already admitted/);
  assert.equal(f.store.getAttention("q").response_operation_id, undefined); assert.deepEqual(f.store.revision(), revision);
  assert.equal(f.store.admit("respond", { request_id: "q" }).status, "admitted"); f.store.close();
});

test("unknown provider launch and lost native session identity deny new launch or retirement", async () => {
  const f = fixture(), { launch } = reserve(f);
  await child(openChild + "const c=s.claim(a.token);s.processStarting(c);s.close();", args(f, { token: launch.token }));
  assert.throws(() => resume(f), /provider identity is unknown/i); assert.throws(() => f.store.admitClose(operationId()), /provider identity is unknown/i); f.store.close();
  const g = fixture(), prior = reserve(g);
  await child(openChild + "const c=s.claim(a.token);s.setMeta(c,{session_open_started:true});s.close();", args(g, { token: prior.launch.token }));
  assert.throws(() => resume(g), /session identity is unknown/); assert.equal(g.store.admitClose(operationId()).status, "completed"); g.store.close();
});

test("live worker prevents resume and admits one close; release relinquishes authority before process exit", () => {
  const f = fixture(), { claim, operation } = resident(f); assert.throws(() => resume(f), /worker absence/);
  const close = f.store.admitClose(operationId()); assert.equal(close.status, "admitted");
  assert.throws(() => f.store.admitClose(operationId()), /close is pending/); assert.throws(() => f.store.admit("follow_up", {}), /close is pending/);
  assert.throws(() => f.store.release(claim), /unfinished/); finish(f.store, claim, operation); finish(f.store, claim, close);
  f.store.release(claim); assert.equal(processIdentityStatus(claim.worker), "alive"); assert.equal(f.store.admitClose(operationId()).result.retired, true); f.store.close();
});

test("dead worker with live exact provider blocks resume/retirement until provider absence", async () => {
  const f = fixture(), { launch } = reserve(f), provider = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  try {
    const observed = observeProcess(provider.pid); assert.equal(observed.status, "observed");
    await child(openChild + "const c=s.claim(a.token);s.processStarting(c);s.setProcess(c,a.provider);s.close();", args(f, { token: launch.token, provider: observed.identity }));
    assert.throws(() => resume(f), /provider absence/i); assert.throws(() => f.store.admitClose(operationId()), /provider absence/i);
    const ended = once(provider, "close"); provider.kill(); await ended; assert.equal(f.store.admitClose(operationId()).result.retired, true);
  } finally { if (provider.exitCode === null && provider.signalCode === null) provider.kill(); f.store.close(); }
});

test("an observed living opening worker keeps ownership of an exited provider's startup outcome", async () => {
  const f = fixture(), { claim, operation } = resident(f), provider = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  try {
    const observed = observeProcess(provider.pid); assert.equal(observed.status, "observed");
    f.store.processStarting(claim); f.store.setProcess(claim, observed.identity);
    const ended = once(provider, "close"); provider.kill(); await ended;
    assert.equal(processIdentityStatus(observed.identity), "absent"); assert.equal(processIdentityStatus(claim.worker), "alive");
    assert.equal(summarizeAgent(f.store).status, "starting", "process exit alone cannot bypass the living worker's startup diagnostics");
    f.store.updateOperation(claim, operation.operation_id, { status: "not_sent", error: { code: "native_startup_failed", message: "Retained native startup diagnostic" } });
    f.store.setMeta(claim, { phase: "disconnected" });
    const settled = summarizeAgent(f.store); assert.equal(settled.status, "disconnected"); assert.equal(settled.counts.pending_operations, 0);
  } finally { if (provider.exitCode === null && provider.signalCode === null) provider.kill(); f.store.close(); }
});

test("a dead worker's exact live provisioner blocks resume and close independently of its ACP provider", async () => {
  const f = fixture(), { launch } = reserve(f), provisioner = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  try {
    const observed = observeProcess(provisioner.pid); assert.equal(observed.status, "observed");
    await child(openChild + "const c=s.claim(a.token);s.processStarting(c,'provisioner');s.setProcess(c,a.provisioner,'provisioner');s.setMeta(c,{worktree:true,provisioning:{status:'running'}});s.close();", args(f, { token: launch.token, provisioner: observed.identity }));
    assert.equal(processIdentityStatus(f.store.worker().worker), "absent");
    assert.equal(f.store.worker().provider, null); assert.equal(f.store.worker().provider_state, "not_attempted");
    const before = f.store.revision();
    assert.throws(() => resume(f), /provisioner absence/i); assert.throws(() => f.store.admitClose(operationId()), /provisioner absence/i);
    assert.deepEqual(f.store.revision(), before, "refused lifecycle actions do not admit operations");
    const ended = once(provisioner, "close"); provisioner.kill(); await ended;
    assert.equal(processIdentityStatus(observed.identity), "absent");
    assert.equal(f.store.admitClose(operationId()).result.retired, true);
    assert.equal(f.store.meta().provisioning.status, "outcome_unknown");
  } finally { if (provisioner.exitCode === null && provisioner.signalCode === null) provisioner.kill(); f.store.close(); }
});

test("a dead worker with unknown provisioner launch identity cannot infer absence or clear custody", async () => {
  const f = fixture(), { launch } = reserve(f);
  await child(openChild + "const c=s.claim(a.token);s.processStarting(c,'provisioner');s.setMeta(c,{worktree:true,provisioning:{status:'starting'}});s.close();", args(f, { token: launch.token }));
  assert.equal(processIdentityStatus(f.store.worker().worker), "absent");
  assert.throws(() => resume(f), /provisioner identity is unknown/i);
  assert.throws(() => f.store.admitClose(operationId()), /provisioner identity is unknown/i);
  assert.equal(f.store.meta().provisioning.status, "starting"); f.store.close();
});

for (const status of ["starting", "running"]) for (const disposition of ["close", "resume"]) test(`absent provisioner ${status} projects uncertainty passively and retains it durably on ${disposition}`, async () => {
  const f = fixture(), { launch } = reserve(f), returned = join(f.root, "native-result"); mkdirSync(returned);
  await child(openChild + "const c=s.claim(a.token);s.processStarting(c,'provisioner');s.setProcess(c,c.worker,'provisioner');s.setMeta(c,{worktree:true,provisioning:{status:a.status,returned_cwd:a.returned}});s.close();", args(f, { token: launch.token, status, returned }));
  assert.equal(processIdentityStatus(f.store.worker().worker), "absent");
  assert.equal(processIdentityStatus(f.store.worker().provisioner), "absent");
  const before = f.store.revision(), reader = AgentStore.open(f.meta.agent_id, f.env, { readonly: true });
  const summary = summarizeAgent(reader); reader.close();
  assert.equal(summary.status, "disconnected"); assert.equal(summary.provisioning.status, "outcome_unknown");
  assert.equal(summary.provisioning.returned_cwd, returned); assert.equal(summary.execution_cwd, null);
  assert.equal(f.store.meta().provisioning.status, status, "read-only summary projection does not rewrite durable native observations");
  assert.deepEqual(f.store.revision(), before);
  if (disposition === "close") assert.equal(f.store.admitClose(operationId()).status, "completed");
  else resume(f); // Store settlement only; no worker is launched or native creation repeated.
  assert.equal(f.store.meta().provisioning.status, "outcome_unknown");
  assert.equal(f.store.meta().provisioning.returned_cwd, returned);
  f.store.close(); const reopened = AgentStore.open(f.meta.agent_id, f.env, { readonly: true });
  assert.equal(reopened.meta().provisioning.status, "outcome_unknown"); reopened.close();
});

test("provider no-child proof allows release but unknown launching cannot be cleared", () => {
  const f = fixture(), { claim, operation } = resident(f); finish(f.store, claim, operation);
  f.store.processStarting(claim); assert.throws(() => f.store.release(claim), /unknown/); assert.throws(() => f.store.setProcess(claim, null), /unknown/);
  f.store.processNotLaunched(claim); f.store.setProcess(claim, null); f.store.release(claim); assert.equal(f.store.worker(), null); f.store.close();
});

test("close admitted before failed release retires atomically with exact cleanup receipt", () => {
  const f = fixture(), s = f.store, { claim, operation } = resident(f);
  s.setMeta(claim, { phase: "ready", native_session_id: "session" });
  s.updateOperation(claim, operation.operation_id, { status: "started", effects: { configuration: { model: { value: "m", status: "applied" }, effort: { value: "e", status: "submitted" } }, prompt: { status: "not_sent" } } });
  const queued = s.admit("follow_up", { task: "unsent" }), close = s.admitClose(operationId());
  const receipt = { native: null, process: { code: 0, signal: null } }, failure = { code: "connection_lost", message: "disconnected" };
  s.release(claim, { disconnect_error: failure, cleanup_receipt: receipt });
  assert.equal(s.worker(), null); assert.equal(s.meta().phase, "closed");
  assert.deepEqual(s.operation(close.operation_id).result, { ...receipt, retired: true, reason: "failed_worker_cleanup" });
  assert.equal(s.operation(close.operation_id).status, "completed");
  assert.equal(s.operation(operation.operation_id).status, "outcome_unknown");
  assert.deepEqual(s.operation(operation.operation_id).effects.configuration, { model: { value: "m", status: "applied" }, effort: { value: "e", status: "unknown" } });
  assert.equal(s.operation(queued.operation_id).status, "not_sent"); assert.deepEqual(s.pendingOperations(), []);
  assert.throws(() => s.admit("follow_up", { task: "late" }), /closed/); s.close();
});

test("failed release before close rejects stale ordinary admission and allows local retirement", async () => {
  const f = fixture(), s = f.store, { claim, operation } = resident(f);
  s.setMeta(claim, { phase: "ready" }); const staleService = AgentStore.open(f.meta.agent_id, f.env);
  assert.equal(staleService.meta().phase, "ready");
  s.release(claim, { disconnect_error: { message: "provider ended" } });
  assert.equal(s.meta().phase, "disconnected"); assert.equal(s.worker(), null); assert.equal(processIdentityStatus(claim.worker), "alive");
  for (const kind of ["follow_up", "configure", "interrupt", "respond"]) assert.throws(() => staleService.admit(kind, {}), /disconnected/);
  const result = await child(openChild + "try{s.admit('follow_up',{task:'late'});throw Error('unexpected admission')}catch(e){console.log(e.message)}s.close();", args(f));
  assert.match(result, /disconnected/); assert.equal(s.operation(operation.operation_id).status, "not_sent");
  const close = staleService.admitClose(operationId()); assert.equal(close.status, "completed"); assert.equal(close.result.retired, true);
  staleService.close(); s.close();
});

test("failed release preserves actual native-close failure and never clears unknown provider", () => {
  const f = fixture(), s = f.store, { claim } = resident(f), close = s.admitClose(operationId());
  const error = { message: "native closure rejected" };
  s.release(claim, { disconnect_error: { message: "transport ended" }, cleanup_receipt: { native: null, native_error: error, process: { code: 1 } } });
  assert.equal(s.operation(close.operation_id).status, "outcome_unknown"); assert.deepEqual(s.operation(close.operation_id).error, error); assert.equal(s.meta().phase, "closed"); s.close();
  const g = fixture(), current = resident(g); g.store.processStarting(current.claim);
  const pendingClose = g.store.admitClose(operationId()), before = g.store.revision();
  assert.throws(() => g.store.release(current.claim, { disconnect_error: {}, cleanup_receipt: { process: { code: 0 } } }), /unknown/);
  assert.deepEqual(g.store.revision(), before); assert.equal(g.store.operation(pendingClose.operation_id).status, "admitted"); assert.notEqual(g.store.worker(), null); g.store.close();
});

test("runtime aliases and replaced database custody reject access without repair", () => {
  const f = fixture(), alias = join(f.root, "alias"); symlinkSync(f.env.GROKPAIR_HOME, alias);
  assert.throws(() => runtimeCoordinates({ ...f.env, GROKPAIR_HOME: alias }), /symlink/);
  const original = f.store.databasePath; renameSync(original, original + ".kept"); writeFileSync(original, "replacement");
  assert.throws(() => f.store.meta(), /custody changed/); assert.throws(() => f.store.admit("follow_up", {}), /custody changed/); f.store.close(); assert.equal(readFileSync(original, "utf8"), "replacement");
});

test("authoritative cancellation atomically expires only matching pending attention and unsent answer", () => {
  const f = fixture(), s = f.store, { claim } = resident(f), prompt = "native:cancelled";
  const pending = { request_id: "request:exact", prompt_id: prompt, method: "_x.ai/ask_user_question",
    payload: { tool_call_id: "tool:exact", questions: [{ question: " Exact?\r\n", options: [{ label: "A" }] }], _meta: { future: false } }, status: "pending" };
  s.upsertTurn(claim, { prompt_id: prompt, status: "running", source: "live_update" });
  s.upsertAttention(claim, pending);
  const answer = s.admit("respond", { request_id: pending.request_id, response: { method: "_x.ai/ask_user_question", answers: [] } });
  const untouched = [
    { ...pending, request_id: "other", prompt_id: "other-prompt" },
    { request_id: "unscoped", method: "_x.ai/ask_user_question", payload: {}, status: "pending" },
    { ...pending, request_id: "resolved", status: "resolved", response: { exact: true } },
    { ...pending, request_id: "expired", status: "expired", reason: "previous_reason" },
  ];
  for (const item of untouched) s.upsertAttention(claim, item);
  const reader = AgentStore.open(f.meta.agent_id, f.env, { readonly: true });
  const terminal = { prompt_id: prompt, status: "cancelled", source: "turn_completed" };
  reader.snapshot(() => {
    const revision = reader.revision();
    assert.equal(reader.getAttention(pending.request_id).status, "pending");
    assert.deepEqual(s.upsertTurn(claim, terminal), [pending.request_id]);
    assert.equal(reader.turn(prompt).status, "running");
    assert.equal(reader.getAttention(pending.request_id).status, "pending");
    assert.equal(reader.operation(answer.operation_id).status, "admitted");
    assert.deepEqual(reader.revision(), revision);
  });
  const expired = s.getAttention(pending.request_id);
  assert.deepEqual(expired, { ...pending, response_operation_id: answer.operation_id, status: "expired",
    reason: "prompt_cancelled", source: terminal.source, expired_at: expired.expired_at });
  assert.ok(Number.isFinite(Date.parse(expired.expired_at)));
  assert.equal(reader.turn(prompt).status, "cancelled");
  assert.equal(reader.getAttention(pending.request_id).status, "expired");
  assert.equal(reader.operation(answer.operation_id).status, "not_sent");
  assert.equal(s.operation(answer.operation_id).input.request_id, pending.request_id);
  for (const item of untouched) assert.deepEqual(s.getAttention(item.request_id), item);
  const revision = s.revision();
  assert.deepEqual(s.upsertTurn(claim, terminal), []);
  assert.deepEqual(s.revision(), revision);
  assert.throws(() => s.upsertAttention(claim, pending), /reopened/);
  assert.throws(() => s.admit("respond", { request_id: pending.request_id }), /not pending/);
  assert.deepEqual(s.revision(), revision);
  reader.close(); s.close();
  const reopened = AgentStore.open(f.meta.agent_id, f.env);
  assert.deepEqual(reopened.getAttention(pending.request_id), expired);
  assert.equal(reopened.operation(answer.operation_id).status, "not_sent");
  const db = new DatabaseSync(reopened.databasePath, { readOnly: true });
  assert.equal(db.prepare("SELECT value FROM state WHERE key='format'").get().value, "1");
  db.close(); reopened.close();
});

test("cancel-first insertion expires immediately; completion and unauthoritative cancellation do not infer expiry", () => {
  const f = fixture(), s = f.store, { claim } = resident(f);
  for (const [source, method] of [["prompt_response", "session/request_permission"], ["turn_completed", "_x.ai/ask_user_question"]]) {
    const prompt_id = `cancelled:${source}`;
    s.upsertTurn(claim, { prompt_id, status: "cancelled", source });
    const pending = { request_id: `request:${source}`, prompt_id, method, payload: { native_exact: "unchanged" }, status: "pending" };
    const stored = s.upsertAttention(claim, pending);
    assert.equal(stored.status, "expired"); assert.equal(stored.reason, "prompt_cancelled"); assert.equal(stored.source, source);
    assert.deepEqual(stored.payload, pending.payload); assert.deepEqual(s.getAttention(pending.request_id), stored);
    const revision = s.revision(), count = s.operations().length;
    assert.throws(() => s.admit("respond", { request_id: pending.request_id }), /not pending/);
    assert.deepEqual(s.revision(), revision); assert.equal(s.operations().length, count);
  }
  for (const [status, source] of [["completed", "prompt_response"], ["cancelled", "live_update"], ["unknown", "turn_completed"], ["cancelled", "removed_from_queue"]]) {
    const prompt_id = `${status}:${source}`, pending = { request_id: `request:${prompt_id}`, prompt_id, method: "_x.ai/ask_user_question", payload: {}, status: "pending" };
    s.upsertAttention(claim, pending); s.upsertTurn(claim, { prompt_id, status, source });
    assert.deepEqual(s.getAttention(pending.request_id), pending);
  }
  s.close();
});

test("removed prompt receipts retire autonomous activity without fabricating terminality or expiring attention", () => {
  const f = fixture(), s = f.store, { claim, operation } = resident(f), prompt_id = "removed:combined";
  s.setMeta(claim, { phase: "ready" }); finish(s, claim, operation);
  const prompt = s.admit("follow_up", { task: "Same text is not receiver identity" });
  s.updateOperation(claim, prompt.operation_id, { status: "started", native_prompt_id: prompt_id });
  s.upsertTurn(claim, { prompt_id, status: "running", source: "live_update" });
  const queue = { entries: [{ id: prompt_id, version: 0 }], runningPromptId: prompt_id };
  s.setObservation(claim, "queue", queue);
  const pending = { request_id: "removed:pending", prompt_id, method: "_x.ai/exit_plan_mode", payload: { planContent: "Exact plan" }, status: "pending" };
  s.upsertAttention(claim, pending);
  const answer = s.admit("respond", { request_id: pending.request_id, response: { outcome: "approved" } });
  const result = { stopReason: "cancelled", _meta: { promptId: prompt_id, completionKind: "removedFromQueue", future: { exact: true } } };
  s.updateOperation(claim, prompt.operation_id, { status: "completed", result });
  assert.equal(removedFromQueue(s.operation(prompt.operation_id)), true);
  assert.deepEqual(s.operation(prompt.operation_id).result, result);
  assert.deepEqual(promptActivity(s, prompt_id), { turn: null, inactive: true, removed_from_queue: true });
  assert.equal(s.turn(prompt_id).status, "running", "raw first-chunk inference remains retained");
  assert.deepEqual(effectiveQueue(s), { queued: 0, running: false, observation: { status: "observed" } });
  assert.deepEqual(s.observation("queue"), queue, "derivation never rewrites the native snapshot");
  assert.equal(s.getAttention(pending.request_id).status, "pending");
  assert.equal(s.operation(answer.operation_id).status, "admitted");
  const late = { ...pending, request_id: "removed:late" };
  assert.deepEqual(s.upsertAttention(claim, late), late);
  assert.equal(summarizeAgent(s).status, "attention");
  assert.throws(() => s.admit("interrupt", { prompt_id }), error => error.code === "prompt_not_queued");
  // A genuine terminal notification still carries its own meaning if it arrives.
  s.upsertTurn(claim, { prompt_id, status: "cancelled", source: "turn_completed", stop_reason: "cancelled" });
  assert.equal(promptActivity(s, prompt_id).turn.status, "cancelled");
  assert.equal(s.getAttention(pending.request_id).status, "expired");
  assert.equal(s.getAttention(late.request_id).status, "expired");
  assert.equal(s.operation(answer.operation_id).status, "not_sent"); s.close();
});

test("retained false removal terminals stay raw, do not cancel late attention and never reopen expired attention", () => {
  const f = fixture(), s = f.store, { claim, operation } = resident(f), prompt_id = "removed:legacy";
  s.setMeta(claim, { phase: "ready" }); finish(s, claim, operation);
  s.setObservation(claim, "queue", { entries: [{ id: prompt_id, version: 3 }], runningPromptId: prompt_id });
  const terminal = { prompt_id, status: "cancelled", source: "removed_from_queue", stop_reason: "cancelled" };
  s.upsertTurn(claim, terminal);
  assert.deepEqual(s.turn(prompt_id), terminal);
  assert.deepEqual(promptActivity(s, prompt_id), { turn: null, inactive: true, removed_from_queue: true });
  assert.equal(summarizeAgent(s).status, "idle");
  const pending = { request_id: "legacy:late", prompt_id, method: "_x.ai/exit_plan_mode", payload: {}, status: "pending" };
  assert.deepEqual(s.upsertAttention(claim, pending), pending);
  const expired = { ...pending, request_id: "legacy:expired", status: "expired", reason: "prompt_cancelled", source: "removed_from_queue" };
  s.upsertAttention(claim, expired);
  assert.throws(() => s.upsertAttention(claim, { ...expired, status: "pending" }), /reopened/);
  assert.deepEqual(s.getAttention(expired.request_id), expired); s.close();
});

test("resolved answer wins cancellation while started but unresolved response is not falsely not_sent", () => {
  const f = fixture(), s = f.store, { claim } = resident(f);
  for (const resolved of [false, true]) {
    const prompt_id = `race:${resolved}`, request_id = `request:${resolved}`;
    s.upsertAttention(claim, { request_id, prompt_id, method: "_x.ai/ask_user_question", payload: { exact: true }, status: "pending" });
    const answer = s.admit("respond", { request_id });
    s.updateOperation(claim, answer.operation_id, { status: "started" });
    if (resolved) {
      s.resolveAttention(claim, request_id, { response: { exact: "answer" } });
      s.updateOperation(claim, answer.operation_id, { status: "completed" });
    }
    const previous = s.getAttention(request_id);
    s.upsertTurn(claim, { prompt_id, status: "cancelled", source: "prompt_response" });
    assert.equal(s.operation(answer.operation_id).status, resolved ? "completed" : "started");
    if (resolved) assert.deepEqual(s.getAttention(request_id), previous);
    else assert.equal(s.getAttention(request_id).status, "expired");
  }
  s.close();
});

test("native interaction closure matches exact method-specific tool IDs and atomically expires unsent answers", () => {
  const f = fixture(), s = f.store, { claim } = resident(f), toolCallId = " tool:exact\r\n";
  const pending = [
    { request_id: "question", method: "_x.ai/ask_user_question", payload: { toolCallId, questions: [], _meta: { keep: null } }, status: "pending" },
    { request_id: "permission", method: "session/request_permission", payload: { toolCallId: "misleading", toolCall: { toolCallId, title: "Exact" } }, status: "pending" },
    { request_id: "elicitation", method: "_x.ai/mcp/elicit", payload: { toolCallId, serverName: "server", mode: "form" }, status: "pending" },
  ];
  const untouched = [
    { request_id: "foreign", method: "_x.ai/exit_plan_mode", payload: { toolCallId: toolCallId.trim() }, status: "pending" },
    { request_id: "wrong-permission-field", method: "session/request_permission", payload: { toolCallId, toolCall: { toolCallId: "foreign" } }, status: "pending" },
    { request_id: "wrong-xai-field", method: "_x.ai/ask_user_question", payload: { toolCall: { toolCallId } }, status: "pending" },
    { request_id: "wrong-method", method: "elicitation/create", payload: { toolCallId }, status: "pending" },
    { request_id: "unscoped", method: "_x.ai/ask_user_question", payload: {}, status: "pending" },
    { ...pending[0], request_id: "resolved", status: "resolved", response: { outcome: "cancelled" } },
    { ...pending[0], request_id: "expired", status: "expired", reason: "earlier" },
  ];
  for (const attention of [...pending, ...untouched]) s.upsertAttention(claim, attention);
  const answer = s.admit("respond", { request_id: "elicitation", response: { outcome: "cancel" } });
  const before = s.revision();
  assert.throws(() => s.resolveNativeInteraction({ ...claim, token: "wrong" }, toolCallId), /fence/);
  assert.deepEqual(s.resolveNativeInteraction(claim, "foreign-unknown"), []);
  assert.deepEqual(s.revision(), before);
  const reader = AgentStore.open(f.meta.agent_id, f.env, { readonly: true });
  reader.snapshot(() => {
    assert.equal(reader.getAttention("elicitation").status, "pending");
    assert.deepEqual(new Set(s.resolveNativeInteraction(claim, toolCallId)), new Set(pending.map(item => item.request_id)));
    assert.equal(reader.getAttention("elicitation").status, "pending");
    assert.equal(reader.operation(answer.operation_id).status, "admitted");
  });
  for (const attention of pending) {
    const expired = s.getAttention(attention.request_id);
    assert.equal(expired.status, "expired"); assert.equal(expired.reason, "interaction_resolved");
    assert.equal(expired.source, "native_interaction_resolved"); assert.deepEqual(expired.payload, attention.payload);
    assert.equal(expired.request_id, attention.request_id);
    assert.ok(Number.isFinite(Date.parse(expired.expired_at)));
  }
  assert.equal(reader.operation(answer.operation_id).status, "not_sent");
  assert.equal(s.getAttention("elicitation").response_operation_id, answer.operation_id);
  assert.deepEqual(s.operation(answer.operation_id).input.response, { outcome: "cancel" });
  for (const attention of untouched) assert.deepEqual(s.getAttention(attention.request_id), attention);
  const revision = s.revision();
  assert.deepEqual(s.resolveNativeInteraction(claim, toolCallId), []); assert.deepEqual(s.revision(), revision);
  assert.throws(() => s.admit("respond", { request_id: "question" }), /not pending/);
  reader.close(); s.close();
  const reopened = AgentStore.open(f.meta.agent_id, f.env, { readonly: true });
  assert.equal(reopened.getAttention("elicitation").reason, "interaction_resolved");
  assert.equal(reopened.operation(answer.operation_id).status, "not_sent"); reopened.close();
});

test("native interaction closure preserves started, unknown and already submitted response effects", () => {
  const f = fixture(), s = f.store, { claim } = resident(f);
  for (const status of ["started", "outcome_unknown", "completed"]) {
    const request_id = `request:${status}`, toolCallId = `tool:${status}`;
    s.upsertAttention(claim, { request_id, method: "_x.ai/exit_plan_mode", payload: { toolCallId }, status: "pending" });
    const answer = s.admit("respond", { request_id, response: { outcome: "abandoned" } });
    s.updateOperation(claim, answer.operation_id, { status: "started", effects: { native_response: { status: "submitted" } } });
    if (status === "completed") s.resolveAttention(claim, request_id);
    if (status !== "started") s.updateOperation(claim, answer.operation_id, { status });
    const beforeAttention = s.getAttention(request_id), beforeAnswer = s.operation(answer.operation_id);
    assert.deepEqual(s.resolveNativeInteraction(claim, toolCallId), status === "completed" ? [] : [request_id]);
    assert.deepEqual(s.operation(answer.operation_id), beforeAnswer);
    if (status === "completed") assert.deepEqual(s.getAttention(request_id), beforeAttention);
    else assert.equal(s.getAttention(request_id).status, "expired");
  }
  s.close();
});

test("native capabilities are one latest unscoped exact observation with stable sequence and format-1 reopen", () => {
  const f = fixture(), s = f.store, { claim } = resident(f);
  const capability = { protocol_version: 1, agent_info: { name: "native", version: "future", _meta: { exact: false } },
    capabilities: { promptCapabilities: { image: false, audio: true }, loadSession: false, _meta: { extension: null } } };
  s.setObservation(claim, "native_capabilities", capability);
  const first = s.records().find(row => row.type === "native_capabilities"), revision = s.revision();
  assert.equal(first.prompt_id, undefined); assert.deepEqual(first.value, capability);
  s.setObservation(claim, "native_capabilities", structuredClone(capability)); assert.deepEqual(s.revision(), revision);
  s.appendContent(claim, { prompt_id: "p", block_index: 0, text: "result" });
  assert.equal(s.records({ prompt_id: "p" }).some(row => row.type === "native_capabilities"), false);
  const changed = { protocol_version: 2 };
  s.setObservation(claim, "native_capabilities", changed);
  const latest = s.records().find(row => row.type === "native_capabilities");
  assert.equal(latest.seq, first.seq); assert.ok(latest.change > first.change); assert.equal(s.count("native_capabilities"), 1);
  assert.deepEqual(s.observation("native_capabilities"), changed);
  s.close(); const reopened = AgentStore.open(f.meta.agent_id, f.env);
  assert.deepEqual(reopened.observation("native_capabilities"), changed); reopened.close();
});

test("runtime contract marker fences non-create reads and writes without migrating old state", () => {
  assert.equal(RUNTIME_CONTRACT, 2);
  for (const marker of [null, 0, "2", 1, 7]) {
    const f = fixture(), s = f.store; reserve(f);
    const db = new DatabaseSync(s.databasePath);
    assert.equal(db.prepare("SELECT value FROM state WHERE key='runtime_contract'").get().value, "2");
    if (marker === null) db.prepare("DELETE FROM state WHERE key='runtime_contract'").run();
    else db.prepare("UPDATE state SET value=? WHERE key='runtime_contract'").run(JSON.stringify(marker));
    const before = db.prepare("SELECT * FROM records ORDER BY seq").all();
    assert.throws(() => s.meta(), error => error.code === "runtime_contract_mismatch");
    assert.throws(() => s.records(), /runtime contract/);
    assert.throws(() => s.admit("follow_up", { task: "forbidden" }), /runtime contract/);
    for (const readonly of [true, false]) assert.throws(() => AgentStore.open(f.meta.agent_id, f.env, { readonly }), /runtime contract/);
    assert.deepEqual(db.prepare("SELECT * FROM records ORDER BY seq").all(), before);
    assert.equal(db.prepare("SELECT value FROM state WHERE key='runtime_contract'").get()?.value ?? null, marker === null ? null : JSON.stringify(marker));
    db.close(); s.close();
  }
});

test("background and elicitation completion records retain independent exact identities", () => {
  const f = fixture(), s = f.store, { claim } = resident(f);
  const first = { task_id: "task:one", status: "running", title: " Full\n title ", result: { exact: false }, native: { future: null } };
  s.upsertObservation(claim, "background", "task:one", first);
  s.upsertObservation(claim, "background", "task:two", { task_id: "task:two", status: "running" });
  const before = s.records().find(record => record.type === "background" && record.id === "task:one"), revision = s.revision();
  s.upsertObservation(claim, "background", "task:one", structuredClone(first)); assert.deepEqual(s.revision(), revision);
  const complete = { ...first, status: "completed", description: "not truncated", result: { whole: "result" } };
  s.upsertObservation(claim, "background", "task:one", complete);
  assert.equal(s.count("background"), 2); assert.deepEqual(s.observation("background", "task:one"), complete);
  assert.equal(s.records().find(record => record.type === "background" && record.id === "task:one").seq, before.seq);
  const notice = { method: "elicitation/complete", payload: { elicitationId: "exact", future: [false, null] } };
  s.upsertObservation(claim, "elicitation_completion", "exact", notice);
  assert.deepEqual(s.observation("elicitation_completion", "exact"), notice);
  assert.equal(s.count("attention"), 0); assert.equal(s.count("issue"), 0);
  s.close();
  const reopened = AgentStore.open(f.meta.agent_id, f.env, { readonly: true });
  assert.deepEqual(reopened.observation("elicitation_completion", "exact"), notice); reopened.close();
});

test("native file metadata updates stable scoped identities and retains both path and URI", () => {
  const f = fixture(), s = f.store, { claim } = resident(f);
  const scope = { prompt_id: "p", tool_call_id: "t" };
  const first = s.upsertFile(claim, { ...scope, path: "/native/full path.png", name: "first" });
  const initial = s.records().find(row => row.type === "file"), revision = s.revision();
  assert.deepEqual(s.upsertFile(claim, { ...scope, path: "/native/full path.png", name: "first" }), first);
  assert.deepEqual(s.revision(), revision);
  const updated = s.upsertFile(claim, { ...scope, uri: "file:///native/full%20path.png", mime_type: "image/png", name: "exact final", description: "complete metadata" });
  assert.equal(updated.reference_id, first.reference_id); assert.equal(updated.path, first.path);
  assert.equal(updated.uri, "file:///native/full%20path.png"); assert.equal(updated.name, "exact final");
  assert.equal(s.records().find(row => row.type === "file").seq, initial.seq);
  const other = s.upsertFile(claim, { ...scope, prompt_id: "other", path: first.path });
  assert.notEqual(other.reference_id, first.reference_id); assert.equal(s.files().length, 2);
  const pathOnly = s.upsertFile(claim, { ...scope, path: "/native/different.png", name: "path owner" });
  const uriOnly = s.upsertFile(claim, { ...scope, uri: "https://example.invalid/asset", name: "URI owner" });
  const combined = s.upsertFile(claim, { ...scope, path: pathOnly.path, uri: uriOnly.uri, name: "new relationship" });
  assert.notEqual(combined.reference_id, pathOnly.reference_id); assert.notEqual(combined.reference_id, uriOnly.reference_id);
  assert.deepEqual(s.files().find(file => file.reference_id === pathOnly.reference_id), pathOnly);
  assert.deepEqual(s.files().find(file => file.reference_id === uriOnly.reference_id), uriOnly);
  const repeated = s.upsertFile(claim, { ...scope, path: pathOnly.path, uri: uriOnly.uri, name: "relationship update" });
  assert.equal(repeated.reference_id, combined.reference_id); assert.equal(s.files().length, 5);
  s.close();
});

test("interrupt with prompt_id captures exactly the queued version under admission's write transaction", () => {
  const f = fixture(), s = f.store, { claim } = resident(f);
  s.setObservation(claim, "queue", { entries: [{ id: "p", version: 1 }], runningPromptId: null });
  const stale = s.observation("queue");
  s.setObservation(claim, "queue", { entries: [{ id: "p", version: 2 }], runningPromptId: null });
  const operation = s.admit("interrupt", { prompt_id: "p", queue_target: { id: "injected", version: 99 } });
  assert.equal(stale.entries[0].version, 1); assert.deepEqual(operation.input.queue_target, { id: "p", version: 2 });
  s.setObservation(claim, "queue", { entries: [{ id: "p", version: 3 }], runningPromptId: null });
  assert.deepEqual(s.operation(operation.operation_id).input.queue_target, { id: "p", version: 2 });
  const collisionRevision = s.revision();
  assert.throws(() => s.admit("interrupt", { prompt_id: "p" }, { operation_id: operation.operation_id }), /already admitted/);
  assert.deepEqual(s.revision(), collisionRevision);
  const root = s.admit("interrupt", {}); assert.equal(root.input.queue_target, undefined);
  s.close();
});

test("queued removal rejects unknown, running, absent, stale and unversioned targets before admission", () => {
  const f = fixture(), s = f.store, { claim } = resident(f);
  const denied = code => {
    const revision = s.revision(), count = s.operations().length;
    assert.throws(() => s.admit("interrupt", { prompt_id: "p" }), error => error.code === code);
    assert.deepEqual(s.revision(), revision); assert.equal(s.operations().length, count);
  };
  denied("queue_not_observed");
  s.setObservation(claim, "queue", { entries: [], unavailable: true }); denied("queue_not_observed");
  s.setObservation(claim, "queue", { entries: [], runningPromptId: "p" }); denied("prompt_running");
  s.setObservation(claim, "queue", { entries: [], runningPromptId: null }); denied("prompt_not_queued");
  s.setObservation(claim, "queue", { entries: [{ id: "p" }], runningPromptId: null }); denied("queue_version_unknown");
  s.setObservation(claim, "queue", { entries: [{ id: "p", version: 1 }, { id: "p", version: 2 }] }); denied("prompt_not_queued");
  s.setObservation(claim, "queue", { entries: [{ id: "p", version: 2 }], runningPromptId: null });
  s.upsertTurn(claim, { prompt_id: "p", status: "completed", source: "prompt_response" }); denied("prompt_not_queued");
  s.close();
});

test("ready distinguishes unknown queue from observed idle without suppressing positive root activity", () => {
  const f = fixture(), s = f.store, { claim, operation } = resident(f);
  s.setMeta(claim, { phase: "ready" }); finish(s, claim, operation);
  const fresh = summarizeAgent(s);
  assert.equal(fresh.status, "ready"); assert.equal(fresh.counts.queued_prompts, null);
  assert.equal(fresh.queue_observation.status, "unknown"); assert.match(fresh.queue_observation.reason, /No native/);
  s.setObservation(claim, "queue", { entries: [], runningPromptId: null });
  assert.deepEqual(effectiveQueue(s), { queued: 0, running: false, observation: { status: "observed" } });
  assert.equal(summarizeAgent(s).status, "idle");
  s.setObservation(claim, "queue", { entries: [], unavailable: true, reason: "native unavailable" });
  assert.equal(summarizeAgent(s).status, "ready"); assert.equal(summarizeAgent(s).counts.queued_prompts, null);
  assert.deepEqual(summarizeAgent(s).queue_observation, { status: "unknown", reason: "native unavailable" });
  s.upsertTurn(claim, { prompt_id: "active", status: "running", source: "live_update" });
  assert.equal(summarizeAgent(s).status, "working");
  s.upsertTurn(claim, { prompt_id: "active", status: "completed", source: "prompt_response" });
  s.setObservation(claim, "queue", { entries: "malformed", runningPromptId: "positive" });
  assert.equal(summarizeAgent(s).status, "working"); assert.equal(summarizeAgent(s).counts.queued_prompts, null);
  s.close();
});
