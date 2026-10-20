import { build } from "esbuild";

export function nodeTargetFromEngineFloor(engineFloor) {
  const match = typeof engineFloor === "string"
    ? /^>=(?<version>\d+\.\d+)$/u.exec(engineFloor)
    : null;
  if (!match?.groups?.version) {
    throw new Error(`Node engine floor must be an exact >=major.minor value, found ${String(engineFloor)}`);
  }
  return `node${match.groups.version}`;
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
