import { build } from "esbuild";
import { nodeEngineFloor } from "../src/node-runtime.ts";

export function nodeTargetFromEngineFloor(engineFloor) {
  return `node${nodeEngineFloor(engineFloor)}`;
}

export function nodeBuildOptionsFromEngineFloor(engineFloor, options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("esbuild options must be an object");
  }
  if (Object.hasOwn(options, "target")) {
    throw new Error("esbuild target is owned by the package Node engine floor");
  }
  return { ...options, target: nodeTargetFromEngineFloor(engineFloor) };
}

export function buildForNodeEngineFloor(engineFloor, options) {
  return build(nodeBuildOptionsFromEngineFloor(engineFloor, options));
}
