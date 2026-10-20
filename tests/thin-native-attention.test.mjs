import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const scratch = await realpath(await mkdtemp("/private/tmp/grokpair-thin-native-attention-"));
test.after(() => rm(scratch, { recursive: true, force: true }));
const outfile = join(scratch, "attention.mjs");
await build({ entryPoints: [new URL("../src/attention.ts", import.meta.url).pathname], outfile,
  bundle: true, platform: "node", format: "esm", target: "es2023" });
const { parseAttention: parse, validateAttentionResponse: respond, unwrapAttentionParams } = await import(pathToFileURL(outfile).href);
const invalid = { code: "invalid_attention_response" };
const badNative = { code: "invalid_native_attention" };
const base = { sessionId: " session\r\n", toolCallId: " tool " };
const q = " Exact question?\r\n";
const long = "long preview\r\n".repeat(50_000);
const questionPayload = () => ({ ...base, mode: "plan", _meta: { promptId: "p", nested: [null, { future: true }] },
  questions: [{ question: q, id: null, multiSelect: null, future: true,
    options: [{ label: "A", description: "", preview: long, id: "opaque", _meta: { untouched: null } }] },
  { question: "Other?", options: [] }], extra: null });
const question = () => parse("_x.ai/ask_user_question", questionPayload());
const form = (requestedSchema) => parse("_x.ai/mcp/elicit", { ...base, mode: "form", serverName: "server", message: "",
  ...(requestedSchema === undefined ? {} : { requestedSchema }) });

test("native payloads preserve every field, omission, null, ID and long preview after SDK unwrap", () => {
  const raw = questionPayload();
  const attention = parse("_x.ai/ask_user_question", { method: "x.ai/ask_user_question", params: raw, _meta: {} });
  assert.deepEqual(attention, { method: "_x.ai/ask_user_question", payload: raw });
  assert.equal("kind" in attention, false);
  assert.equal("multiSelect" in attention.payload.questions[1], false);
  assert.equal(attention.payload.questions[0].options[0].preview.length, long.length);
  assert.ok(Object.isFrozen(attention.payload.questions[0].options[0]));
  raw.questions[0].options[0].label = "changed";
  assert.equal(attention.payload.questions[0].options[0].label, "A");
  const extra = { ...questionPayload(), method: "unrelated native field" };
  assert.deepEqual(unwrapAttentionParams("_x.ai/ask_user_question", extra), extra);
  assert.equal(parse("not/a/proxy", {}), null);
});

test("known malformed payloads reject diagnostically without a manufactured decision", () => {
  const cases = [
    null, {}, { ...questionPayload(), questions: null }, { ...questionPayload(), sessionId: null },
    { ...questionPayload(), questions: [{ question: q, options: [{ label: 3, description: "" }] }] },
    { ...questionPayload(), questions: [{ question: q, options: [], multiSelect: "true" }] },
    { method: "x.ai/exit_plan_mode", params: questionPayload() },
  ];
  for (const raw of cases) assert.throws(() => parse("_x.ai/ask_user_question", raw), badNative);
});

test("accepted answers allow empty/partial maps, empty/duplicate/custom labels, Other and notes with ordinary labels", () => {
  const attention = question();
  const responses = [
    { outcome: "accepted", answers: {} },
    { outcome: "accepted", answers: { [q]: "A", "Other?": ["custom"] } },
    { outcome: "accepted", answers: { [q]: "" } },
    { outcome: "accepted", answers: { [q]: " Exact freeform\r\n" }, annotations: { [q]: { notes: "preserved" } } },
    { outcome: "accepted", answers: { [q]: [] }, annotations: null },
    { outcome: "accepted", answers: { [q]: ["Other"] }, annotations: { [q]: { notes: long, preview: null } } },
    { outcome: "accepted", answers: { [q]: ["A", "A", "custom", ""] }, annotations: { [q]: { notes: "ordinary option notes", preview: long, future: null } }, _meta: { retained: true } },
  ];
  for (const response of responses) {
    const before = structuredClone(response);
    assert.deepEqual(respond(attention, response), before);
    assert.deepEqual(response, before);
  }
  assert.deepEqual(attention, question());
});

test("question chat, skip and cancellation stay exact and malformed answers leave request usable", () => {
  const attention = question(), before = structuredClone(attention);
  for (const outcome of ["chat_about_this", "skip_interview"]) {
    for (const response of [{ outcome }, { outcome, partial_answers: {} }, { outcome, partial_answers: { [q]: "Other" }, _meta: null }])
      assert.deepEqual(respond(attention, response), response);
  }
  assert.deepEqual(respond(attention, { outcome: "cancelled" }), { outcome: "cancelled" });
  for (const response of [
    { outcome: "accepted", answers: { [q]: null } }, { outcome: "accepted", answers: { [q]: 1 } },
    { outcome: "accepted", answers: { [q]: ["A", 1] } }, { outcome: "accepted", answers: { wrong: ["A"] } },
    { outcome: "accepted", answers: { wrong: "A" } },
    { outcome: "accepted", answers: {}, annotations: { [q]: { notes: 1 } } },
    { outcome: "cancelled", answers: {} }, { outcome: "chat_about_this", partial_answers: null },
    { kind: "question", answers: [] }, { outcome: "approved" },
  ]) assert.throws(() => respond(attention, response), invalid);
  assert.deepEqual(attention, before);
  assert.deepEqual(respond(attention, { outcome: "accepted", answers: {} }), { outcome: "accepted", answers: {} });
});

test("permission request retains raw output/content and response requires the actual offered ID", () => {
  const payload = { ...base, toolCall: { toolCallId: "tool", title: "Run", rawInput: null,
    rawOutput: { text: long }, rawContent: [null, "native"], content: [{ type: "content", content: { type: "text", text: long } }], _meta: { future: 1 } },
  options: ["allow_once", "reject_always"].map((kind, i) => ({ optionId: " id " + i, name: "", kind, _meta: null })), extra: true };
  const attention = parse("session/request_permission", payload);
  assert.deepEqual(attention.payload, payload);
  for (const response of [{ outcome: { outcome: "selected", optionId: " id 0", _meta: null }, future: true }, { outcome: { outcome: "cancelled" } }])
    assert.deepEqual(respond(attention, response), response);
  for (const response of [{ outcome: { outcome: "selected", optionId: "id 0" } }, { outcome: { outcome: "cancelled", optionId: " id 0" } }, { outcome: "cancelled" }])
    assert.throws(() => respond(attention, response), invalid);
});

test("plan preserves omitted/null content and all native outcomes with empty/null/long feedback", () => {
  for (const payload of [{ ...base }, { ...base, planContent: null }, { ...base, planContent: long, _meta: null }]) {
    const attention = parse("_x.ai/exit_plan_mode", payload);
    assert.deepEqual(attention.payload, payload);
    for (const outcome of ["approved", "cancelled", "abandoned"]) {
      for (const response of [{ outcome }, ...["", null, long].map((feedback) => ({ outcome, feedback, extra: null }))])
        assert.deepEqual(respond(attention, response), response);
    }
    assert.throws(() => respond(attention, { outcome: "approved", feedback: false }), invalid);
  }
});

test("schema validation never coerces/defaults/strips; actual form content and schema metadata survive", () => {
  const schema = { $id: "shared", type: "object", properties: { count: { type: "integer", default: 2 }, email: { type: "string", format: "email" } }, required: ["count"], additionalProperties: false, _meta: { retained: null } };
  const attention = form(schema);
  assert.deepEqual(attention.payload.requestedSchema, schema);
  const response = { outcome: "accept", content: { count: 3, email: "a@example.test" }, _meta: { future: true } };
  assert.deepEqual(respond(attention, response), response);
  for (const content of [{}, { count: "3" }, { count: 3, extra: true }, { count: 3, email: "bad" }]) {
    const before = structuredClone(content);
    assert.throws(() => respond(attention, { outcome: "accept", content }), invalid);
    assert.deepEqual(content, before);
  }
  const second = form({ $id: "shared", type: "object", properties: { count: { type: "string" } }, required: ["count"] });
  assert.throws(() => respond(second, response), invalid);
  assert.deepEqual(respond(second, { outcome: "accept", content: { count: "three" } }), { outcome: "accept", content: { count: "three" } });
  for (const schema of [{ type: "object", $async: true }, { type: "object", $ref: "https://never-fetch.invalid/schema" }, { type: "array" }])
    assert.throws(() => form(schema), badNative);
});

test("native form IDs cannot select a cached meta-schema; IDs, relative refs and format checks survive", () => {
  for (const id of ["http://json-schema.org/draft-07/schema#", "http://json-schema.org/schema"]) {
    for (const method of ["_x.ai/mcp/elicit", "elicitation/create"]) {
      const schema = { $id: id, type: "object", properties: { email: { type: "string", format: "email", $ref: "#/definitions/address" } },
        required: ["email"], definitions: { address: { type: "string", minLength: 3 } }, additionalProperties: false };
      const payload = { ...base, message: "Address", mode: "form", serverName: "fixture", requestedSchema: schema };
      const before = structuredClone(payload), attention = parse(method, payload);
      const action = method === "elicitation/create" ? "action" : "outcome";
      for (const content of [{}, { email: 3 }, { email: "invalid" }, { email: "valid@example.test", extra: true }]) {
        const original = structuredClone(content);
        assert.throws(() => respond(attention, { [action]: "accept", content }), invalid);
        assert.deepEqual(content, original);
      }
      const valid = { [action]: "accept", content: { email: "valid@example.test" } };
      assert.deepEqual(respond(attention, valid), valid);
      assert.deepEqual(payload, before); assert.deepEqual(attention.payload, before);
    }
  }
});

test("elicitation keeps method-specific action/outcome, real URL/form params, and absent/null fields", () => {
  for (const requestedSchema of [undefined, null]) {
    const attention = form(requestedSchema);
    assert.equal(Object.hasOwn(attention.payload, "requestedSchema"), requestedSchema !== undefined);
    for (const response of [{ outcome: "accept" }, { outcome: "accept", content: null }, { outcome: "accept", content: { custom: "value" } }])
      assert.deepEqual(respond(attention, response), response);
  }
  const standard = parse("elicitation/create", { message: "", requestedSchema: { type: "object" }, _meta: null });
  assert.equal("mode" in standard.payload, false);
  assert.deepEqual(respond(standard, { action: "accept", content: {} }), { action: "accept", content: {} });
  assert.throws(() => respond(standard, { outcome: "accept", content: {} }), invalid);
  for (const method of ["_x.ai/mcp/elicit", "elicitation/create"]) {
    const payload = { ...base, message: "", serverName: "s", mode: "url", url: "https://never-fetch.invalid/auth", elicitationId: "exact", _meta: null };
    const attention = parse(method, payload);
    assert.deepEqual(attention.payload, payload);
    for (const action of ["accept", "decline", "cancel"]) {
      const response = { [method === "elicitation/create" ? "action" : "outcome"]: action };
      assert.deepEqual(respond(attention, response), response);
      assert.throws(() => respond(attention, { ...response, content: {} }), invalid);
    }
  }
});

test("standard forms reject unanswerable nested shapes while the xAI JSON-form extension retains nested values", () => {
  const nested = { type: "object", properties: { profile: { type: "object",
    properties: { name: { type: "string" } }, required: ["name"] } }, required: ["profile"], _meta: null };
  const payload = { message: "Profile", requestedSchema: nested, _meta: { preserve: null }, future: true };
  const before = structuredClone(payload);
  assert.throws(() => parse("elicitation/create", payload), error => {
    assert.equal(error.code, "invalid_native_attention");
    assert.match(error.message, /profile.*flat primitive or string-array/);
    return true;
  });
  assert.deepEqual(payload, before, "request rejection never rewrites evidence");
  for (const property of [
    { type: "array", items: { type: "object" } },
    { type: "array", items: { type: "integer" } },
    { type: "array", items: { type: "array", items: { type: "string" } } },
    { type: "null" },
  ]) assert.throws(() => parse("elicitation/create", { message: "", requestedSchema: {
    type: "object", properties: { unsupported: property }, required: ["unsupported"],
  } }), badNative);
  const extension = form(nested);
  const response = { outcome: "accept", content: { profile: { name: "Exact nested content" } }, _meta: null };
  assert.deepEqual(extension.payload.requestedSchema, nested);
  assert.deepEqual(respond(extension, response), response);
});

test("standard flat primitives and string arrays remain exact, including titled string choices and omitted properties", () => {
  const payload = { message: "Flat form", _meta: null, requestedSchema: {
    type: "object", properties: {
      name: { type: "string", _meta: { future: null } }, count: { type: "integer" },
      ratio: { type: "number" }, accepted: { type: "boolean" },
      labels: { type: "array", items: { type: "string", enum: ["A", "B"] } },
      titled: { type: "array", items: { anyOf: [{ const: "C", title: "Choice C" }] } },
    }, required: ["name", "count", "ratio", "accepted", "labels", "titled"], _meta: null,
  } };
  const attention = parse("elicitation/create", payload);
  assert.deepEqual(attention.payload, payload);
  const response = { action: "accept", content: { name: "", count: 2, ratio: 1.5, accepted: false, labels: ["A", "B"], titled: ["C"] }, _meta: null };
  assert.deepEqual(respond(attention, response), response);
  const bare = { message: "", requestedSchema: { type: "object", _meta: null }, extra: null };
  assert.deepEqual(parse("elicitation/create", bare).payload, bare);
  assert.deepEqual(respond(parse("elicitation/create", bare), { action: "accept", content: {} }), { action: "accept", content: {} });
});
