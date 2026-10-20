import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = new URL("../", import.meta.url);

test("the validation gate checks pnpm 12's final project document without using the environment importer", async (t) => {
  const scratch = await realpath(await mkdtemp("/private/tmp/grokpair-lockfile-validation-"));
  try {
    // Run the actual gate, not a second implementation of its parser. Only
    // source and generated product inputs are copied; native homes and state
    // never enter this provider-free fixture.
    for (const path of ["scripts", "src", "plugin", ".agents/plugins", ".claude-plugin"]) {
      await cp(new URL(path, root), join(scratch, path), { recursive: true });
    }
    for (const path of ["package.json", "ARCH.md", "pnpm-workspace.yaml"]) {
      await cp(new URL(path, root), join(scratch, path));
    }
    await symlink(new URL("node_modules", root).pathname, join(scratch, "node_modules"), "dir");
    const manifest = JSON.parse(await readFile(join(scratch, "package.json"), "utf8"));
    const sections = ["dependencies", "devDependencies", "optionalDependencies"]
      .filter((owner) => Object.keys(manifest[owner] ?? {}).length)
      .map((owner) => `    ${owner}:\n` + Object.entries(manifest[owner])
        .map(([name, version]) => `      '${name}':\n        specifier: ${version}\n        version: ${version}\n`).join(""));
    const project = `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n${sections.join("")}\npackages: {}\nsnapshots: {}\n`;
    const pnpmVersion = manifest.packageManager.match(/^pnpm@([^+]+)/u)[1];
    const environment = `---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    configDependencies: {}\n    packageManagerDependencies:\n      pnpm:\n        specifier: ${pnpmVersion}\n        version: ${pnpmVersion}\n\npackages: {}\nsnapshots: {}\n\n---\n`;
    const validate = async (lock) => {
      await writeFile(join(scratch, "pnpm-lock.yaml"), lock);
      return run(process.execPath, [join(scratch, "scripts/validate.mjs")], {
        cwd: scratch, env: { ...process.env, GROKPAIR_HOME: join(scratch, "runtime") }
      });
    };
    const accepts = async (lock) => {
      const result = await validate(lock);
      assert.equal(JSON.parse(result.stdout).ok, true);
      assert.equal(await readFile(join(scratch, "pnpm-lock.yaml"), "utf8"), lock,
        "validation must not rewrite or discard either document");
    };
    const rejects = async (lock, message) => {
      await assert.rejects(validate(lock), (error) => {
        assert.notEqual(error.code, 0);
        assert.match(error.stderr, message);
        return true;
      });
    };

    await t.test("an environment-first lock preserves the project's pinned inventory", () => accepts(environment + project));
    await t.test("the optional environment document can be absent", () => accepts(project));
    await t.test("BOM and CRLF retain the same document boundary", () => accepts("\uFEFF" + (environment + project).replaceAll("\n", "\r\n")));
    await t.test("a missing project importer cannot fall back to the environment importer", () => rejects(
      environment + "lockfileVersion: '9.0'\nimporters: {}\npackages: {}\nsnapshots: {}\n",
      /lockfile is missing the root package importer/u
    ));
    await t.test("an empty final document cannot reuse the preceding project importer", () => rejects(
      environment + project + "---\n",
      /lockfile is missing the root package importer/u
    ));
    await t.test("a missing project dependency still fails inventory enforcement", () => rejects(
      environment + project.replace(/^      'zod':\n        specifier: [^\n]+\n        version: [^\n]+\n/mu, ""),
      /dependencies lockfile inventory differs from package\.json/u
    ));
    await t.test("a different project specifier still fails exact-pin enforcement", () => rejects(
      environment + project.replace(/('zod':\n        specifier: )[^\n]+/u, "$1^4.0.0"),
      /lockfile importer does not resolve zod to its package\.json pin/u
    ));
    await t.test("a different resolved project version still fails exact-pin enforcement", () => rejects(
      environment + project.replace(/('zod':\n        specifier: [^\n]+\n        version: )[^\n]+/u, "$10.0.0"),
      /lockfile importer does not resolve zod to its package\.json pin/u
    ));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
