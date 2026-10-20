import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeTargetFromEngineFloor } from "./node-target.mjs";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
// Inspect only package/source owners. Runtime, retained proof and worktrees
// are not shipped source and never become cleanup or validation targets.
const forbiddenExtensions = new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".m", ".mm", ".o", ".a", ".dylib", ".so", ".node", ".dll", ".exe", ".obj", ".lib"]);
const forbiddenPaths = [];

async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const candidate = join(path, entry.name);
    if (entry.isDirectory()) await walk(candidate);
    else if (forbiddenExtensions.has(extname(entry.name).toLowerCase())) forbiddenPaths.push(relative(rootPath, candidate));
  }
}
for (const owner of ["src", "plugin", "scripts"]) await walk(join(rootPath, owner));
if (forbiddenPaths.length) throw new Error(`custom native source/artifacts remain: ${forbiddenPaths.join(", ")}`);

const bins = (await readdir(new URL("plugin/bin/", root), { withFileTypes: true }))
  .filter((entry) => entry.name !== ".DS_Store");
if (bins.length !== 1 || bins[0].name !== "grokpair" || !bins[0].isFile()) {
  throw new Error(`plugin/bin contains a custom helper: ${bins.map((entry) => entry.name).join(", ")}`);
}
const bin = new URL("plugin/bin/grokpair", root);
const header = (await readFile(bin, "utf8")).split("\n", 1)[0];
if (header !== "#!/usr/bin/env node") throw new Error("plugin entrypoint is not the Node launcher");
if (!(await stat(bin)).isFile()) throw new Error("plugin entrypoint is not a regular file");

const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
if (packageJson.type !== "module") throw new Error("package must remain an ESM-only Node runtime");
nodeTargetFromEngineFloor(packageJson.engines?.node);
const dependencyNames = Object.keys({ ...(packageJson.dependencies ?? {}), ...(packageJson.optionalDependencies ?? {}) });
const nativeDependencies = dependencyNames.filter((name) => /node-gyp|ffi|napi|native|sqlite3|better-sqlite|leveldown/iu.test(name));
if (nativeDependencies.length) throw new Error(`native runtime dependencies are forbidden: ${nativeDependencies.join(", ")}`);

process.stdout.write(JSON.stringify({
  ok: true,
  check: "hermetic_source_package",
  provider_required: false,
  custom_native_files: 0,
  plugin_bins: ["grokpair"],
  node_engine: packageJson.engines.node,
  native_runtime_dependencies: []
}, null, 2) + "\n");
