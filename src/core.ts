import { randomUUID } from "node:crypto";
import manifest from "../package.json" with { type: "json" };

/** Product data primitives; no runtime, provider or public-contract dependency. */
export const PRODUCT = "grokpair" as const;
export const PRODUCT_VERSION = manifest.version;
export const NODE_ENGINE = manifest.engines.node;
export const PUBLIC_SCHEMA_VERSION = "3" as const;
/** Set in a collaborator's provider environment; a grokpair started beneath it serves no tools. */
export const COLLABORATOR_MARKER = "GROKPAIR_COLLABORATOR" as const;
export function now(): string { return new Date().toISOString(); }
export function id(prefix: "agent" | "operation" | "request"): string {
  return `${prefix}_${randomUUID()}`;
}


export class AgentError extends Error {
  constructor(readonly code: string, message: string, readonly action: string,
    readonly details: Record<string, unknown> = {}, options?: ErrorOptions) {
    super(message, options); this.name = "AgentError";
  }
}
export type Failure = { code: string; message: string; action: string; details: Record<string, unknown> };
export type DiagnosticMessage = { source: string; message: string };
export type DiagnosticCode = { source: string; code: string | number };
export type ExplicitDiagnostics = {
  messages: DiagnosticMessage[];
  codes: DiagnosticCode[];
  fields: { source: string; value: string }[];
  references: { source: string; reference: string; kind: "cycle" | "shared" }[];
};

/** Walk only explicit diagnostic fields. Never retain stacks, stdout, thoughts,
 * arbitrary data objects or tool history. Flat provenance keeps even a very deep
 * Error/AggregateError graph serializable without recursive traversal. */
export function explicitDiagnostics(roots: { value: unknown; source: string }[]): ExplicitDiagnostics {
  const result: ExplicitDiagnostics = { messages: [], codes: [], fields: [], references: [] };
  type Task = { value: unknown; source: string; kind: "record" | "message" | "leave" };
  const tasks: Task[] = roots.map(root => ({ ...root, kind: "record" as const })).reverse();
  const visited = new WeakMap<object, string>(), active = new WeakSet<object>();
  while (tasks.length) {
    const { value, source, kind } = tasks.pop()!;
    if (kind === "leave") { active.delete(value as object); continue; }
    if (typeof value === "string") {
      if (value.trim()) result.messages.push({ source, message: value });
      continue;
    }
    if (kind === "record" && (value === null || value === undefined || ["number", "boolean", "bigint", "symbol"].includes(typeof value))) {
      result.messages.push({ source, message: String(value) });
      continue;
    }
    if (kind === "message" || value === null || typeof value !== "object") continue;
    const prior = visited.get(value);
    if (prior !== undefined) {
      result.references.push({ source, reference: prior, kind: active.has(value) ? "cycle" : "shared" });
      continue;
    }
    visited.set(value, source); active.add(value);
    tasks.push({ value, source, kind: "leave" });
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) tasks.push({ value: value[index], source: `${source}[${index}]`, kind: "record" });
      continue;
    }
    const object = value as Record<string, unknown>;
    const code = object.code;
    if (typeof code === "string" || typeof code === "number" && Number.isFinite(code)) result.codes.push({ source: `${source}.code`, code });
    for (const key of ["name", "title", "tool_call_id", "toolCallId", "prompt_id", "promptId", "message_id", "messageId", "session_id", "sessionId"]) {
      if (typeof object[key] === "string") result.fields.push({ source: `${source}.${key}`, value: object[key] });
    }
    // LIFO: structured error.message precedes sibling message; textual `error`
    // is less specific. Cause arrays retain every member in native order.
    for (const key of ["errors", "causes", "cause"]) {
      if (Object.hasOwn(object, key)) tasks.push({ value: object[key], source: `${source}.${key}`, kind: "record" });
    }
    // `data` is an error-envelope field, not a generic raw tool-output slot.
    if ((value instanceof Error || object.name === "RequestError") && object.data !== undefined) {
      tasks.push({ value: object.data, source: `${source}.data`, kind: "record" });
    }
    if (typeof object.error === "string") tasks.push({ value: object.error, source: `${source}.error`, kind: "message" });
    tasks.push({ value: object.message, source: `${source}.message`, kind: "message" });
    if (object.error !== null && typeof object.error === "object") tasks.push({ value: object.error, source: `${source}.error`, kind: "record" });
  }
  return result;
}

export function primaryDiagnostic(messages: DiagnosticMessage[]): DiagnosticMessage | undefined {
  // Native envelopes often say only "error" or "Internal error" while data
  // contains the actionable rejection. Keep the envelope, but not as headline.
  const generic = /^(?:error|failed|failure|unknown error|internal error|internal server error|invalid params|invalid parameters|invalid request|method not found|parse error|request failed|tool failed|native tool reported failure)[.!:]?$/i;
  return messages.find(item => !generic.test(item.message.trim())) ?? messages[0];
}

export function failure(error: unknown, fallback = "agent_failed"): Failure {
  if (error instanceof AgentError && error.cause === undefined) return { code: error.code, message: error.message, action: error.action, details: error.details };
  const value = error !== null && typeof error === "object" ? error as Record<string, unknown> : { message: String(error) };
  const diagnostics = explicitDiagnostics([{ value, source: "error" }]);
  const primary = primaryDiagnostic(diagnostics.messages), nativeCode = diagnostics.codes[0];
  const code = typeof value.code === "string" ? value.code : fallback;
  const request = value.name === "RequestError" && typeof value.code === "number";
  const action = request
    ? "Inspect the native request rejection and correct the indicated input or precondition; check recorded operation effects before submitting a new request. This rejection does not authorize replay."
    : "Inspect the diagnostic and recorded operation effects before deciding the next action; this failure alone does not authorize replay.";
  return { code, message: error instanceof AgentError ? error.message : primary?.message ?? "Unknown failure",
    action: error instanceof AgentError ? error.action : action,
    details: { ...(error instanceof AgentError ? error.details : {}), ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(primary ? { diagnostic_source: primary.source } : {}),
      ...(nativeCode ? { native_code: nativeCode.code, native_code_source: nativeCode.source } : {}),
      ...(diagnostics.messages.length ? { diagnostics: diagnostics.messages } : {}),
      ...(diagnostics.codes.length ? { native_codes: diagnostics.codes } : {}),
      ...(diagnostics.fields.length ? { diagnostic_fields: diagnostics.fields } : {}),
      ...(diagnostics.references.length ? { diagnostic_references: diagnostics.references } : {}) } };
}
