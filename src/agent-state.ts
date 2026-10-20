import { mayStillClaim, promptActivity, type AgentStore, type JsonRecord, type Operation } from "./agent-store.js";
import { processIdentityStatus } from "./process.js";

export type AgentStatus = "starting" | "working" | "attention" | "ready" | "idle" | "disconnected" | "closed" | "unavailable";
export type QueueObservation = { status: "observed" } | { status: "unknown"; reason: string };
export type AgentSummary = JsonRecord & {
  agent_id: string; cwd: string; worktree: boolean; created_at: string; status: AgentStatus;
  counts: { pending_operations: number; queued_prompts: number | null; pending_attention: number; unknown_operations: number };
  queue_observation: QueueObservation;
};
const object = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};

/** Retain the raw native queue; only its effective activity excludes ended autonomous prompts. */
export function effectiveQueue(store: AgentStore): { queued: number | null; running: boolean; observation: QueueObservation } {
  const queue = store.observation("queue");
  if (!queue || queue.unavailable === true) return { queued: null, running: false, observation: { status: "unknown",
    reason: typeof queue?.reason === "string" ? queue.reason : queue ? "Native queue observation is unavailable." : "No native queue snapshot has been observed." } };
  const running = typeof queue.runningPromptId === "string" && !!queue.runningPromptId && !promptActivity(store, queue.runningPromptId).inactive;
  if (!Array.isArray(queue.entries) || queue.entries.some(value => typeof object(value).id !== "string" || !object(value).id)) {
    return { queued: null, running, observation: { status: "unknown", reason: "Native queue snapshot has no complete valid entries list." } };
  }
  const entries = queue.entries;
  return {
    queued: entries.filter(value => !promptActivity(store, object(value).id).inactive).length,
    running, observation: { status: "observed" },
  };
}
function activeOperation(store: AgentStore, operation: Operation): boolean {
  // Native turn terminality is independent of a delayed prompt RPC receipt.
  if (["follow_up", "send_now"].includes(operation.kind) && promptActivity(store, operation.native_prompt_id).inactive) return false;
  return true;
}

/** One passive derivation owns public activity. No worker-maintained status mirror. */
export function summarizeAgent(store: AgentStore): AgentSummary {
  const meta = store.meta(), claim = store.worker(), launch = store.launch();
  const queue = effectiveQueue(store), pending = store.pendingOperations();
  const counts = {
    pending_operations: pending.length,
    queued_prompts: queue.queued,
    pending_attention: store.count("attention", ["pending"]),
    unknown_operations: store.count("operation", ["outcome_unknown"]),
  };
  let status: AgentStatus;
  if (meta.phase === "closed") status = "closed";
  // An unclaimed reservation is starting only while its launched worker may still claim it.
  else if (!claim) status = launch?.state === "reserved" && mayStillClaim(launch) ? "starting" : "disconnected";
  else {
    const worker = processIdentityStatus(claim.worker);
    const provider = claim.provider_state === "running" && claim.provider ? processIdentityStatus(claim.provider) : null;
    const provisioner = claim.provisioner_state === "running" && claim.provisioner ? processIdentityStatus(claim.provisioner) : null;
    if (worker === "unknown" || provider === "unknown" || provisioner === "unknown") status = "unavailable";
    else if (worker === "absent" || meta.phase === "disconnected") status = "disconnected";
    // The live opening worker still owns draining startup diagnostics after a
    // child exit; do not report a settled failure before it records the result.
    else if (meta.phase === "opening") status = "starting";
    else if (provider === "absent") status = "disconnected";
    else if (counts.pending_attention) status = "attention";
    else if (meta.phase === "stopping" || queue.running || queue.queued || store.runningTurns().some(turn => !promptActivity(store, turn.prompt_id).inactive) || pending.some(operation => activeOperation(store, operation))) status = "working";
    else status = queue.observation.status === "observed" ? "idle" : "ready";
  }
  const provisioning = object(meta.provisioning);
  const provisioningView = ["starting", "running"].includes(String(provisioning.status)) && ["disconnected", "unavailable", "closed"].includes(status)
    ? { ...provisioning, status: "outcome_unknown", reason: "The worker is not observable as running; native creation was not observed to settle." }
    : provisioning;
  return {
    agent_id: meta.agent_id, cwd: meta.cwd, worktree: meta.worktree, created_at: meta.created_at, status, counts, queue_observation: queue.observation,
    execution_cwd: meta.execution_cwd, worktree_root: meta.worktree_root ?? null, sandbox_argument: meta.sandbox_argument,
    sandbox_observation: { status: "unavailable", reason: "Native ACP does not report the resolved sandbox or its enforcement." },
    ...(meta.provisioning === undefined ? {} : { provisioning: provisioningView }),
    ...(typeof meta.key === "string" ? { key: meta.key } : {}),
    ...(typeof meta.native_session_id === "string" ? { native_session_id: meta.native_session_id } : {}),
  };
}
