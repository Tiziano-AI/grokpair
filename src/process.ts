import { spawnSync } from "node:child_process";

export type ProcessIdentity = { pid: number; pgid: number; birth: string };
export type ProcessObservation = { status: "observed"; identity: ProcessIdentity } | { status: "absent" } | { status: "unknown"; message: string };
const valid = (pid: number) => Number.isSafeInteger(pid) && pid > 1;

/** Portable kernel process coordinates, never command-line text or a stale PID alone. */
export function observeProcess(pid: number): ProcessObservation {
  if (!valid(pid)) return { status: "unknown", message: "Invalid process identity" };
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-ww", "-o", "pid=,pgid=,lstart="], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 3000, stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.error) return { status: "unknown", message: result.error.message };
  const output = result.stdout.trim();
  if (result.status === 1 && output === "") {
    try { process.kill(pid, 0); return { status: "unknown", message: "Process exists but ps identity is unavailable" }; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? { status: "absent" } : { status: "unknown", message: "Process absence is unobservable" }; }
  }
  if (result.status !== 0) return { status: "unknown", message: "ps failed to observe process" };
  const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(output);
  if (!match) return { status: "unknown", message: "Unrecognized process identity" };
  const observedPid = Number(match[1]), pgid = Number(match[2]), birth = match[3]!.trim();
  if (observedPid !== pid || !Number.isSafeInteger(pgid) || pgid < 1 || !birth) return { status: "unknown", message: "Invalid observed identity" };
  return { status: "observed", identity: { pid, pgid, birth } };
}
export function currentProcessIdentity(): ProcessIdentity {
  const observation = observeProcess(process.pid);
  if (observation.status !== "observed") throw new Error("Current process identity is unavailable");
  return observation.identity;
}
export function processIdentityStatus(expected: ProcessIdentity): "alive" | "absent" | "unknown" {
  if (!valid(expected.pid) || !expected.birth) return "unknown";
  const observed = observeProcess(expected.pid);
  if (observed.status !== "observed") return observed.status;
  // Process groups can change during a process lifetime; birth identifies the
  // incarnation while pgid is merely an observed (mutable) coordinate.
  return observed.identity.birth === expected.birth ? "alive" : "absent";
}
/** Signal only a freshly attested individual process; group killing is not implicit. */
export function signalProcess(expected: ProcessIdentity, signal: NodeJS.Signals = "SIGTERM"): void {
  const observation = observeProcess(expected.pid);
  if (observation.status !== "observed" || observation.identity.birth !== expected.birth) throw new Error("Cannot signal an unattested process");
  process.kill(expected.pid, signal);
}
