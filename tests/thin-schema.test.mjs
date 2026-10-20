import assert from "node:assert/strict";
import { build } from "esbuild";
import Ajv from "ajv";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertPublicInputPropertyContract } from "../scripts/public-schema-contract.mjs";

const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "grokpair-thin-schema-")));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
await build({
  stdin: { contents: 'export * from "./src/agent-schema.ts"; export { PUBLIC_SCHEMA_VERSION } from "./src/core.ts";', resolveDir: new URL("../", import.meta.url).pathname, loader: "ts" },
  outfile: join(scratch, "schema.mjs"), bundle: true, platform: "node", format: "esm",
});
const { parseToolInput: parse, publicInputSchema, ToolInputSchemas, toolDefinitions, SEND_ACTION_MATRIX, PUBLIC_SCHEMA_VERSION } = await import(join(scratch, "schema.mjs"));
const agent_id = "agent_12345678-1234-4123-8123-123456789abc";
const request_id = "request_12345678-1234-4123-8123-123456789abc";
const prompt_id = "native:opaque-prompt";
const task = "Return a useful analysis.";
const ajv = new Ajv({ strict: false, allErrors: true });
const validators = Object.fromEntries(Object.keys(ToolInputSchemas).map(name => [name, ajv.compile(publicInputSchema(name))]));
function accepts(name, input) {
  assert.doesNotThrow(() => parse(name, input));
  assert.equal(validators[name](input), true, JSON.stringify(validators[name].errors));
}
function rejects(name, input) {
  assert.throws(() => parse(name, input));
  assert.equal(validators[name](input), false, `Published schema accepted ${JSON.stringify(input)}`);
}
function rejectsDomain(name, input) {
  assert.throws(() => parse(name, input));
  assert.equal(validators[name](input), true, "Action policy must not fork the published structural schema");
}

test("eight closed agent-first tools and valid published examples", () => {
  assert.equal(PUBLIC_SCHEMA_VERSION, "3");
  assert.deepEqual(toolDefinitions.map(({ name }) => name), ["grok_spawn", "grok_send", "grok_wait", "grok_read", "grok_list", "grok_respond", "grok_interrupt", "grok_close"]);
  for (const { name } of toolDefinitions) {
    const schema = publicInputSchema(name);
    assertPublicInputPropertyContract(name, schema);
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
    for (const example of schema.examples ?? []) accepts(name, example);
  }
});

test("spawn defaults worktree false, omits sandbox and preserves exact native profile selections", () => {
  assert.deepEqual(parse("grok_spawn", { task, cwd: "/workspace/research" }), { task, cwd: "/workspace/research", worktree: false });
  for (const worktree of [false, true]) {
    for (const sandbox of ["off", "workspace", "read-only", "custom:research", " exact profile "]) {
      const input = { task, cwd: "/workspace/research", worktree, sandbox };
      accepts("grok_spawn", input); assert.deepEqual(parse("grok_spawn", input), input);
    }
  }
  for (const workspace of ["readonly", "worktree"]) rejects("grok_spawn", { task, cwd: "/workspace", workspace });
  for (const worktree of [null, "true", 1]) rejects("grok_spawn", { task, cwd: "/workspace", worktree });
  for (const sandbox of [null, "", " ", "\n\t", true]) rejects("grok_spawn", { task, cwd: "/workspace", sandbox });
  accepts("grok_spawn", { task, cwd: "/workspace/research", model: "native-model", effort: "native-effort", attachments: [{ path: "/workspace/input.pdf", kind: "reference" }, { path: "/workspace/input.png", kind: "image" }] });
  for (const input of [{ task }, { task, cwd: "relative" }, { task, cwd: "/workspace", quality: "deep" },
    { task, cwd: "/workspace", interaction: {} }, { task, cwd: "/workspace", expected_files: [] },
    { task, cwd: "/workspace", model: " " }, { task, cwd: "/workspace", effort: "" },
    { task, cwd: "/workspace", attachments: [{ source: "path", path: "/input.png" }] },
    { task, cwd: "/workspace", attachments: [{ path: "/input.png" }] },
    { task, cwd: "/workspace", attachments: [{ path: "/input.png", type: "image" }] },
    { task, cwd: "/workspace", attachments: [{ path: "/input.png", kind: "text" }] },
    { task, cwd: "/workspace", attachments: [{ source: "artifact", agent_id, artifact_id: "old" }] }]) rejects("grok_spawn", input);
});

test("closed flat send structure delegates every action constraint to the domain parser", () => {
  const schema = publicInputSchema("grok_send");
  assert.equal(schema.anyOf, undefined);
  assert.equal(schema.oneOf, undefined);
  assert.equal(schema.allOf, undefined);
  assert.deepEqual(schema.required, ["agent_id"]);
  assert.equal(parse("grok_send", { agent_id, task }).action, "follow_up");
  const fields = { task, attachments: [], search: {}, model: "native-model", effort: "native-effort", prompt_id, resume: true };
  for (const [action, contract] of Object.entries(SEND_ACTION_MATRIX)) {
    const base = { agent_id, action, ...(action === "configure" ? { model: "native-model" } : { task }), ...(action === "edit" ? { prompt_id } : {}) };
    accepts("grok_send", base);
    for (const [field, value] of Object.entries(fields)) {
      const permitted = [...contract.optional_fields, ...contract.required_fields].includes(field);
      (permitted ? accepts : rejectsDomain)("grok_send", { ...base, [field]: value });
    }
    for (const field of contract.required_fields) { const missing = { ...base }; delete missing[field]; rejectsDomain("grok_send", missing); }
  }
  accepts("grok_send", { agent_id, task, resume: false });
  accepts("grok_send", { agent_id, action: "configure", effort: "native-effort" });
  accepts("grok_send", { agent_id, action: "configure", model: "native-model", effort: "native-effort" });
  rejectsDomain("grok_send", { agent_id, action: "configure" });
  rejectsDomain("grok_send", { agent_id });
  rejectsDomain("grok_send", { agent_id, task, model: "native-model" });
  rejectsDomain("grok_send", { agent_id, task, prompt_id });
  rejectsDomain("grok_send", { agent_id, task, action: "edit" });
  rejectsDomain("grok_send", { agent_id, task, action: "edit", prompt_id, attachments: [] });
  accepts("grok_send", { agent_id, task, action: "steer", attachments: [{ path: "/input.png", kind: "image" }] });
  rejectsDomain("grok_send", { agent_id, task, action: "steer", attachments: [{ path: "/input.pdf", kind: "reference" }] });
  for (const field of ["message_id", "turn_id", "quality", "expected_files", "interaction"]) rejects("grok_send", { agent_id, task, [field]: "old" });
});

test("read/wait take a view and one opaque cursor; wait has until and a shared budget; list filters by include_closed and key", () => {
  assert.deepEqual(parse("grok_read", { agent_id }), { agent_id, max_chars: 32000 });
  for (const view of ["result", "records"]) accepts("grok_read", { agent_id, view, prompt_id, cursor: "opaque-page", max_chars: 500000 });
  for (const input of [{ agent_id, turn_id: "old" }, { agent_id, view: "diagnostics" }, { agent_id, view: "" }, { agent_id, max_chars: 0 }, { agent_id, max_chars: Number.MAX_SAFE_INTEGER + 1 }]) rejects("grok_read", input);
  accepts("grok_wait", { targets: [{ agent_id, cursor: "opaque-wait" }], timeout_ms: 0 });
  assert.deepEqual(parse("grok_wait", { targets: [{ agent_id }] }), { targets: [{ agent_id }], until: "settled", timeout_ms: 120000, max_chars: 32000 });
  for (const until of ["settled", "change"]) assert.equal(parse("grok_wait", { targets: [{ agent_id }], until }).until, until);
  accepts("grok_wait", { targets: [{ agent_id }], until: "change", view: "records" });
  for (const until of ["changed", "idle", ""]) rejects("grok_wait", { targets: [{ agent_id }], until });
  rejects("grok_wait", { targets: [{ agent_id }], view: "all" });
  for (const max_chars of [1, 999, 500001, Number.MAX_SAFE_INTEGER]) accepts("grok_wait", { targets: [{ agent_id }], max_chars });
  for (const max_chars of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) rejects("grok_wait", { targets: [{ agent_id }], max_chars });
  rejects("grok_wait", { targets: [], timeout_ms: 0 });
  rejects("grok_wait", { targets: [{ agent_id }], timeout_ms: 600001 });
  // Distinct agents are a runtime refinement, not JSON Schema object uniqueness.
  assert.throws(() => parse("grok_wait", { targets: [{ agent_id }, { agent_id, cursor: "different" }] }));
  assert.deepEqual(parse("grok_list", {}), { include_closed: false, limit: 20 });
  accepts("grok_list", { include_closed: true, key: "review-slice-1", limit: 100, cursor: "opaque-list" });
  assert.equal(parse("grok_list", { key: " exact key " }).key, " exact key ");
  for (const input of [{ view: "recent" }, { view: "active" }, { include_closed: "yes" }, { key: "" }, { key: " " }]) rejects("grok_list", input);
  for (const limit of [101, Number.MAX_SAFE_INTEGER]) accepts("grok_list", { limit });
  for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) rejects("grok_list", { limit });
});

test("spawn key is optional, exact and nonblank", () => {
  assert.equal(Object.hasOwn(parse("grok_spawn", { task, cwd: "/workspace" }), "key"), false);
  accepts("grok_spawn", { task, cwd: "/workspace", key: "review:slice-1" });
  assert.equal(parse("grok_spawn", { task, cwd: "/workspace", key: " exact\tkey " }).key, " exact\tkey ");
  for (const key of ["", " ", "\n", 7, null]) rejects("grok_spawn", { task, cwd: "/workspace", key });
  rejects("grok_send", { agent_id, task, key: "not a send field" });
});

test("tools leave native host result handling unmodified", () => {
  for (const tool of toolDefinitions) assert.equal(tool._meta, undefined, tool.name + " must not override host result handling");
});

test("responses are native objects under a closed root, with union only nested", () => {
  const schema = publicInputSchema("grok_respond");
  assert.equal(schema.anyOf, undefined);
  assert.equal(schema.oneOf, undefined);
  assert.ok(schema.properties.response.anyOf);
  for (const response of [
    { outcome: { outcome: "selected", optionId: "allow_once" } }, { outcome: { outcome: "cancelled" } },
    { outcome: "accepted", answers: { "Which target?": ["One"] } }, { outcome: "accepted", answers: {} },
    { outcome: "accepted", answers: { "Which target?": "One", "Anything else?": ["", "Two"] } },
    { outcome: "accepted", answers: { "Which target?": "" } },
    { outcome: "accepted", answers: {}, annotations: null },
    { outcome: "accepted", answers: {}, annotations: { "Which target?": { notes: null, preview: "", extra: true } } },
    { outcome: "chat_about_this", partial_answers: { "Which target?": "Still deciding" } },
    { outcome: "skip_interview", partial_answers: {} }, { outcome: "cancelled" },
    { outcome: "approved" }, { outcome: "abandoned", feedback: "" }, { outcome: "cancelled", feedback: null },
    { outcome: "accept", content: { selected: true } }, { outcome: "decline" }, { outcome: "cancel", content: null },
    { action: "accept", content: { selected: ["One"] } }, { action: "decline" }, { action: "accept", content: null },
    { outcome: "approved", extra_native_field: { retained: true } },
  ]) {
    accepts("grok_respond", { agent_id, request_id, response });
    assert.deepEqual(parse("grok_respond", { agent_id, request_id, response }).response, response);
  }
  for (const response of [
    { kind: "permission" }, { kind: "permission", cancelled: false }, { kind: "permission", option_id: "" },
    { kind: "permission", option_id: "allow_once", cancelled: true },
    { kind: "plan", decision: "revise" }, { kind: "plan", decision: "approve", feedback: "extra" },
    { outcome: { outcome: "selected", optionId: "" } }, { outcome: "accepted", answers: [] },
    { outcome: "accepted", answers: { Q: 1 } }, { outcome: "accepted", answers: { Q: null } },
    { outcome: "accepted", answers: { Q: ["One", 2] } }, { outcome: "skip_interview", partial_answers: { Q: [] } },
    { outcome: "accepted", answers: {}, annotations: { Q: { notes: 3 } } },
    { action: "accept", content: { nested: {} } },
  ]) rejects("grok_respond", { agent_id, request_id, response });
});

test("no wrapper caps on native strings, inputs, responses or wait targets", () => {
  const long = "x".repeat(200001);
  accepts("grok_spawn", { task: long, cwd: "/" + long, attachments: Array.from({ length: 17 }, () => ({ path: "/" + long, kind: "reference" })), search: { webSearch: { allowedDomains: [long] } } });
  accepts("grok_read", { agent_id, prompt_id: long, cursor: long, max_chars: 500001 });
  assert.equal(parse("grok_interrupt", { agent_id, prompt_id: " \t " }).prompt_id, " \t ");
  rejects("grok_interrupt", { agent_id, prompt_id: "" });
  accepts("grok_wait", { targets: Array.from({ length: 9 }, (_, i) => ({ agent_id: `agent_12345678-1234-4123-8123-${String(i).padStart(12, "0")}` })) });
  accepts("grok_respond", { agent_id, request_id, response: { outcome: "abandoned", feedback: long } });
  const answers = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [long + i, Array.from({ length: 65 }, () => "x".repeat(4097))]));
  accepts("grok_respond", { agent_id, request_id, response: { outcome: "accepted", answers } });
  rejects("grok_spawn", { task, cwd: "/workspace", search: { webSearch: { allowedDomains: Array(6).fill("example.org") } } });
});

test("interrupt selects queued native prompt, close has no unread or cancellation toggles", () => {
  accepts("grok_interrupt", { agent_id });
  accepts("grok_interrupt", { agent_id, prompt_id });
  accepts("grok_close", { agent_id });
  rejects("grok_interrupt", { agent_id, turn_id: "old" });
  rejects("grok_close", { agent_id, force: true });
  rejects("grok_close", { agent_id: "agent_not-a-uuid" });
});

test("typed native search values remain intact and synthetic media input is retired", () => {
  const search = { webSearch: { allowedDomains: ["example.org"] }, xSearch: { dateBound: { fromDate: "2026-01-01", toDate: "2026-02-01" } } };
  accepts("grok_spawn", { task, cwd: "/workspace", search });
  rejects("grok_spawn", { task, cwd: "/workspace", media: { operation: "image_gen" } });
  rejects("grok_send", { agent_id, task, media: { operation: "image_gen" } });
  assert.deepEqual(parse("grok_spawn", { task, cwd: "/workspace", search }).search, search);
  rejectsDomain("grok_spawn", { task, cwd: "/workspace", search: { webSearch: { allowedDomains: ["a.test"], excludedDomains: ["b.test"] } } });
  rejectsDomain("grok_spawn", { task, cwd: "/workspace", search: { xSearch: { dateBound: { fromDate: "2026-02-01", toDate: "2026-01-01" } } } });
  assert.throws(() => parse("grok_spawn", { task, cwd: "/workspace", search: { xSearch: { dateBound: { fromDate: "2026-02-30" } } } }));
});

test("native nested search nulls and domain strings retain their exact wire representation", () => {
  const cases = [
    { webSearch: null, xSearch: null },
    { webSearch: { allowedDomains: null, excludedDomains: ["example.org"] } },
    { webSearch: { allowedDomains: ["example.org"], excludedDomains: null } },
    { webSearch: { allowedDomains: null, excludedDomains: null } },
    { webSearch: { allowedDomains: ["", " "] } },
    { xSearch: { dateBound: null } },
    { xSearch: { dateBound: { fromDate: null, toDate: "2026-09-13" } } },
    { xSearch: { dateBound: { fromDate: "2026-09-13", toDate: null } } },
    { xSearch: { dateBound: { fromDate: null, toDate: null } } },
  ];
  for (const search of cases) {
    const before = structuredClone(search);
    for (const [name, base] of [["grok_spawn", { task, cwd: "/workspace" }], ["grok_send", { agent_id, task }]]) {
      accepts(name, { ...base, search });
      assert.deepEqual(parse(name, { ...base, search }).search, before);
    }
    assert.deepEqual(search, before);
  }
  rejects("grok_spawn", { task, cwd: "/workspace", search: { webSearch: { allowedDomains: null, excludedDomains: Array(6).fill("example.org") } } });
  rejects("grok_spawn", { task, cwd: "/workspace", search: { webSearch: { allowedDomains: [null] } } });
  rejectsDomain("grok_spawn", { task, cwd: "/workspace", search: { xSearch: { dateBound: { fromDate: null, toDate: "2026-02-30" } } } });
});

test("send guidance and public examples come from the same action contract without a duplicate root description", () => {
  const description = toolDefinitions.find(tool => tool.name === "grok_send").description;
  for (const contract of Object.values(SEND_ACTION_MATRIX)) {
    assert.ok(contract.description.trim());
    assert.equal(description.split(contract.description).length - 1, 1);
  }
  const schema = publicInputSchema("grok_send");
  assert.equal(schema.description, undefined);
  assert.deepEqual(schema.examples, Object.values(SEND_ACTION_MATRIX).map(contract => contract.example));
});
