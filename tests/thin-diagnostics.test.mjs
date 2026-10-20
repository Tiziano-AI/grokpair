import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// In-memory source bundle: no shared build output and no native provider.
const bundle = await build({ stdin: {
  contents: 'export { nativeToolFailure } from "./src/native.ts"; export { failure, AgentError } from "./src/core.ts"; export { RequestError } from "@agentclientprotocol/sdk";',
  resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "ts"
}, bundle: true, platform: "node", format: "esm", write: false });
const { nativeToolFailure, failure, AgentError, RequestError } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

// Native failures use internally tagged tool envelopes and nested error
// variants. These emitter-shaped fixtures distinguish failures from outputs.
test("native failed enum envelopes retain every supported variant and provenance", () => {
  const variants = {
    ReadFile: ["FileNotFound", "IsADirectory", "PermissionDenied", "FileTooLarge", "FileReadError", "ImageSizeError"],
    ListDir: ["NotFound", "IsAFile", "NotADirectory", "PermissionDenied", "Error"],
    SearchReplace: ["FileAlreadyExists", "MultipleMatchesFound", "InvalidInput", "FileNotFound", "FilenameTooLong"],
    Todo: ["DuplicateId", "InvalidArgument"],
    WebFetch: ["DomainNotAllowed"],
    TaskOutput: ["TaskNotFound"], KillTask: ["TaskNotFound"],
    ApplyPatch: ["ParseError", "ApplicationError", "EmptyPatch"],
    CodexGrepFiles: ["Error"]
  };
  for (const [type, names] of Object.entries(variants)) {
    for (const variant of names) {
      const message = `${type}.${variant}: ${"complete native diagnostic ".repeat(600)}`;
      const result = nativeToolFailure({ status: "failed", rawOutput: { type, [variant]: message } });
      assert.equal(result.message, message, `${type}.${variant}`);
      assert.equal(result.diagnostic_source, `rawOutput.${variant}`);
    }
  }
});

test("native structured failures preserve context and emitted diagnostic prose", () => {
  const text = value => ({ type: "content", content: { type: "text", text: value } });
  const mcp = nativeToolFailure({ status: "failed", rawOutput: { type: "MCP", tool_name: "native_tool", server_name: "native_server",
    output: { Error: "Authentication expired" }, reconnect_attempted: true, auth_retry_attempted: false, is_timeout: false, is_error: true } });
  assert.equal(mcp.message, "Authentication expired");
  assert.equal(mcp.diagnostic_source, "rawOutput.output.Error");
  assert.ok(mcp.diagnostic_fields.some(item => item.source === "rawOutput.server_name" && item.value === "native_server"));
  assert.ok(mcp.diagnostic_fields.some(item => item.source === "rawOutput.auth_retry_attempted" && item.value === "false"));
  const missing = nativeToolFailure({ status: "failed", rawOutput: { type: "SearchReplace", NoMatchesFound: {
    message: "No matching old_string", file_path: "/exact/path", file_snapshot_at_edit: "PRIVATE_SNAPSHOT"
  } }, content: [text("No matching old_string")] });
  assert.equal(missing.diagnostic_source, "rawOutput.NoMatchesFound.message");
  assert.deepEqual(missing.diagnostics, [{ source: "content[0].content.text", message: "No matching old_string" }]);
  assert.ok(missing.diagnostic_fields.some(item => item.source === "rawOutput.NoMatchesFound.file_path" && item.value === "/exact/path"));
  assert.equal(JSON.stringify(missing).includes("PRIVATE_SNAPSHOT"), false);
  const web = nativeToolFailure({ status: "failed", rawOutput: { type: "WebFetch", Error: { url: "https://example.test/a", message: "Connection refused" } } });
  assert.equal(web.message, "Connection refused");
  assert.ok(web.diagnostic_fields.some(item => item.source === "rawOutput.Error.url" && item.value === "https://example.test/a"));
  const redirectText = "Error: cross-host redirect from original.test to https://other.test/a. Make a new web_fetch call with the redirect URL if needed.";
  const redirect = nativeToolFailure({ status: "failed", rawOutput: { type: "WebFetch", CrossHostRedirect: {
    original_host: "original.test", redirect_url: "https://other.test/a"
  } }, content: [text(redirectText)] });
  assert.equal(redirect.message, redirectText);
  assert.equal(redirect.diagnostic_source, "content[0].content.text");
  assert.ok(redirect.diagnostic_fields.some(item => item.source === "rawOutput.CrossHostRedirect.redirect_url" && item.value === "https://other.test/a"));
  const todo = nativeToolFailure({ status: "failed", rawOutput: { type: "Todo", InvalidArgument: "Missing todos" }, content: [text("Missing todos")] });
  assert.equal(todo.message, "Missing todos");
  assert.deepEqual(todo.diagnostics, [{ source: "content[0].content.text", message: "Missing todos" }]);
});

test("native rejected message outcomes and Bash status retain diagnostics, never stdout", () => {
  for (const outcome of ["not_found_or_not_owned", "not_active_or_finalizing", "saturated", "not_accepted_before_deadline", "unsupported", "limit", "channel_closed"]) {
    const result = nativeToolFailure({ status: "failed", rawOutput: { type: "SendSubagentMessage", outcome,
      ...(outcome === "saturated" ? { max_in_flight: 4 } : {}), ...(outcome === "limit" ? { max_bytes: 4096, observed_bytes: 8192 } : {}) } });
    assert.equal(result.message, outcome);
    assert.equal(result.diagnostic_source, "rawOutput.outcome");
    if (outcome === "limit") assert.deepEqual(result.diagnostic_fields, [
      { source: "rawOutput.max_bytes", value: "4096" }, { source: "rawOutput.observed_bytes", value: "8192" }
    ]);
  }
  const bash = nativeToolFailure({ status: "failed", rawOutput: { type: "Bash", output: [1, 2, 3], output_for_prompt: "PRIVATE_STDOUT",
    command: "PRIVATE_COMMAND", signal: "SIGTERM", timed_out: true, exit_code: -1 },
    content: [{ type: "content", content: { type: "text", text: "PRIVATE_STDOUT" } },
      { type: "content", content: { type: "text", text: '{"message":"PRIVATE_JSON_STDOUT"}' } }] });
  assert.deepEqual(bash.diagnostic_fields, [
    { source: "rawOutput.signal", value: "SIGTERM" }, { source: "rawOutput.timed_out", value: "true" }, { source: "rawOutput.exit_code", value: "-1" }
  ]);
  assert.equal(JSON.stringify(bash).includes("PRIVATE"), false);
});

test("known native successes and unknown variant plaintext are not diagnostics", () => {
  const secret = "PRIVATE_SUCCESS";
  const outputs = [
    { type: "MCP", output: { OkayOutput: secret } }, { type: "Todo", TodosUpdated: { summary_for_prompt: secret } },
    { type: "ReadFile", FileContent: { content: secret } }, { type: "SearchReplace", EditsApplied: { new_string: secret } },
    { type: "ListDir", Content: { content: secret } }, { type: "WebFetch", Content: { content: secret } },
    { type: "ApplyPatch", Success: { files: [{ new_text: secret }] } }, { type: "CodexGrepFiles", NoMatches: secret },
    { type: "TaskOutput", Result: { output: secret } }, { type: "KillTask", Result: { message: secret } },
    { type: "SendSubagentMessage", outcome: "accepted", message_id: "accepted-id" },
    { type: "SendSubagentMessage", outcome: "admission_uncertain" },
    { type: "FutureTool", Error: secret }, { type: "ReadFile", FutureVariant: secret }, { type: "__proto__", Error: secret },
    { type: "Skill", success: false, tool_result: secret }
  ];
  for (const rawOutput of outputs) {
    const result = nativeToolFailure({ status: "failed", rawOutput, content: [{ type: "content", content: { type: "text", text: secret } }] });
    assert.equal(JSON.stringify(result).includes(secret), false, JSON.stringify(rawOutput));
    assert.equal(result.message, "Native tool reported failure");
  }
  const skill = nativeToolFailure({ status: "failed", rawOutput: { type: "Skill", success: false, error: "Skill unavailable", tool_result: secret },
    content: [{ type: "content", content: { type: "text", text: JSON.stringify({ message: secret }) } }] });
  assert.equal(skill.message, "Skill unavailable");
  assert.equal(JSON.stringify(skill).includes(secret), false);
});

test("explicit native diagnostics retain all messages, codes and identities beyond former caps", () => {
  const long = "Native detail. ".repeat(1000), code = "CODE".repeat(1000), id = "identity".repeat(1000);
  const causes = Array.from({ length: 12 }, (_, index) => ({ code: `C${index}`, message: `${index}: ${long}` }));
  const update = { rawOutput: { error: { message: long, code, title: long, toolCallId: id, promptId: id,
    cause: { cause: { cause: { causes } } } } } };
  const result = nativeToolFailure(update);
  assert.equal(result.message, long); assert.equal(result.native_code, code);
  assert.equal(result.diagnostic_source, "rawOutput.error.message");
  assert.equal(result.diagnostics.length, 12); assert.equal(result.native_codes.length, 13);
  assert.deepEqual(result.diagnostics.at(-1), { source: "rawOutput.error.cause.cause.cause.causes[11].message", message: `11: ${long}` });
  assert.ok(result.diagnostic_fields.some(item => item.source === "rawOutput.error.toolCallId" && item.value === id));
  assert.ok(result.diagnostic_fields.some(item => item.source === "rawOutput.error.title" && item.value === long));
  assert.equal(result.diagnostics_truncated, undefined);
});

test("specific messages outrank generic errors without losing either provenance", () => {
  const result = nativeToolFailure({ rawOutput: { error: { message: "error", cause: { message: "Limit exceeded: choose a shorter clip" } }, message: "Failure" } });
  assert.equal(result.message, "Limit exceeded: choose a shorter clip");
  assert.deepEqual(result.diagnostics.map(item => item.message), ["error", "Failure"]);
  const sibling = nativeToolFailure({ rawOutput: { error: "error", message: "The requested model is unavailable" } });
  assert.equal(sibling.message, "The requested model is unavailable");
});

test("diagnostic collection rejects stdout, thoughts, unknown raw data and embedded JSON", () => {
  const secret = "MUST_NOT_RETAIN";
  const content = text => ({ type: "content", content: { type: "text", text } });
  const result = nativeToolFailure({ rawOutput: {
    message: "Specific rejection", stdout: secret, thoughts: secret, toolHistory: { message: secret },
    data: { message: secret }, arbitrary: { error: secret }, stack: secret
  }, content: [content(`Log: {"message":"${secret}"}`), content(JSON.stringify({ stdout: secret })),
    content(JSON.stringify({ error: { message: "Structured rejection", code: "JSON_CODE" }, stdout: secret })),
    { type: "resource", content: { type: "text", text: JSON.stringify({ message: secret }) } }] });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.ok(result.diagnostics.some(item => item.source === "content[2].content.text.error.message" && item.message === "Structured rejection"));
  assert.equal(nativeToolFailure({ rawOutput: secret }).message, "Native tool reported failure");
});

test("request-native failure retains full native code, IDs, title and actionable rejection", () => {
  const long = "Detail ".repeat(2000), id = "ID".repeat(5000), code = "CODE".repeat(5000);
  const error = new RequestError(-32602, "Invalid params", { error: { message: long, code }, title: long, tool_call_id: id, prompt_id: id, stdout: "PRIVATE_STDOUT" });
  const result = failure(error, "native_request_failed");
  assert.equal(result.code, "native_request_failed"); assert.equal(result.message, long);
  assert.equal(result.details.native_code, -32602);
  assert.ok(result.details.native_codes.some(item => item.code === code && item.source === "error.data.error.code"));
  assert.ok(result.details.diagnostic_fields.some(item => item.source === "error.data.tool_call_id" && item.value === id));
  assert.ok(result.details.diagnostic_fields.some(item => item.source === "error.data.title" && item.value === long));
  assert.match(result.action, /correct the indicated input or precondition/);
  assert.equal(JSON.stringify(result).includes("PRIVATE_STDOUT"), false);
  assert.equal(Object.hasOwn(result.details, "effects"), false);
});

test("deep JS cause graphs are iterative, source-labelled and JSON serializable", () => {
  let error = new Error("Deepest native rejection");
  for (let index = 0; index < 2500; index++) error = new Error("error", { cause: error });
  const result = failure(error);
  assert.equal(result.message, "Deepest native rejection");
  assert.equal(result.details.diagnostics.length, 2501);
  assert.equal(result.details.diagnostics.at(-1).source, `error${".cause".repeat(2500)}.message`);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("AggregateError retains every child and marks cycles and shared references", () => {
  const shared = new Error("Repeated native diagnostic");
  const errors = Array.from({ length: 12 }, (_, index) => new Error(`Child ${index}`));
  const aggregate = new AggregateError([...errors, shared, shared], "error");
  aggregate.cause = aggregate;
  const result = failure(aggregate);
  assert.equal(result.details.diagnostics.length, 14);
  assert.ok(result.details.diagnostics.some(item => item.source === "error.errors[11].message" && item.message === "Child 11"));
  assert.deepEqual(result.details.diagnostic_references, [
    { source: "error.cause", reference: "error", kind: "cycle" },
    { source: "error.errors[13]", reference: "error.errors[12]", kind: "shared" }
  ]);
  assert.doesNotThrow(() => JSON.stringify(result));
  const native = nativeToolFailure({ rawOutput: { error: aggregate } });
  assert.equal(native.diagnostics.length, 13);
  assert.doesNotThrow(() => JSON.stringify(native));
});

test("equal message text at distinct sources is retained; AgentError keeps domain recovery and causes", () => {
  const duplicate = nativeToolFailure({ rawOutput: { message: "Same failure", cause: { message: "Same failure", code: "SECOND" } } });
  assert.deepEqual(duplicate.diagnostics, [{ source: "rawOutput.cause.message", message: "Same failure" }]);
  const domain = new AgentError("attention_invalid", "Invalid native attention", "Inspect the retained request", { request_id: "request_exact" }, { cause: new Error("Deep validation detail") });
  const result = failure(domain);
  assert.equal(result.code, domain.code); assert.equal(result.message, domain.message); assert.equal(result.action, domain.action);
  assert.equal(result.details.request_id, "request_exact");
  assert.ok(result.details.diagnostics.some(item => item.source === "error.cause.message" && item.message === "Deep validation detail"));
});

test("explicit primitive Error causes and AggregateError members are not silently omitted", () => {
  const result = failure(new AggregateError(["native reason", 42, false, null, undefined], "error", { cause: "specific cause" }));
  assert.deepEqual(result.details.diagnostics.map(item => item.message), ["error", "specific cause", "native reason", "42", "false", "null", "undefined"]);
  assert.equal(result.details.diagnostics.at(-1).source, "error.errors[4]");
});
