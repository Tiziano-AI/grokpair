import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { generatedFiles } from "../scripts/manifests.mjs";
import { bundledNotices } from "../scripts/bundled-notices.mjs";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
test("host packages inherit native approval, with no bypass hook or tool-specific preapproval", () => {
  const files = generatedFiles(pkg);
  for (const name of ["plugin/.codex-plugin/plugin.json", "plugin/.claude-plugin/plugin.json"]) {
    const manifest = files[name];
    assert.equal(manifest.hooks, undefined);
    assert.equal(manifest.mcpServers.grokpair.default_tools_approval_mode, undefined);
    assert.equal(manifest.mcpServers.grokpair.tools, undefined);
  }
  assert.equal(files["plugin/hooks/hooks.json"], undefined);
});

test("notices follow bundled bytes, include complete owner texts, and reject missing legal files", async () => {
  const root = await realpath(await mkdtemp("/private/tmp/grokpair-notices-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    const dependency = join(root, "node_modules", "contributor");
    await mkdir(join(dependency, "lib"), { recursive: true });
    await writeFile(join(dependency, "package.json"), JSON.stringify({ name: "contributor", version: "2.0.0", license: "MIT" }));
    const source = "node_modules/contributor/lib/index.js";
    const graph = { inputs: { "src/main.ts": {}, [source]: {}, "node_modules/not-emitted/index.js": {} },
      outputs: { "out.js": { inputs: { "src/main.ts": { bytesInOutput: 1 }, [source]: { bytesInOutput: 20 }, "node_modules/not-emitted/index.js": { bytesInOutput: 0 } } } } };
    await assert.rejects(bundledNotices(graph, root), /No license text.*contributor@2.0.0/);
    await writeFile(join(dependency, "LICENSE"), "Copyright fixture\nKeep every line.\n");
    await writeFile(join(dependency, "NOTICE.txt"), "An additional notice.\n");
    const notices = await bundledNotices(graph, root);
    assert.match(notices, /contributor@2.0.0/);
    assert.ok(notices.includes("Copyright fixture\nKeep every line."));
    assert.ok(notices.includes("An additional notice."));
    const compiler = JSON.parse(await readFile(new URL(import.meta.resolve("esbuild/package.json")), "utf8"));
    assert.ok(notices.includes(`## esbuild@${compiler.version}\n`));
    assert.ok(notices.includes("Copyright (c) 2020 Evan Wallace"));
    assert.doesNotMatch(notices, /not-emitted|fixture@1.0.0/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
