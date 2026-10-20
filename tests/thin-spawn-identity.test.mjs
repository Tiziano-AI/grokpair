import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import test from "node:test";

const scratch = realpathSync(mkdtempSync(join(realpathSync("/private/tmp"), "grokpair-spawn-identity-")));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const bundle = join(scratch, "identity.mjs");
await build({ stdin: {
  contents: 'export * from "./src/agent-service.ts"; export * from "./src/agent-store.ts"; export { normalizedSpawnRequest } from "./src/agent-schema.ts";',
  resolveDir: new URL("../", import.meta.url).pathname, loader: "ts",
}, outfile: bundle, bundle: true, platform: "node", format: "esm" });
const { AgentService, AgentStore, WorkerLaunchError, normalizedSpawnRequest } = await import(bundle);

function fixture(launcher) {
  const root = realpathSync(mkdtempSync(join(scratch, "case-"))), cwd = join(root, "workspace");
  mkdirSync(cwd);
  const environment = { ...process.env, GROKPAIR_HOME: join(root, "runtime") }, launches = [];
  const service = new AgentService(environment, launcher ?? ((...args) => { launches.push(args); }));
  return { root, cwd, environment, service, launches };
}

function admitted(result) {
  assert.equal(result.call_status, "admitted", JSON.stringify(result));
  return result.agent_id;
}

function existing(result, agentId) {
  assert.equal(result.call_status, "existing", JSON.stringify(result));
  assert.equal(result.agent_id, agentId);
}

function conflict(result, agentId) {
  assert.equal(result.call_status, "error", JSON.stringify(result));
  assert.equal(result.error.code, "spawn_key_conflict", JSON.stringify(result));
  assert.equal(result.error.admission, "none");
  assert.equal(result.error.details.agent_id, agentId);
}

test("spawn identity validates, removes only the key and normalizes only omitted placement and attachments", () => {
  const request = { task: "  Compare e\u0301 with é.\r\n", cwd: "/workspace/research", key: "logical-work" };
  const copy = structuredClone(request);
  assert.deepEqual(normalizedSpawnRequest(request), {
    task: "  Compare e\u0301 with é.\r\n", cwd: "/workspace/research", worktree: false, attachments: [],
  });
  assert.deepEqual(request, copy, "normalization never changes the caller's input");
  assert.deepEqual(normalizedSpawnRequest(request), normalizedSpawnRequest({
    attachments: [], worktree: false, cwd: request.cwd, task: request.task, key: "another-key",
  }), "key and object-property order do not describe the requested native work");
  assert.throws(() => normalizedSpawnRequest({ ...request, unknown: true }));
  assert.throws(() => normalizedSpawnRequest({ ...request, task: "  " }));
  assert.throws(() => normalizedSpawnRequest({ ...request, search: {
    webSearch: { allowedDomains: ["one.example"], excludedDomains: ["two.example"] },
  } }), "stored input must pass the same cross-field validation as a fresh request");
});

test("spawn identity preserves native choices, exact text, attachment ordering and absent-versus-empty search", () => {
  const base = { task: "é\r\n", cwd: "/workspace/research" };
  const normalized = normalizedSpawnRequest(base);
  for (const changed of [
    { task: "é\n" }, { task: "é\r\n " }, { task: "e\u0301\r\n" },
    { cwd: "/workspace/other" }, { worktree: true }, { sandbox: "off" },
    { model: "native-default" }, { effort: "native-default" }, { search: {} },
    { attachments: [{ path: "/workspace/input.pdf", kind: "reference" }] },
  ]) assert.equal(isDeepStrictEqual(normalized, normalizedSpawnRequest({ ...base, ...changed })), false, JSON.stringify(changed));

  const full = {
    ...base, sandbox: "workspace", model: "native-model", effort: "native-effort",
    attachments: [{ path: "/workspace/first.pdf", kind: "reference" }, { path: "/workspace/second.png", kind: "image" }],
    search: { webSearch: { allowedDomains: ["one.example", "two.example"] }, xSearch: { dateBound: { fromDate: "2026-10-01" } } },
  };
  const fullNormalized = normalizedSpawnRequest(full);
  for (const changed of [
    { sandbox: "workspace " }, { model: "native-model " }, { effort: "native-effort " },
    { attachments: [...full.attachments].reverse() },
    { attachments: [{ ...full.attachments[0], path: "/workspace/renamed.pdf" }, full.attachments[1]] },
    { attachments: [{ ...full.attachments[0], kind: "image" }, full.attachments[1]] },
    { search: { webSearch: { allowedDomains: ["two.example", "one.example"] }, xSearch: full.search.xSearch } },
    { search: { webSearch: full.search.webSearch, xSearch: { dateBound: { fromDate: "2026-10-01", toDate: null } } } },
  ]) assert.equal(isDeepStrictEqual(fullNormalized, normalizedSpawnRequest({ ...full, ...changed })), false, JSON.stringify(changed));
  assert.deepEqual(fullNormalized.search, full.search);
  assert.deepEqual(fullNormalized.attachments, full.attachments);
});

test("keyed public spawn retries the whole original request and refuses each changed native input without admission", async () => {
  const f = fixture(), firstPath = join(f.cwd, "first.txt"), secondPath = join(f.cwd, "second.txt");
  writeFileSync(firstPath, "First reference."); writeFileSync(secondPath, "Second reference.");
  const input = {
    task: "Review é\r\n", cwd: f.cwd, key: "whole-request", sandbox: "workspace", model: "native-model", effort: "native-effort",
    attachments: [{ path: firstPath, kind: "reference" }, { path: secondPath, kind: "reference" }],
    search: { webSearch: { allowedDomains: ["one.example"] }, xSearch: { dateBound: { fromDate: "2026-10-01" } } },
  };
  const agentId = admitted(await f.service.invoke("grok_spawn", input));
  existing(await f.service.invoke("grok_spawn", {
    key: input.key, effort: input.effort, model: input.model, sandbox: input.sandbox,
    search: { xSearch: { dateBound: { fromDate: "2026-10-01" } }, webSearch: { allowedDomains: ["one.example"] } },
    attachments: input.attachments, worktree: false, cwd: input.cwd, task: input.task,
  }), agentId);
  for (const changed of [
    { task: "Review é\n" }, { task: "Review e\u0301\r\n" }, { cwd: join(f.root, "does-not-exist") },
    { worktree: true }, { sandbox: "off" }, { model: "other-model" }, { effort: "other-effort" },
    { attachments: [] }, { attachments: [...input.attachments].reverse() },
    { attachments: [{ path: join(f.cwd, "missing.txt"), kind: "reference" }, input.attachments[1]] },
    { attachments: [{ path: firstPath, kind: "image" }, input.attachments[1]] },
    { search: {} }, { search: { webSearch: null } },
    { search: { webSearch: { allowedDomains: ["two.example"] } } },
  ]) conflict(await f.service.invoke("grok_spawn", { ...input, ...changed }), agentId);
  const { sandbox: _sandbox, ...withoutSandbox } = input;
  const { model: _model, ...withoutModel } = input;
  const { effort: _effort, ...withoutEffort } = input;
  const { search: _search, ...withoutSearch } = input;
  for (const changed of [withoutSandbox, withoutModel, withoutEffort, withoutSearch]) {
    conflict(await f.service.invoke("grok_spawn", changed), agentId);
  }
  assert.equal(f.launches.length, 1, "conflicts never launch a second collaborator or preflight changed attachments");
  const store = AgentStore.open(agentId, f.environment, { readonly: true });
  try { assert.deepEqual(store.operations().map(operation => operation.input.task), [input.task]); } finally { store.close(); }
});

test("keyed public spawn normalizes omitted defaults but does not equate absent search with an empty override", async () => {
  const f = fixture(), input = { task: "Exact brief", cwd: f.cwd, key: "defaults" };
  const agentId = admitted(await f.service.invoke("grok_spawn", input));
  existing(await f.service.invoke("grok_spawn", { ...input, attachments: [], worktree: false }), agentId);
  conflict(await f.service.invoke("grok_spawn", { ...input, search: {} }), agentId);
  const store = AgentStore.open(agentId, f.environment, { readonly: true });
  try { assert.equal(store.operations().length, 1); } finally { store.close(); }
  assert.equal(f.launches.length, 1);
});

test("retry identity is not a file-content certificate and never rereads an original attachment", async () => {
  const f = fixture(), reference = join(f.cwd, "reference.txt");
  writeFileSync(reference, "Original bytes.");
  const input = { task: "Read the reference", cwd: f.cwd, key: "mutable-reference", attachments: [{ path: reference, kind: "reference" }] };
  const agentId = admitted(await f.service.invoke("grok_spawn", input));
  writeFileSync(reference, "Changed bytes.");
  existing(await f.service.invoke("grok_spawn", input), agentId);
  assert.equal(readFileSync(reference, "utf8"), "Changed bytes.");
  rmSync(reference);
  existing(await f.service.invoke("grok_spawn", input), agentId);
  assert.equal(f.launches.length, 1, "the same reference identity never triggers another send, even after its file changed or disappeared");
});

test("native reconfiguration and attempted operation input patches never replace the initial spawn request", async () => {
  let claim;
  const f = fixture((agentId, _meta, environment, token) => {
    const store = AgentStore.open(agentId, environment);
    try {
      claim = store.claim(token);
      const initial = store.operations()[0];
      store.updateOperation(claim, initial.operation_id, { status: "started" });
      store.updateOperation(claim, initial.operation_id, { status: "completed", input: { task: "Must not replace the original" } });
      store.setMeta(claim, { phase: "ready" });
      store.setObservation(claim, "queue", { entries: [] });
    } finally { store.close(); }
  });
  const input = { task: "Initial request", cwd: f.cwd, key: "configured", model: "first-model", effort: "first-effort" };
  const agentId = admitted(await f.service.invoke("grok_spawn", input));
  const configuration = await f.service.invoke("grok_send", { agent_id: agentId, action: "configure", model: "second-model", effort: "second-effort" });
  admitted(configuration);
  const store = AgentStore.open(agentId, f.environment);
  try {
    store.updateOperation(claim, configuration.operation_id, { status: "started" });
    store.updateOperation(claim, configuration.operation_id, { status: "completed" });
    store.setObservation(claim, "native_options", { options: [
      { id: "model", currentValue: "second-model" }, { id: "effort", currentValue: "second-effort" },
    ] });
    assert.equal(store.operations()[0].input.task, input.task);
  } finally { store.close(); }
  existing(await f.service.invoke("grok_spawn", input), agentId);
  conflict(await f.service.invoke("grok_spawn", { ...input, model: "second-model", effort: "second-effort" }), agentId);
});

test("failed launch and explicit resumed follow-up preserve the initial spawn's retry identity", async () => {
  const f = fixture(), input = { task: "Original work", cwd: f.cwd, key: "failed-launch", model: "initial-model" };
  let attempts = 0;
  const failing = new AgentService(f.environment, () => { attempts++; throw new WorkerLaunchError(new Error("No child was launched")); });
  const failed = await failing.invoke("grok_spawn", input);
  assert.equal(failed.call_status, "error"); assert.equal(failed.error.admission, "confirmed");
  const agentId = failed.error.agent_id;
  existing(await f.service.invoke("grok_spawn", input), agentId);
  conflict(await f.service.invoke("grok_spawn", { ...input, task: "Different work" }), agentId);
  assert.equal(attempts, 1); assert.equal(f.launches.length, 0);

  admitted(await f.service.invoke("grok_send", { agent_id: agentId, action: "follow_up", task: "Explicit new work", resume: true }));
  existing(await f.service.invoke("grok_spawn", input), agentId);
  conflict(await f.service.invoke("grok_spawn", { ...input, task: "Explicit new work" }), agentId);
  const store = AgentStore.open(agentId, f.environment, { readonly: true });
  try {
    assert.deepEqual(store.operations().map(operation => operation.input.task), [input.task, "Explicit new work"]);
    assert.equal(store.operations()[0].status, "not_sent");
    assert.equal(store.launch().resume, true);
  } finally { store.close(); }
  assert.equal(f.launches.length, 1, "only the explicit follow-up reserves and launches a new worker");
});

test("same-key caller race admits exactly one immutable initial request", async () => {
  const f = fixture(), input = { task: "Concurrent work", cwd: f.cwd, key: "concurrent" };
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => f.service.invoke("grok_spawn", {
    ...input, ...(index % 2 ? { attachments: [], worktree: false } : {}),
  })));
  assert.equal(results.filter(result => result.call_status === "admitted").length, 1, JSON.stringify(results));
  assert.equal(results.filter(result => result.call_status === "existing").length, 7, JSON.stringify(results));
  assert.equal(new Set(results.map(result => result.agent_id)).size, 1);
  assert.equal(f.launches.length, 1);
});

test("competing different requests with one key cannot admit both bodies", async () => {
  const f = fixture(), first = { task: "First body", cwd: f.cwd, key: "different-callers" };
  const results = await Promise.all([first, { ...first, task: "Different body" }].map(input => f.service.invoke("grok_spawn", input)));
  const winner = results.find(result => result.call_status === "admitted");
  assert.ok(winner, JSON.stringify(results));
  assert.equal(results.filter(result => result.call_status === "admitted").length, 1);
  conflict(results.find(result => result !== winner), winner.agent_id);
  assert.equal(f.launches.length, 1);
});

test("an explicit close releases the key; a changed spawn is not silently treated as a retry", async () => {
  const f = fixture(), input = { task: "First work", cwd: f.cwd, key: "closed-key" };
  const firstId = admitted(await f.service.invoke("grok_spawn", input));
  conflict(await f.service.invoke("grok_spawn", { ...input, task: "Second work" }), firstId);
  admitted(await f.service.invoke("grok_close", { agent_id: firstId }));
  const secondId = admitted(await f.service.invoke("grok_spawn", { ...input, task: "Second work" }));
  assert.notEqual(secondId, firstId); assert.equal(f.launches.length, 2);
  const retained = AgentStore.open(firstId, f.environment, { readonly: true });
  try { assert.equal(retained.meta().phase, "closed"); assert.equal(retained.operations()[0].input.task, input.task); } finally { retained.close(); }
});
