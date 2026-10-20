import process from "node:process";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { assertPublicInputPropertyContract } from "./public-schema-contract.mjs";

const expected = ["grok_spawn", "grok_send", "grok_wait", "grok_read", "grok_list", "grok_respond", "grok_interrupt", "grok_close"];
const root = new URL("../", import.meta.url);
const { version } = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const generated = JSON.parse(await readFile(new URL("plugin/schemas/grokpair-tools.schema.json", root), "utf8"));
const config = JSON.parse(await readFile(new URL("plugin/.codex-plugin/plugin.json", root), "utf8")).mcpServers.grokpair;
assert.deepEqual(config.args, ["mcp"]);
const temporaryRoot = await realpath("/private/tmp");
const scratch = await realpath(await mkdtemp(join(temporaryRoot, "grokpair-mcp-check-")));
const runtime = join(scratch, "runtime");
// Exercise packaged MCP without provider access or the user's runtime. Every
// accepted call below is read-only or names an absent collaborator.
const serverEnvironment = { ...getDefaultEnvironment(), TMPDIR: temporaryRoot, GROKPAIR_HOME: runtime, PATH: join(scratch, "no-executables") };
const serverLaunch = { command: process.execPath, args: [new URL("plugin/bin/grokpair", root).pathname, ...config.args], cwd: root.pathname, stderr: "pipe" };
const transport = new StdioClientTransport({ ...serverLaunch, env: serverEnvironment });
const client = new Client({ name: "grokpair-check", version }, { capabilities: {} });
const errors = [];
transport.stderr?.on("data", (chunk) => errors.push(String(chunk)));

try {
  await client.connect(transport, { timeout: 10_000 });
  const server = client.getServerVersion();
  assert.equal(server?.name, "grokpair");
  assert.equal(server?.version, version);
  assert.equal(generated.version, version);
  assert.equal(generated.schema_version, "3");
  const schemaVersion = generated.schema_version;
  // Hosts can prepend server instructions to every discovered tool. Keep the
  // integrated workflow in the skill and expose each tool's own contract here.
  assert.equal(client.getInstructions(), undefined, "server-wide workflow would be repeated on every tool");
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  assert.deepEqual(names, expected);
  assert.deepEqual(generated.tools.map((tool) => tool.name), expected);
  for (const tool of listed.tools) {
    const generatedTool = generated.tools.find((candidate) => candidate.name === tool.name);
    assert.equal(tool.description, generatedTool.description, tool.name + " generated description differs");
    assert.deepEqual(tool.inputSchema, generatedTool.input_schema, tool.name + " generated input schema differs");
    assert.equal(tool.inputSchema.$schema, "http://json-schema.org/draft-07/schema#");
    assert.ok(tool.description?.length > 0, tool.name + " lacks a description");
    assert.ok(closedRoot(tool.inputSchema), tool.name + " input root is not closed");
    assert.equal(Object.hasOwn(tool, "outputSchema"), false, tool.name + " publishes a duplicate output contract");
    assertPublicInputPropertyContract(tool.name, tool.inputSchema);
    assertDefaultedInputPropertiesOptional(tool.inputSchema, tool.name);
    assert.equal(tool._meta, undefined, tool.name + " must not override native host result handling");
  }
  const spawn = listed.tools.find(({ name }) => name === "grok_spawn").inputSchema;
  assert.deepEqual(spawn.required, ["task", "cwd"]);
  assert.equal(spawn.properties.cwd.default, undefined);
  assert.equal(spawn.properties.workspace, undefined);
  assert.equal(spawn.properties.worktree.type, "boolean");
  assert.equal(spawn.properties.worktree.default, false);
  assert.equal(spawn.properties.sandbox.type, "string");
  assert.equal(spawn.properties.sandbox.default, undefined);
  assert.equal(spawn.properties.model.default, undefined);
  assert.equal(spawn.properties.effort.default, undefined);
  const send = listed.tools.find(({ name }) => name === "grok_send").inputSchema;
  assert.equal(send.type, "object");
  assert.deepEqual(send.properties.action.enum, ["follow_up", "steer", "send_now", "side_question", "edit", "configure"]);
  assert.ok(send.properties.prompt_id);
  assert.equal(send.properties.media, undefined);
  assert.equal(spawn.properties.media, undefined);
  assert.deepEqual(spawn.properties.attachments.items.required, ["path", "kind"]);
  assert.deepEqual(spawn.properties.attachments.items.properties.kind.enum, ["reference", "image"]);
  assert.equal(spawn.properties.attachments.maxItems, undefined);
  assert.equal(spawn.properties.task.maxLength, undefined);
  const readInput = listed.tools.find(({ name }) => name === "grok_read").inputSchema;
  assert.equal(readInput.properties.max_chars.default, 32_000);
  assert.deepEqual(readInput.properties.view.enum, ["result", "records"]);
  const listInput = listed.tools.find(({ name }) => name === "grok_list").inputSchema;
  assert.equal(listInput.properties.include_closed.default, false);
  assert.ok(listInput.properties.key);
  assert.ok(spawn.properties.key);
  const wait = listed.tools.find(({ name }) => name === "grok_wait").inputSchema;
  assert.deepEqual(wait.properties.until.enum, ["settled", "change"]);
  assert.equal(wait.properties.until.default, "settled");
  assert.equal(wait.properties.timeout_ms.default, 120_000);
  assert.equal(wait.properties.targets.maxItems, undefined);
  assert.equal(wait.properties.max_chars.default, 32_000);
  assert.ok(config.tool_timeout_sec * 1000 >= wait.properties.timeout_ms.maximum + 60_000,
    "configured MCP timeout must cover the maximum wait plus transport margin");
  const respond = listed.tools.find(({ name }) => name === "grok_respond").inputSchema;
  assert.equal(respond.anyOf, undefined);
  assert.equal(respond.oneOf, undefined);
  assert.ok(respond.properties.response.anyOf);
  assert.equal(respond.properties.response.anyOf.some(branch => branch.properties?.kind), false);

  function payload(result) {
    assert.equal(Object.hasOwn(result, "structuredContent"), false);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    const value = JSON.parse(result.content[0].text);
    assert.equal(value.schema_version, schemaVersion);
    assert.ok(["ok", "admitted", "existing", "settled", "changed", "timeout", "error"].includes(value.call_status));
    assert.equal(result.isError, value.call_status === "error", "MCP isError must describe this call, not collaborator state");
    const fields = new Set(["schema_version", "call_status", "agent", "agents", "error", "page", "operation_id", "agent_id"]);
    for (const key of Object.keys(value)) assert.ok(fields.has(key), "unknown result field " + key);
    return value;
  }
  const list = await client.callTool({ name: "grok_list", arguments: {} });
  assert.equal(list.isError, false);
  assert.deepEqual(payload(list), { schema_version: schemaVersion, call_status: "ok", agents: [], page: { has_more: false } });
  const recent = payload(await client.callTool({ name: "grok_list", arguments: { include_closed: true, key: "absent-key" } }));
  assert.equal(recent.call_status, "ok");
  assert.deepEqual(recent.agents, []);
  const uncappedList = payload(await client.callTool({ name: "grok_list", arguments: { limit: 101 } }));
  assert.deepEqual(uncappedList.agents, []);
  const agent_id = "agent_12345678-1234-4123-8123-123456789abc";
  const waited = await client.callTool({ name: "grok_wait", arguments: { targets: [{ agent_id }], timeout_ms: 0 } });
  assert.equal(waited.isError, false);
  const waitedValue = payload(waited);
  assert.equal(waitedValue.call_status, "settled");
  assert.equal(waitedValue.agents.length, 1);
  assert.equal(waitedValue.agents[0].agent_id, agent_id);
  assert.equal(waitedValue.agents[0].status, "unavailable");
  assert.equal(waitedValue.agents[0].cursor, null, "unreadable state cannot publish a fabricated cursor");
  assert.ok(waitedValue.agents[0].issues?.some(issue => issue.code?.length > 0),
    "wait must preserve the per-target read failure without turning it into a call failure");
  for (const [name, input] of [
    ["grok_read", { agent_id }],
    ["grok_read", { agent_id, max_chars: 500_001, cursor: "x".repeat(4097) }],
    ["grok_send", { agent_id, task: "Never dispatch this absent-agent check" }],
    // Above both the retired task cap and the SDK's default 10 MiB input
    // buffer. An absent collaborator proves domain delivery without provider use.
    ["grok_send", { agent_id, task: "x".repeat(10 * 1024 * 1024 + 1) }],
    ["grok_send", { agent_id, action: "configure", model: "native-model" }],
    ["grok_respond", { agent_id, request_id: "request_12345678-1234-4123-8123-123456789abc", response: { outcome: "approved" } }],
    ["grok_interrupt", { agent_id }],
    ["grok_close", { agent_id }],
    ["grok_spawn", { task: "Never execute this rejected workspace check", cwd: "/" }],
    ["grok_spawn", { task: "Never execute this keyed rejected workspace check", cwd: "/", key: "check-key" }],
  ]) {
    const result = await client.callTool({ name, arguments: input });
    assert.equal(result.isError, true, name + " unexpectedly accepted its negative fixture");
    const value = payload(result);
    assert.equal(value.call_status, "error");
    assert.equal(value.error?.admission, "none");
    for (const key of ["code", "message", "action"]) assert.ok(value.error?.[key]?.length > 0, name + " lacks error." + key);
  }
  // These are structurally typed inputs. Action semantics belong to the
  // domain, so rejection remains the product's JSON error carrier rather
  // than an MCP input-schema error. Every fixture rejects before admission.
  for (const input of [
    { agent_id, task: "x", action: "edit" },
    { agent_id, task: "x", action: "side_question", attachments: [] },
    { agent_id, task: "x", action: "send_now", model: "not-supported-here" },
    { agent_id, task: "x", model: "not-supported-here" },
    { agent_id, task: "x", action: "steer", resume: false },
    { agent_id, task: "x", action: "steer", attachments: [{ path: "/input.txt", kind: "reference" }] },
    { agent_id, task: "x", prompt_id: "native-prompt" },
    { agent_id, task: "x", action: "edit", prompt_id: "native-prompt", attachments: [] },
    { agent_id, action: "configure" },
    { agent_id, action: "configure", model: "native-model", task: "Not a prompt" },
    { agent_id, action: "configure", effort: "native-effort", search: {} },
  ]) {
    const value = payload(await client.callTool({ name: "grok_send", arguments: input }));
    assert.equal(value.call_status, "error");
    assert.equal(value.error?.admission, "none");
    assert.equal(value.error?.code, "invalid_input", "invalid send action must be rejected before collaborator lookup");
  }
  for (const [name, input] of [
    ["grok_spawn", { task: "x" }],
    ["grok_spawn", { task: "x", cwd: scratch, unknown_flag: true }],
    ["grok_spawn", { task: "x", cwd: scratch, quality: { mode: "deep" } }],
    ["grok_send", { agent_id, task: "x", action: "edit", turn_id: "turn_12345678-1234-4123-8123-123456789abc" }],
    ["grok_spawn", { task: "x", cwd: scratch, media: { operation: "image_gen" } }],
    ["grok_send", { agent_id, task: "x", media: { operation: "image_gen" } }],
    ["grok_wait", { targets: [{ agent_id }], max_chars: 0 }],
    ["grok_spawn", { task: "x", cwd: scratch, attachments: [{ path: "/input.png" }] }],
    ["grok_spawn", { task: "x", cwd: scratch, attachments: [{ source: "artifact", agent_id, artifact_id: "artifact_example" }] }],
    ["grok_read", { agent_id, turn_id: "retired" }],
    ["grok_respond", { agent_id, request_id: "request_12345678-1234-4123-8123-123456789abc", response: { kind: "permission", option_id: "allow", cancelled: true } }],
  ]) {
    const result = await client.callTool({ name, arguments: input });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Input validation error/u);
  }
  assert.equal(existsSync(runtime), false, "rejected/read-only checks published runtime state");
  // A server started beneath a collaborator serves no tools, so Grok cannot recurse into grokpair.
  const nestedTransport = new StdioClientTransport({ ...serverLaunch, env: { ...serverEnvironment, GROKPAIR_COLLABORATOR: agent_id } });
  const nestedClient = new Client({ name: "grokpair-nested-check", version }, { capabilities: {} });
  try {
    await nestedClient.connect(nestedTransport, { timeout: 10_000 });
    assert.equal(nestedClient.getServerCapabilities()?.tools, undefined, "a nested server must offer no tools");
  } finally {
    await nestedClient.close().catch(() => undefined);
    await nestedTransport.close().catch(() => undefined);
  }
  // The built-in SQLite warning is runtime-owned, not provider or application output.
  const stderr = errors.join("").replace(/^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature.*\n?/gmu, "")
    .replace(/^\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n?/gmu, "");
  assert.equal(stderr, "", "MCP server emitted unexpected stderr");
  process.stdout.write(JSON.stringify({ ok: true, server, tools: names, schema_version: schemaVersion, provider_required: false }, null, 2) + "\n");
} finally {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
  await rm(scratch, { recursive: true, force: true });
}

function closedRoot(schema) {
  const branches = schema?.anyOf ?? schema?.oneOf;
  if (Array.isArray(branches) && branches.length > 0) return branches.every(closedRoot);
  return schema?.type === "object" && schema.additionalProperties === false;
}

function assertDefaultedInputPropertiesOptional(schema, path) {
  if (Array.isArray(schema)) {
    schema.forEach((value, index) => assertDefaultedInputPropertiesOptional(value, path + "[" + index + "]"));
    return;
  }
  if (!schema || typeof schema !== "object") return;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (property && typeof property === "object" && Object.hasOwn(property, "default")) {
      assert.equal(required.has(name), false, path + "." + name + " has an input default but is required");
    }
  }
  for (const [key, value] of Object.entries(schema)) assertDefaultedInputPropertiesOptional(value, path + "." + key);
}
