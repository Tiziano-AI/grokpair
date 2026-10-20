import assert from "node:assert/strict";
import test from "node:test";
import {
  nodeBuildOptionsFromEngineFloor,
  nodeTargetFromEngineFloor
} from "../scripts/node-target.mjs";

test("the package Node floor projects to the exact esbuild target", () => {
  assert.equal(nodeTargetFromEngineFloor(">=22.13"), "node22.13");
});

test("non-exact Node engine ranges cannot become an implicit build target", () => {
  for (const value of [
    undefined,
    null,
    "22.13",
    ">=22",
    ">=22.13.0",
    "^22.13",
    ">=22.13 <23",
    ">=22.13 "
  ]) {
    assert.throws(
      () => nodeTargetFromEngineFloor(value),
      /Node engine floor must be an exact >=major\.minor value/u
    );
  }
});

test("the package floor is the only esbuild target owner", () => {
  assert.deepEqual(
    nodeBuildOptionsFromEngineFloor(">=22.13", { bundle: true, format: "esm" }),
    { bundle: true, format: "esm", target: "node22.13" }
  );
  assert.throws(
    () => nodeBuildOptionsFromEngineFloor(">=22.13", { target: "node20" }),
    /esbuild target is owned by the package Node engine floor/u
  );
});
