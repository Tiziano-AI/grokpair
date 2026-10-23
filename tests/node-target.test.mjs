import assert from "node:assert/strict";
import test from "node:test";
import {
  nodeBuildOptionsFromEngineFloor,
  nodeTargetFromEngineFloor
} from "../scripts/node-target.mjs";

test("the package Node floor projects to the exact esbuild target", () => {
  assert.equal(nodeTargetFromEngineFloor(">=22.13"), "node22.13");
  assert.equal(nodeTargetFromEngineFloor(">=24.22.1"), "node24.22.1");
});

test("non-exact Node engine ranges cannot become an implicit build target", () => {
  for (const value of [
    undefined,
    null,
    "22.13",
    ">=22",
    ">=24.22.1.0",
    "^22.13",
    ">=22.13 <23",
    ">=22.13 "
  ]) {
    assert.throws(
      () => nodeTargetFromEngineFloor(value),
      /Node engine floor must be an exact >=major\.minor or >=major\.minor\.patch value/u
    );
  }
});

test("the package floor is the only esbuild target owner", () => {
  assert.deepEqual(
    nodeBuildOptionsFromEngineFloor(">=22.13", { bundle: true, format: "esm" }),
    { bundle: true, format: "esm", target: "node22.13" }
  );
  assert.deepEqual(
    nodeBuildOptionsFromEngineFloor(">=24.22.1", { bundle: true, format: "esm" }),
    { bundle: true, format: "esm", target: "node24.22.1" }
  );
  assert.throws(
    () => nodeBuildOptionsFromEngineFloor(">=22.13", { target: "node20" }),
    /esbuild target is owned by the package Node engine floor/u
  );
});
