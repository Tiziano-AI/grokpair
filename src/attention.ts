import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { Ajv } from "ajv";
import addFormats, { type FormatsPlugin } from "ajv-formats";
import { AgentError } from "./core.js";

export const NATIVE_ATTENTION_METHODS = [
  "session/request_permission", "_x.ai/ask_user_question", "_x.ai/exit_plan_mode",
  "_x.ai/mcp/elicit", "elicitation/create",
] as const;
export type NativeAttentionMethod = typeof NATIVE_ATTENTION_METHODS[number];
type JsonObject = Readonly<Record<string, unknown>>;
export type Attention = Readonly<{ method: NativeAttentionMethod; payload: JsonObject }>;
export type NativeAttentionResponse = JsonObject;

/** Identity used by native pending_interaction / interaction_resolved. */
export function attentionToolCallId(method: string, payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const fields = payload as JsonObject;
  const owner = method === "session/request_permission" ? fields.toolCall
    : NATIVE_ATTENTION_METHODS.some(known => known === method && known.startsWith("_x.ai/")) ? fields : undefined;
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) return undefined;
  const id = (owner as JsonObject).toolCallId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function invalid(message: string): never { throw new Error(message); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(label + " must be an object");
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string") invalid(label + " must be text");
  return value as string;
}
function optionalText(value: Record<string, unknown>, key: string): void {
  if (Object.hasOwn(value, key) && value[key] !== null) text(value[key], key);
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(label + " must be an array");
  return value as unknown[];
}
function absent(value: Record<string, unknown>, keys: string[]): void {
  if (keys.some((key) => Object.hasOwn(value, key))) invalid("response cannot carry " + keys.join(", ") + " for this outcome");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function snapshot<T>(value: T): T { return freeze(structuredClone(value)); }
function checked<T>(code: string, operation: () => T): T {
  try { return operation(); }
  catch (cause) { throw new AgentError(code, cause instanceof Error ? cause.message : String(cause),
    code === "invalid_attention_response"
      ? "Read the exact pending native method and payload, then correct the response; no answer was submitted."
      : "Inspect the retained native request and diagnostic; do not invent an answer for an invalid request.", {}, { cause }); }
}
function compileForm(schema: JsonObject) {
  if (schema.type !== "object" || schema.$async !== undefined) invalid("elicitation schema must describe a synchronous object");
  // The SDK reuses getSchema($id) before compiling. Do not preload meta-schemas:
  // a native form can otherwise select one by ID and bypass its own fields.
  // Each form keeps its exact ID/relative refs and its own compiler, with no
  // remote loading, coercion, defaults, stripping or content mutation.
  const ajv = new Ajv({ strict: false, validateFormats: true, validateSchema: false, allErrors: true, meta: false });
  (addFormats as unknown as FormatsPlugin)(ajv);
  return new AjvJsonSchemaValidator(ajv).getValidator(schema);
}

/** Strip only the SDK extension envelope, never native parameter fields. */
export function unwrapAttentionParams(method: string, params: unknown): Record<string, unknown> {
  let raw = object(params, "native attention params");
  if (method.startsWith("_") && Object.hasOwn(raw, "method") && Object.hasOwn(raw, "params")) {
    if (raw.method !== method.slice(1)) invalid("native extension envelope belongs to another method");
    raw = object(raw.params, "native extension params");
  }
  return raw;
}

/** Unknown methods return null. Invalid known requests throw invalid_native_attention. */
export function parseAttention(method: string, params: unknown): Attention | null {
  if (!(NATIVE_ATTENTION_METHODS as readonly string[]).includes(method)) return null;
  return checked("invalid_native_attention", () => {
    const raw = unwrapAttentionParams(method, params);
    if (method !== "elicitation/create") text(raw.sessionId, "native session ID");
    if (method.startsWith("_")) text(raw.toolCallId, "native tool call ID");
    if (method === "session/request_permission") {
      const tool = object(raw.toolCall, "native permission tool call");
      text(tool.toolCallId, "native tool call ID");
      for (const entry of array(raw.options, "permission options")) {
        const option = object(entry, "permission option");
        text(option.optionId, "permission option ID"); text(option.name, "permission name");
        if (!["allow_once", "allow_always", "reject_once", "reject_always"].includes(option.kind as string)) invalid("invalid permission option kind");
      }
    } else if (method === "_x.ai/ask_user_question") {
      if (raw.mode !== "default" && raw.mode !== "plan") invalid("invalid native question mode");
      for (const entry of array(raw.questions, "questions")) {
        const question = object(entry, "question"); text(question.question, "question text");
        optionalText(question, "id");
        if (question.multiSelect != null && typeof question.multiSelect !== "boolean") invalid("invalid multiSelect");
        for (const entry of array(question.options, "question options")) {
          const option = object(entry, "question option");
          text(option.label, "option label"); text(option.description, "option description");
          optionalText(option, "preview"); optionalText(option, "id");
        }
      }
    } else if (method === "_x.ai/exit_plan_mode") {
      optionalText(raw, "planContent");
    } else {
      const standard = method === "elicitation/create";
      text(raw.message, "elicitation message");
      if (!standard || Object.hasOwn(raw, "serverName")) text(raw.serverName, "elicitation server");
      const mode = standard && raw.mode === undefined ? "form" : raw.mode;
      if (mode === "url") {
        new URL(text(raw.url, "elicitation URL")); // Syntax only, never navigation or fetching.
        text(raw.elicitationId, "elicitation ID");
      } else if (mode === "form") {
        if (raw.requestedSchema != null || standard) {
          const schema = object(raw.requestedSchema, "elicitation schema");
          if (standard && Object.hasOwn(schema, "properties")) {
            // MCP/ACP standard form responses are flat primitives or string
            // arrays. Reject unanswerable property shapes, without narrowing
            // the separate xAI JSON-form extension or rewriting native params.
            for (const [name, value] of Object.entries(object(schema.properties, "elicitation properties"))) {
              const property = object(value, "elicitation property " + name);
              if (["string", "number", "integer", "boolean"].includes(property.type as string)) continue;
              if (property.type === "array") {
                const items = object(property.items, "elicitation array items " + name);
                if (items.type === "string" || items.type === undefined && Array.isArray(items.anyOf)
                  && items.anyOf.every(item => typeof object(item, "elicitation string choice").const === "string")) continue;
              }
              invalid("standard elicitation property " + name + " requires a flat primitive or string-array response");
            }
          }
          compileForm(schema);
        }
      } else invalid("invalid elicitation mode");
    }
    return snapshot({ method: method as NativeAttentionMethod, payload: raw });
  });
}

/** Validate the native object without translating it. Failure leaves pending state untouched. */
export function validateAttentionResponse(attention: Attention, publicResponse: unknown): NativeAttentionResponse {
  return checked("invalid_attention_response", () => {
    const response = object(publicResponse, "response");
    if (attention.method === "session/request_permission") {
      const outcome = object(response.outcome, "permission outcome");
      if (outcome.outcome === "selected") {
        const optionId = text(outcome.optionId, "permission option ID");
        if (!array(attention.payload.options, "permission options").some((option) => object(option, "permission option").optionId === optionId)) invalid("permission option was not offered by the native request");
      } else if (outcome.outcome === "cancelled") absent(outcome, ["optionId"]);
      else invalid("invalid permission outcome");
    } else if (attention.method === "_x.ai/ask_user_question") {
      const questions = array(attention.payload.questions, "questions").map((q) => object(q, "question").question);
      const questionMap = (value: unknown, label: string, validate: (entry: unknown) => void) => {
        for (const [question, entry] of Object.entries(object(value, label))) {
          if (!questions.includes(question)) invalid(label + " must use exact native question text as keys");
          validate(entry);
        }
      };
      if (response.outcome === "accepted") {
        absent(response, ["partial_answers"]);
        questionMap(response.answers, "answers", (entry) => {
          if (typeof entry === "string") return;
          array(entry, "answer labels").forEach((label) => text(label, "answer label"));
        });
        if (response.annotations != null) questionMap(response.annotations, "annotations", (entry) => {
          const annotation = object(entry, "annotation"); optionalText(annotation, "preview"); optionalText(annotation, "notes");
        });
      } else if (response.outcome === "chat_about_this" || response.outcome === "skip_interview") {
        absent(response, ["answers", "annotations"]);
        if (Object.hasOwn(response, "partial_answers")) questionMap(response.partial_answers, "partial_answers", (entry) => { text(entry, "partial answer"); });
      } else if (response.outcome === "cancelled") absent(response, ["answers", "annotations", "partial_answers"]);
      else invalid("invalid question outcome");
    } else if (attention.method === "_x.ai/exit_plan_mode") {
      if (!["approved", "cancelled", "abandoned"].includes(response.outcome as string)) invalid("invalid plan outcome");
      optionalText(response, "feedback");
    } else {
      const standard = attention.method === "elicitation/create";
      if (!standard && attention.method !== "_x.ai/mcp/elicit") invalid("unsupported native attention method");
      const action = response[standard ? "action" : "outcome"];
      if (!["accept", "decline", "cancel"].includes(action as string)) invalid("invalid elicitation action");
      if (action !== "accept" || attention.payload.mode === "url") {
        if (response.content != null) invalid("only accepted forms can carry content");
      } else if (attention.payload.requestedSchema != null) {
        const content = response.content == null ? {} : object(response.content, "form content");
        const before = JSON.stringify(content);
        const result = compileForm(object(attention.payload.requestedSchema, "elicitation schema"))(content);
        if (!result.valid) invalid("elicitation content does not match requested schema: " + result.errorMessage);
        if (JSON.stringify(content) !== before) invalid("elicitation validation must not transform content");
      }
    }
    return snapshot(response);
  });
}
