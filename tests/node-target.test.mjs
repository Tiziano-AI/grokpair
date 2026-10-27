import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { supportsNodeVersion } from "../src/node-runtime.ts";
import {
  nodeBuildOptionsFromEngineFloor,
  nodeTargetFromEngineFloor
} from "../scripts/node-target.mjs";

test("the package Node floor projects to the exact esbuild target", () => {
  assert.equal(nodeTargetFromEngineFloor("^22.13.0"), "node22.13.0");
  assert.equal(nodeTargetFromEngineFloor("^24.22.1"), "node24.22.1");
});

test("non-exact Node engine ranges cannot become an implicit build target", () => {
  for (const value of [
    undefined,
    null,
    "22.13",
    ">=22",
    ">=24.22.1",
    "^24.22.1.0",
    "^22.13",
    "^0.1.0",
    "^24.022.1",
    "^24.22.1 || ^26.12.1",
    "^24.22.1-rc.1",
    ">=22.13 <23",
    ">=22.13 "
  ]) {
    assert.throws(
      () => nodeTargetFromEngineFloor(value),
      /Node support must be a single \^major\.minor\.patch range/u
    );
  }
});

test("the package floor is the only esbuild target owner", () => {
  assert.deepEqual(
    nodeBuildOptionsFromEngineFloor("^22.13.0", { bundle: true, format: "esm" }),
    { bundle: true, format: "esm", target: "node22.13.0" }
  );
  assert.deepEqual(
    nodeBuildOptionsFromEngineFloor("^24.22.1", { bundle: true, format: "esm" }),
    { bundle: true, format: "esm", target: "node24.22.1" }
  );
  assert.throws(
    () => nodeBuildOptionsFromEngineFloor("^22.13.0", { target: "node20" }),
    /esbuild target is owned by the package Node engine floor/u
  );
});

test("the package admits patched stable Node 24 only, not numerically later majors", () => {
  const { engines: { node: engine } } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(engine, "^24.22.1");
  for (const version of ["24.22.1", "24.22.2", "24.23.0", "24.99.99"]) {
    assert.equal(supportsNodeVersion(version, engine), true, version);
  }
  for (const version of ["22.23.4", "24.0.0", "24.22.0", "25.0.0", "26.0.0", "26.12.0", "26.12.1", "27.0.0", "24.22.1-rc.1", "24.22.1+custom", "v24.22.1", "24.022.1", "not-node"]) {
    assert.equal(supportsNodeVersion(version, engine), false, version);
  }
});
