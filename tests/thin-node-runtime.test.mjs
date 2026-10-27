import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

test("the bundled CLI, MCP and worker reject unsupported versions before dispatch or runtime creation", () => {
  const root = realpathSync(mkdtempSync("/private/tmp/grokpair-node-gate-"));
  const runtime = join(root, "runtime"), preload = join(root, "version.mjs");
  const entrypoint = process.env.GROKPAIR_TEST_ENTRYPOINT ?? fileURLToPath(new URL("../plugin/lib/grokpair.js", import.meta.url));
  try {
    // These exercise the real packaged gate with synthetic version observations;
    // they do not claim to qualify or execute the product under Node 26.
    for (const version of ["22.23.4", "24.22.0", "25.0.0", "26.0.0", "26.12.0", "26.12.1", "24.22.1-rc.1"]) {
      writeFileSync(preload, `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });\n`);
      for (const args of [["list"], ["mcp"], ["internal-worker", "agent_00000000-0000-4000-8000-000000000000", "never-admitted"]]) {
        const result = spawnSync(process.execPath, [`--import=${pathToFileURL(preload).href}`, entrypoint, ...args], {
          encoding: "utf8", timeout: 10_000,
          env: { ...process.env, GROKPAIR_HOME: runtime, PATH: join(root, "no-executables") },
        });
        assert.equal(result.status, 1, `${version}: ${args[0]}: ${result.stderr}`);
        assert.equal(result.stdout, "");
        const problem = JSON.parse(result.stderr.trim().split("\n").find(line => line.startsWith('{"schema_version"')));
        assert.equal(problem.call_status, "error");
        assert.equal(problem.error.code, "unsupported_node");
        assert.equal(problem.error.details.node_version, version);
        assert.equal(problem.error.details.node_engine, "^24.22.1");
        assert.equal(existsSync(runtime), false);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
