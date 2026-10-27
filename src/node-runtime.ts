const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

/** This product supports one stable Node major, not arbitrary semver ranges. */
export function nodeEngineFloor(engine: unknown): string {
  const floor = typeof engine === "string" && engine.startsWith("^") ? engine.slice(1) : "";
  if (!stableVersion.test(floor) || floor.startsWith("0.")) {
    throw new Error(`Node support must be a single ^major.minor.patch range, found ${String(engine)}`);
  }
  return floor;
}

export function supportsNodeVersion(version: string, engine: unknown): boolean {
  const floor = nodeEngineFloor(engine);
  if (!stableVersion.test(version)) return false;
  const [major, minor, patch] = version.split(".").map(Number) as [number, number, number];
  const [floorMajor, floorMinor, floorPatch] = floor.split(".").map(Number) as [number, number, number];
  return major === floorMajor && (minor > floorMinor || minor === floorMinor && patch >= floorPatch);
}
