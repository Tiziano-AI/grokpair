import { spawn } from "node:child_process";
import { readdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";

const root = new URL("../", import.meta.url);
const testsRoot = new URL("../tests/", import.meta.url);
const temporaryRoot = await realpath("/private/tmp");
const scratch = await realpath(await mkdtemp(join(temporaryRoot, "grokpair-test-suite-")));
const runtimeRoot = join(scratch, "runtime");

try {
  const tests = (await readdir(testsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && (entry.name.startsWith("thin-") && entry.name.endsWith(".test.mjs") || entry.name === "node-target.test.mjs"))
    .map((entry) => new URL(entry.name, testsRoot).pathname)
    .sort();
  const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...tests], {
    cwd: root.pathname,
    env: { ...process.env, TMPDIR: temporaryRoot, GROKPAIR_HOME: runtimeRoot },
    stdio: "inherit"
  });
  const [code, signal] = await Promise.race([
    once(child, "exit"),
    once(child, "error").then(([error]) => { throw error; })
  ]);
  if (signal !== null) throw new Error(`test process exited by signal ${signal}`);
  if (code !== 0) process.exitCode = code ?? 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
