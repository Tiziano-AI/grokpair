import { access, readdir, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, extname, relative } from "node:path";
import process from "node:process";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { build as buildSourceGraph } from "esbuild";
import { buildForNodeEngineFloor, nodeBuildOptionsFromEngineFloor, nodeTargetFromEngineFloor } from "./node-target.mjs";
import { assertPublicInputPropertyContract } from "./public-schema-contract.mjs";
import { CLAUDE_TOOL_PREFIX, FORWARDED_ENVIRONMENT, TOOL_TIMEOUT_SECONDS, generatedFiles, serialize } from "./manifests.mjs";

const root = new URL("../", import.meta.url);
const fail = (message) => { throw new Error(message); };
const json = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

const rootPackage = await json("package.json");
const pluginPackage = await json("plugin/package.json");
const manifest = await json("plugin/.codex-plugin/plugin.json");
const claudeManifest = await json("plugin/.claude-plugin/plugin.json");
const pluginSchemaBytes = await readFile(new URL("plugin/schemas/grokpair-tools.schema.json", root));
const schema = JSON.parse(pluginSchemaBytes.toString("utf8"));

// Every host manifest and marketplace is generated from package.json
// by scripts/manifests.mjs; a committed copy that differs was edited by hand or
// not rebuilt.
for (const [path, value] of Object.entries(generatedFiles(rootPackage))) {
  if (await readFile(new URL(path, root), "utf8") !== serialize(value)) fail(`${path} differs from scripts/manifests.mjs; run pnpm build`);
}
try {
  await access(new URL("plugin/.mcp.json", root));
  fail("plugin/.mcp.json must not exist: Claude Code would load it beside the manifest's inline server");
} catch (error) { if (error?.code !== "ENOENT") throw error; }

const versions = [rootPackage.version, pluginPackage.version, manifest.version, claudeManifest.version, schema.version];
if (rootPackage.scripts?.test !== "pnpm build && node scripts/test.mjs") {
  fail("the canonical test gate must run through the suite-owned runtime isolator");
}
if (versions.some((value) => value !== versions[0])) fail(`version mismatch: ${versions.join(", ")}`);
const pinnedVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
if (!pinnedVersion.test(rootPackage.version)) fail("package.json must own an exact product version");
if (!/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]+$/u.test(rootPackage.packageManager ?? "")) {
  fail("package.json must pin pnpm with an integrity digest");
}
const nodeTarget = nodeTargetFromEngineFloor(rootPackage.engines.node);
const projectedNodeBuildOptions = nodeBuildOptionsFromEngineFloor(rootPackage.engines.node, { bundle: true });
if (projectedNodeBuildOptions.target !== nodeTarget || projectedNodeBuildOptions.bundle !== true) {
  fail("the package Node floor projection did not preserve esbuild options with the exact target");
}
const targetOwnerGraph = await buildSourceGraph({
  absWorkingDir: new URL(".", root).pathname,
  entryPoints: ["scripts/build.mjs", "scripts/check-skill.mjs", "scripts/node-target.mjs"],
  bundle: false,
  write: false,
  metafile: true,
  outdir: "validate-node-target-owner",
  platform: "node",
  format: "esm",
  logLevel: "silent"
});
const targetOwnerImports = new Map();
for (const output of Object.values(targetOwnerGraph.metafile.outputs)) {
  if (output.entryPoint) {
    targetOwnerImports.set(output.entryPoint, output.imports.map(({ path }) => path));
  }
}
for (const consumer of ["scripts/build.mjs", "scripts/check-skill.mjs"]) {
  const imports = targetOwnerImports.get(consumer) ?? [];
  if (!imports.includes("./node-target.mjs") || imports.includes("esbuild")) {
    fail(`${consumer} must execute esbuild only through scripts/node-target.mjs for target ${nodeTarget}`);
  }
}
if (!(targetOwnerImports.get("scripts/node-target.mjs") ?? []).includes("esbuild")) {
  fail("scripts/node-target.mjs must own the production esbuild invocation");
}
const workspaceConfig = await readFile(new URL("pnpm-workspace.yaml", root), "utf8");
const lockfile = await readFile(new URL("pnpm-lock.yaml", root), "utf8");
if (workspaceConfig.includes("patchedDependencies") || lockfile.includes("patch_hash=")) {
  fail("dependency patches, forks, and patched virtual-package identities are forbidden");
}
// pnpm 12 puts its optional environment lock first and the project lock last.
// Read only the project's root-importer records, not the environment importer
// or transitive package entries. The manifest chooses immutable exact pins.
const projectLockfile = lockfile.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n")
  .split(/^---[ \t]*\n/mu).at(-1);
const rootImporter = projectLockfile.match(/^  \.:\n((?:^(?: {4,}[^\n]*|\s*)\n)*)/mu)?.[1];
if (!rootImporter) fail("lockfile is missing the root package importer");
for (const owner of ["dependencies", "devDependencies", "optionalDependencies"]) {
  const lockedSection = rootImporter.match(new RegExp(`^    ${owner}:\\n((?:^ {6,}[^\\n]*\\n)*)`, "mu"))?.[1] ?? "";
  const locked = new Map([...lockedSection.matchAll(/^      ['"]?([^'"\n]+?)['"]?:\n        specifier: ([^\n]+)\n        version: ([^\n]+)/gmu)]
    .map(([, name, specifier, resolved]) => [name, { specifier, resolved }]));
  const declared = rootPackage[owner] ?? {};
  assert.deepEqual([...locked.keys()].sort(), Object.keys(declared).sort(), `${owner} lockfile inventory differs from package.json`);
  for (const [name, version] of Object.entries(declared)) {
    if (!pinnedVersion.test(version)) fail(`${name} must use an exact dependency version, found ${version}`);
    const entry = locked.get(name);
    if (entry.specifier !== version || entry.resolved.split("(", 1)[0] !== version) {
      fail(`lockfile importer does not resolve ${name} to its package.json pin ${version}`);
    }
  }
}
try {
  const dependencyPatches = (await readdir(new URL("patches/", root), { withFileTypes: true }))
    .filter((entry) => entry.name !== ".DS_Store");
  if (dependencyPatches.length) fail("repository-owned dependency patch files are forbidden");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (schema.product !== "grokpair" || schema.schema_version !== "3") {
  fail(`generated schema identity mismatch: ${JSON.stringify({ product: schema.product, schema_version: schema.schema_version })}`);
}
if (manifest.name !== "grokpair" || claudeManifest.name !== "grokpair" || manifest.skills !== "./skills/") {
  fail("plugin manifests must both name grokpair and Codex must carry the skill directory");
}
const marketplaceCard = manifest.interface ?? {};
if (!Array.isArray(marketplaceCard.defaultPrompt) || !marketplaceCard.defaultPrompt.length) {
  fail("marketplace default prompts are missing");
}
for (const [index, prompt] of marketplaceCard.defaultPrompt.entries()) {
  if (typeof prompt !== "string" || !prompt.trim() || [...prompt].length > 128) {
    fail(`marketplace interface.defaultPrompt[${index}] must be a string of at most 128 characters`);
  }
}
for (const [host, servers] of [["Codex", manifest.mcpServers], ["Claude Code", claudeManifest.mcpServers]]) {
  if (JSON.stringify(Object.keys(servers ?? {})) !== JSON.stringify(["grokpair"])) fail(`${host} manifest must declare exactly the grokpair server`);
  if (JSON.stringify(servers.grokpair.args) !== JSON.stringify(["mcp"]) || servers.grokpair.env !== undefined) {
    fail(`${host} must start "grokpair mcp" without supplying environment defaults`);
  }
}
const mcp = manifest.mcpServers.grokpair;
if (mcp.command !== "./bin/grokpair" || mcp.cwd !== "." || mcp.default_tools_approval_mode !== undefined || mcp.tools !== undefined
  || !isDeepStrictEqual(mcp.env_vars, FORWARDED_ENVIRONMENT) || manifest.hooks !== undefined || claudeManifest.hooks !== undefined) {
  fail("Manifests must launch the packaged entrypoint, forward native selectors and leave approval to the host");
}
try {
  await access(new URL("plugin/hooks/hooks.json", root));
  fail("plugin/hooks/hooks.json must not exist: the plugin must not bypass host approval");
} catch (error) { if (error?.code !== "ENOENT") throw error; }
if (claudeManifest.mcpServers.grokpair.command !== "${CLAUDE_PLUGIN_ROOT}/bin/grokpair"
  || claudeManifest.mcpServers.grokpair.timeout !== TOOL_TIMEOUT_SECONDS * 1000) {
  fail("Claude Code must launch the packaged entrypoint through CLAUDE_PLUGIN_ROOT with the tool timeout");
}

const expectedTools = ["grok_spawn", "grok_send", "grok_wait", "grok_read", "grok_list", "grok_respond", "grok_interrupt", "grok_close"];
const compiledSchema = await buildForNodeEngineFloor(rootPackage.engines.node, {
  entryPoints: [new URL("src/agent-schema.ts", root).pathname],
  bundle: true, write: false, platform: "node", format: "esm",
});
const sourceSchema = await import("data:text/javascript;base64," + Buffer.from(compiledSchema.outputFiles[0].contents).toString("base64"));
assert.equal(schema.schema_version, sourceSchema.PUBLIC_SCHEMA_VERSION, "generated schema version must match the source contract");
for (const tool of sourceSchema.toolDefinitions) assert.equal(tool._meta, undefined, tool.name + " must not override native host result handling");
const currentTools = sourceSchema.toolDefinitions.map(({ name, description }) => ({ name, description, input_schema: sourceSchema.publicInputSchema(name) }));
// MCP's ToolSchema reorders object keys. Compare the complete value (including
// array order and every constraint), not incidental JSON property order.
if (!isDeepStrictEqual(schema.tools, currentTools)) fail("generated public tools differ from the current source projection; rebuild the package");
if (!Array.isArray(schema.tools)) fail("generated schema tools must be an ordered array");
if (JSON.stringify(schema.tools.map((tool) => tool.name)) !== JSON.stringify(expectedTools)) {
  fail(`tool schema registry is not exactly ${expectedTools.join(", ")}`);
}
for (const tool of schema.tools) {
  if (!tool.description || !tool.input_schema) fail(`incomplete generated schema for ${tool.name}`);
  // Claude Code truncates longer tool descriptions.
  if (tool.description.length > 2048) fail(`${tool.name} description exceeds 2048 characters (${tool.description.length})`);
  if (tool.output_schema !== undefined) fail(`${tool.name} must use the single JSON text response carrier without output_schema`);
  assertPublicInputPropertyContract(tool.name, tool.input_schema);
  if (!Array.isArray(tool.input_schema.examples) || !tool.input_schema.examples.length) fail(`${tool.name} needs an executable input example`);
  for (const example of tool.input_schema.examples) sourceSchema.parseToolInput(tool.name, example);
  if (!closedRoot(tool.input_schema)) {
    fail(`${tool.name} top-level input schema is not closed`);
  }
}
const spawn = schema.tools.find((tool) => tool.name === "grok_spawn")?.input_schema;
if (spawn?.properties?.workspace !== undefined
    || spawn?.properties?.worktree?.type !== "boolean" || spawn?.properties?.worktree?.default !== false
    || spawn?.properties?.sandbox?.type !== "string" || spawn?.properties?.sandbox?.default !== undefined
    || JSON.stringify(spawn?.required) !== JSON.stringify(["task", "cwd"])
    || spawn?.properties?.cwd?.default !== undefined
    || spawn?.properties?.model?.default !== undefined || spawn?.properties?.effort?.default !== undefined) {
  fail("grok_spawn requires task/cwd with independent optional worktree/sandbox, leaving model/effort defaults native-owned");
}
const wait = schema.tools.find((tool) => tool.name === "grok_wait")?.input_schema;
const send = schema.tools.find((tool) => tool.name === "grok_send")?.input_schema;
assert.deepEqual(send.properties?.action?.enum, ["follow_up", "steer", "send_now", "side_question", "edit", "configure"]);
assert.ok(send.properties?.prompt_id, "grok_send must expose the native prompt identity");
assert.equal(spawn.properties.media, undefined, "media instructions belong in the task, not a wrapper media control");
assert.equal(send.properties.media, undefined);
assert.deepEqual(spawn.properties.attachments.items.required, ["path", "kind"]);
assert.deepEqual(spawn.properties.attachments.items.properties.kind.enum, ["reference", "image"]);
assert.equal(spawn.properties.attachments.maxItems, undefined);
assert.equal(spawn.properties.task.maxLength, undefined);
const respond = schema.tools.find((tool) => tool.name === "grok_respond")?.input_schema;
assert.equal(respond.anyOf, undefined);
assert.equal(respond.oneOf, undefined);
assert.ok(respond.properties.response.anyOf);
assert.equal(respond.properties.response.anyOf.some(branch => branch.properties?.kind), false);
const agent_id = "agent_12345678-1234-4123-8123-123456789abc";
for (const input of [
  { agent_id, task: "Continue" },
  { agent_id, action: "configure", model: "native-model" },
  { agent_id, action: "configure", effort: "native-effort" },
  { agent_id, action: "edit", task: "Replace queued text", prompt_id: "native-prompt" },
  { agent_id, action: "steer", task: "Consider this image", attachments: [{ path: "/image.png", kind: "image" }] },
  { agent_id, action: "send_now", task: "Consider this reference", attachments: [{ path: "/notes.pdf", kind: "reference" }] },
]) sourceSchema.parseToolInput("grok_send", input);
for (const input of [
  { agent_id, action: "configure" },
  { agent_id, action: "configure", model: "native-model", task: "Not a turn" },
  { agent_id, task: "Continue", model: "native-model" },
  { agent_id, action: "edit", task: "Missing exact prompt" },
  { agent_id, action: "edit", task: "No replacement attachments", prompt_id: "native-prompt", attachments: [] },
  { agent_id, action: "steer", task: "No references", attachments: [{ path: "/notes.pdf", kind: "reference" }] },
  { agent_id, task: "Not a media wrapper", media: { operation: "image_gen" } },
]) assert.throws(() => sourceSchema.parseToolInput("grok_send", input), "action semantics must reject invalid combinations before admission");
const read = schema.tools.find((tool) => tool.name === "grok_read")?.input_schema;
assert.equal(read.properties.max_chars.default, 32_000);
assert.equal(wait.properties.max_chars.default, 32_000, "wait shares one output budget across its targets");
for (const tool of [read, wait]) assert.deepEqual(tool.properties.view.enum, ["result", "records"]);
assert.deepEqual(wait.properties.until.enum, ["settled", "change"]);
assert.equal(wait.properties.until.default, "settled");
const list = schema.tools.find((tool) => tool.name === "grok_list")?.input_schema;
if (list?.properties?.include_closed?.default !== false
    || list?.properties?.limit?.maximum !== Number.MAX_SAFE_INTEGER || list?.properties?.limit?.default !== 20) {
  fail("grok_list must default to open collaborators with positive safe-integer pagination and no policy ceiling");
}
for (const max_chars of [1, 999, 500_001, Number.MAX_SAFE_INTEGER]) sourceSchema.parseToolInput("grok_read", { agent_id, max_chars });
for (const limit of [101, Number.MAX_SAFE_INTEGER]) sourceSchema.parseToolInput("grok_list", { limit });
if (wait?.properties?.timeout_ms?.maximum !== 600_000 || wait?.properties?.timeout_ms?.default !== 120_000
    || wait?.properties?.targets?.maxItems !== undefined || !Number.isFinite(mcp.tool_timeout_sec)
    || claudeManifest.mcpServers.grokpair.timeout < wait.properties.timeout_ms.maximum + 60_000
    || mcp.tool_timeout_sec * 1000 < wait.properties.timeout_ms.maximum + 60_000) {
  fail("packaged MCP tool timeout must cover the public maximum wait with a 60-second transport margin");
}

const libRoot = new URL("plugin/lib/", root);
const generated = (await readdir(libRoot, { withFileTypes: true }))
  .filter((entry) => entry.name !== ".DS_Store")
  .map((entry) => entry.name)
  .sort();
if (JSON.stringify(generated) !== JSON.stringify(["grokpair.js"])) {
  fail(`plugin/lib must contain only grokpair.js, found: ${generated.join(", ")}`);
}
await access(new URL("plugin/lib/grokpair.js", root), constants.X_OK);

const sourceRoot = new URL("src/", root);
const modules = (await readdir(sourceRoot, { withFileTypes: true }))
  .filter((entry) => entry.name !== ".DS_Store" && entry.isFile() && entry.name.endsWith(".ts"))
  .map((entry) => entry.name)
  .sort();

// This is a source-owner inventory, not a claim that live acceptance is
// complete. A module may be added, removed, or moved only by updating the
// owner map as part of the same architectural review.
const productionOwners = Object.freeze({
  public_protocol: ["core.ts", "agent-schema.ts", "agent-main.ts", "agent-service.ts"],
  durable_bridge: ["agent-store.ts", "agent-state.ts", "process.ts", "worker.ts"],
  native_adapter: ["native.ts", "attention.ts"],
  workspace_and_inputs: ["filesystem.ts", "workspace.ts"],
});
const sourceOwnerLabels = Object.freeze({
  public_protocol: "Public protocol",
  durable_bridge: "Durable state and lifecycle",
  native_adapter: "Native adapter and decisions",
  workspace_and_inputs: "Workspace and inputs",
});
const architecture = await readFile(new URL("ARCH.md", root), "utf8");
const ownerSectionMatch = architecture.match(/## Source ownership and delivery\n(?<body>[\s\S]*)/u);
if (!ownerSectionMatch?.groups?.body) fail("ARCH.md source-owner map section is missing");
const ownerRows = ownerSectionMatch.groups.body
  .split("\n")
  .filter((line) => line.startsWith("|") && line.includes(".ts"));
if (ownerRows.length !== Object.keys(sourceOwnerLabels).length) {
  fail("ARCH.md source-owner map must contain exactly the executable owner groups");
}
for (const [owner, label] of Object.entries(sourceOwnerLabels)) {
  const row = ownerRows.find((candidate) => candidate.startsWith(`| ${label} |`));
  if (!row) fail(`ARCH.md source-owner map is missing ${label}`);
  const documentedModules = [...row.matchAll(/\b([a-z-]+\.ts)\b/gu)].map((match) => match[1]).sort();
  const executableModules = [...productionOwners[owner]].sort();
  if (JSON.stringify(documentedModules) !== JSON.stringify(executableModules)) {
    fail(`ARCH.md and executable source-owner inventory disagree for ${label}`);
  }
}
const ownedModules = Object.values(productionOwners).flat().sort();
if (new Set(ownedModules).size !== ownedModules.length || JSON.stringify(ownedModules) !== JSON.stringify(modules)) {
  fail("production module inventory and architectural owner map disagree");
}
// Module count and file length are observable review signals, not product
// requirements. The validation gate enforces the exact owner inventory and
// dependency topology above and below; it reports counts without inventing an
// architectural failure from an arbitrary numeric threshold.
let lines = 0;
for (const module of modules) {
  const body = await readFile(new URL(`src/${module}`, root), "utf8");
  lines += body.split("\n").length - (body.endsWith("\n") ? 1 : 0);
}

const sourceGraph = new Map(modules.map((module) => [module, new Set()]));
const addSourceDependency = (owner, specifier) => {
  if (!specifier.startsWith(".")) return;
  let dependency = basename(specifier).replace(/\.(?:m?js|cjs)$/u, ".ts");
  if (!extname(dependency)) dependency = `${dependency}.ts`;
  if (sourceGraph.has(dependency)) sourceGraph.get(owner).add(dependency);
};
const sourceGraphBuild = await buildSourceGraph({
  absWorkingDir: new URL(".", root).pathname,
  entryPoints: modules.map((module) => `src/${module}`),
  bundle: false,
  write: false,
  metafile: true,
  outdir: "validate-source-graph",
  platform: "node",
  format: "esm",
  logLevel: "silent"
});
for (const output of Object.values(sourceGraphBuild.metafile.outputs)) {
  if (!output.entryPoint?.startsWith("src/")) continue;
  const module = basename(output.entryPoint);
  for (const dependency of output.imports) addSourceDependency(module, dependency.path);
}

const visiting = new Set(), visited = new Set(), sourceStack = [];
const visitSource = (module) => {
  if (visiting.has(module)) {
    const start = sourceStack.indexOf(module);
    fail(`production source dependency cycle: ${[...sourceStack.slice(start), module].join(" -> ")}`);
  }
  if (visited.has(module)) return;
  visiting.add(module); sourceStack.push(module);
  for (const dependency of sourceGraph.get(module)) visitSource(dependency);
  sourceStack.pop(); visiting.delete(module); visited.add(module);
};
for (const module of modules) visitSource(module);

const reachable = new Set();
const markReachable = (module) => {
  if (reachable.has(module)) return;
  reachable.add(module);
  for (const dependency of sourceGraph.get(module)) markReachable(dependency);
};
markReachable("agent-main.ts");
const unreachable = modules.filter((module) => !reachable.has(module));
if (unreachable.length) fail(`production modules have no canonical collaborator entrypoint owner: ${unreachable.join(", ")}`);

const bin = new URL("plugin/bin/grokpair", root);
const binStat = await stat(bin);
if (!binStat.isFile()) fail("plugin/bin/grokpair is not a regular file");
const binBody = await readFile(bin, "utf8");
if (binBody !== "#!/usr/bin/env node\nimport \"../lib/grokpair.js\";\n") {
  fail("plugin/bin/grokpair is not the canonical thin entrypoint");
}

// The Claude Code relay agent may call only grokpair's own tools, by their
// host-qualified names.
const relay = await readFile(new URL("plugin/agents/grok.md", root), "utf8");
const relayTools = relay.match(/^---\n[\s\S]*?^tools: (.+)$/mu)?.[1]?.split(",").map((tool) => tool.trim()).sort();
if (!isDeepStrictEqual(relayTools, expectedTools.map((tool) => CLAUDE_TOOL_PREFIX + tool).sort())) {
  fail("plugin/agents/grok.md must list exactly the eight grokpair tools by their Claude Code names");
}

process.stdout.write(JSON.stringify({
  ok: true,
  version: versions[0],
  tools: expectedTools.length,
  production_modules: modules.length,
  production_loc: lines,
  production_dependency_cycles: 0,
  production_owner_groups: Object.keys(productionOwners).length,
  generated_entrypoint: relative(new URL(".", root).pathname, new URL("plugin/lib/grokpair.js", root).pathname)
}, null, 2) + "\n");

function closedRoot(schema) {
  return schema?.type === "object" && schema.additionalProperties === false;
}
