import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import assert from "node:assert/strict";
import { buildForNodeEngineFloor } from "./node-target.mjs";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const manifest = JSON.parse(await readFile(new URL("plugin/.codex-plugin/plugin.json", root), "utf8"));
const skillRoot = new URL("plugin/skills/grokpair/", root);
const skill = await readFile(new URL("SKILL.md", skillRoot), "utf8");
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(skill);
assert.ok(frontmatter, "skill requires YAML frontmatter");
const scalar = (body, key) => {
  const value = body.match(new RegExp("^\\s*" + key + ": (.+)$", "mu"))?.[1]?.trim();
  if (value?.startsWith('"')) return JSON.parse(value);
  return value;
};
assert.equal(scalar(frontmatter[1], "name"), manifest.name);
assert.ok(typeof scalar(frontmatter[1], "description") === "string"
  && scalar(frontmatter[1], "description").trim(), "skill description must be nonempty");
assert.ok(skill.slice(frontmatter[0].length).trim(), "skill body must be nonempty");

const card = await readFile(new URL("agents/openai.yaml", skillRoot), "utf8");
for (const key of ["display_name", "short_description", "default_prompt"]) {
  assert.ok(typeof scalar(card, key) === "string" && scalar(card, key).trim(),
    "skill card requires " + key);
}
assert.ok(scalar(card, "default_prompt").includes("$" + manifest.name),
  "default prompt must name the actual skill");
assert.match(card, /^\s*allow_implicit_invocation: (?:true|false)\s*$/mu,
  "invocation policy must be an explicit boolean");

// Validate the actual resource graph, without fixing a package anatomy,
// heading vocabulary, example count or prose length.
const markdown = new Map();
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) await visit(url);
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      markdown.set(url.href, await readFile(url, "utf8"));
    }
  }
}
await visit(skillRoot);
const anchors = body => new Set([...body.matchAll(/^#{1,6} (.+)$/gmu)]
  .map(([, heading]) => heading.toLowerCase().replace(/[`]/gu, "")
    .replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /gu, "-")));
const reachable = new Set();
async function checkLinks(url) {
  if (reachable.has(url)) return;
  reachable.add(url);
  for (const [, target] of markdown.get(url).matchAll(/\]\(([^)]+)\)/gu)) {
    if (/^[a-z]+:/iu.test(target)) continue;
    const destination = new URL(target, url);
    assert.ok(destination.href.startsWith(skillRoot.href), "resource link leaves package: " + target);
    const hash = destination.hash;
    destination.hash = "";
    await access(destination, constants.R_OK);
    if (hash) {
      assert.ok(markdown.has(destination.href), "anchor target must be Markdown: " + target);
      assert.ok(anchors(markdown.get(destination.href)).has(decodeURIComponent(hash.slice(1))),
        "missing resource anchor: " + target);
    }
    if (markdown.has(destination.href)) await checkLinks(destination.href);
  }
}
await checkLinks(new URL("SKILL.md", skillRoot).href);
for (const url of markdown.keys()) assert.ok(reachable.has(url), "unreachable skill resource: " + url);

// Compile only the public schema in memory. No worker, native configuration,
// runtime state or provider is touched by documentation validation.
const compiled = await buildForNodeEngineFloor(packageJson.engines.node, {
  entryPoints: [new URL("src/agent-schema.ts", root).pathname],
  bundle: true, write: false, platform: "node", format: "esm",
});
const source = await import("data:text/javascript;base64,"
  + Buffer.from(compiled.outputFiles[0].contents).toString("base64"));
let examples = 0;
for (const [path, body] of markdown) {
  for (const match of body.matchAll(/^Tool: (\S+)\s*\n\s*```json\s*\n([\s\S]*?)^```\s*$/gmu)) {
    assert.ok(Object.hasOwn(source.ToolInputSchemas, match[1]), path + ": unknown declared tool");
    const input = JSON.parse(match[2]);
    assert.doesNotThrow(() => source.parseToolInput(match[1], input),
      path + ": invalid " + match[1] + " input example");
    examples++;
  }
}
process.stdout.write(JSON.stringify({
  ok: true, schema_version: source.PUBLIC_SCHEMA_VERSION,
  resources: markdown.size, examples, provider_required: false,
}, null, 2) + "\n");
