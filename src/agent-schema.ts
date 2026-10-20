import { z } from "zod";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";

export { PUBLIC_SCHEMA_VERSION } from "./core.js";
const uuidV4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export const AgentIdSchema = z.string().regex(new RegExp(`^agent_${uuidV4}$`));
export const RequestIdSchema = z.string().regex(new RegExp(`^request_${uuidV4}$`));
const nonempty = z.string().min(1).regex(/\S/u, "Must contain non-whitespace text");
export const PromptIdSchema = z.string().min(1).describe("Exact native prompt identifier returned by this collaborator; pass it unchanged, without trimming.");
const model = nonempty.describe("Explicit native session model selection, including during active work; omitted preserves the native choice.");
const effort = nonempty.describe("Explicit native session effort selection, including during active work; omitted preserves the native choice.");
const task = nonempty
  .describe("Self-contained brief: purpose, relevant facts and sources, the result you need, and any limits on files or effects. Grok does not see your conversation. A leading /name may invoke a native command, skill or workflow; use one only when its effects are authorized.");
const absolutePath = z.string().min(1).regex(/^\/[^\0]*$/u)
  .describe("Absolute local path. Runtime admission separately checks canonical filesystem identity, allowed boundaries and file type.");
const cursor = nonempty.describe("Opaque cursor returned by grok_read or grok_wait; pass it unchanged.");
const view = z.enum(["result", "records"])
  .describe("result (default): status, each turn's text and outcome, side answers, attention, files, issues, noteworthy operations and background tasks. records: the full typed record stream. A cursor keeps the view it was created with.");

const date = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return value.slice(0, 4) !== "0000" && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Expected a canonical calendar date");
const domains = z.array(z.string()).max(5);
export const SearchInputSchema = z.strictObject({
  webSearch: z.strictObject({ allowedDomains: domains.nullable().optional(), excludedDomains: domains.nullable().optional() }).nullable().optional(),
  xSearch: z.strictObject({ dateBound: z.strictObject({ fromDate: date.nullable().optional(), toDate: date.nullable().optional() }).nullable().optional() }).nullable().optional(),
}).describe("Exact native per-turn search overrides, not a network firewall or a requirement to search. Omitted engines and semantically empty objects preserve native settings; null on webSearch or xSearch clears that engine's override. Nested null fields mean absence, not clearing an engine. X dates are inclusive fromDate and exclusive toDate at 00:00 UTC, scoped to native keyword/semantic search.");
export const AttachmentSchema = z.strictObject({ path: absolutePath, kind: z.enum(["reference", "image"]) });
const attachments = z.array(AttachmentSchema)
  .describe("Explicit local inputs with required kind: reference supplies a native resource reference; image supplies image content. No path-only or inferred-kind input. A prose path is not an attachment; admission does not prove consumption.");
export const SpawnInputSchema = z.strictObject({
  task,
  cwd: absolutePath.describe("Existing absolute physical directory, with symlinks already resolved, in which to do the work; Git is unnecessary unless worktree is requested. The filesystem root, exact account home and protected agent state are refused."),
  worktree: z.boolean().default(false)
    .describe("Create a native Grok worktree and work in its corresponding subdirectory. Native copy rules include uncommitted work; nothing is applied back automatically. Omitted or false works in cwd. This is file placement, not a sandbox selection."),
  sandbox: nonempty.optional()
    .describe("Exact native sandbox profile name to request. Omitted passes no --sandbox flag: Grok resolves its configuration and requirements, which may permit unrestricted execution. Independent of worktree. A requested name is not proof of applied confinement."),
  attachments: attachments.optional(),
  search: SearchInputSchema.optional(),
  model: model.optional(), effort: effort.optional(),
  key: nonempty.optional().describe("Idempotency key unique to the piece of work. An open holder is returned only for the identical complete original spawn request (worktree omitted=false, attachments omitted=[]; other native omissions stay distinct). Changed input conflicts; unverifiable original input retains the key and admits nothing. Recover a lost response with grok_list by this key or the identical keyed call, never a new key. Use grok_send to change the work."),
}).meta({ examples: [{ task: "Create comparison.docx from the research in this directory, inspect its rendering, and return the document and findings. Leave source files unchanged; do not contact anyone or publish.", cwd: "/workspace/research-notes" }] });
const sendFields = ["task", "attachments", "search", "model", "effort", "prompt_id", "resume"] as const;
type SendActionContract = {
  optional_fields: readonly (typeof sendFields)[number][];
  required_fields: readonly (typeof sendFields)[number][];
  at_least_one?: readonly (typeof sendFields)[number][];
  description: string;
  example: Record<string, unknown>;
};
const exampleAgentId = "agent_12345678-1234-4123-8123-123456789abc";
const examplePromptId = "native-prompt-queued";
/** One owner for action-specific fields, caller guidance and executable public examples. */
export const SEND_ACTION_MATRIX = {
  follow_up: {
    optional_fields: ["attachments", "search", "resume"], required_fields: ["task"],
    description: "Queue new work in the same conversation. It asks for no cancellation, though Grok's follow-up setting may deliver it at once while a turn waits. resume:true reconnects a disconnected collaborator to carry this new work; it never replays earlier input.",
    example: { agent_id: exampleAgentId, action: "follow_up", task: "Compare the new document with your earlier conclusion.", attachments: [{ path: "/workspace/research-notes/update.pdf", kind: "reference" }] },
  },
  steer: {
    optional_fields: ["attachments"], required_fields: ["task"],
    description: "Redirect current work without cancelling it: text and images are inserted at Grok's next safe point, or become a priority turn if none comes. Attachments must be images.",
    example: { agent_id: exampleAgentId, action: "steer", task: "Prioritize the operational risks in the current analysis." },
  },
  send_now: {
    optional_fields: ["attachments", "search"], required_fields: ["task"],
    description: "Submit priority work; Grok may cancel an ordinary running turn for it (an active Goal is steered instead).",
    example: { agent_id: exampleAgentId, action: "send_now", task: "Analyze this additional diagram now.", attachments: [{ path: "/workspace/research-notes/diagram.png", kind: "image" }] },
  },
  side_question: {
    optional_fields: [], required_fields: ["task"],
    description: "Ask beside running work without adding a turn; the answer arrives as this operation's side answer.",
    example: { agent_id: exampleAgentId, action: "side_question", task: "Which assumption is most important to your current conclusion?" },
  },
  edit: {
    optional_fields: [], required_fields: ["task", "prompt_id"],
    description: "Replace the text of the queued prompt prompt_id (see the queue record); image inputs are kept, prompts with file references are refused.",
    example: { agent_id: exampleAgentId, action: "edit", prompt_id: examplePromptId, task: "Compare the same queued inputs, focusing on the deployment decision." },
  },
  configure: {
    optional_fields: ["model", "effort"], required_fields: [], at_least_one: ["model", "effort"],
    description: "Change the session model and/or effort, even during work; the operation records which setting applied.",
    example: { agent_id: exampleAgentId, action: "configure", effort: "<exact native effort ID>" },
  },
} as const satisfies Record<string, SendActionContract>;
export type SendAction = keyof typeof SEND_ACTION_MATRIX;
const sendActions = Object.keys(SEND_ACTION_MATRIX) as [SendAction, ...SendAction[]];
const sendDescription = Object.entries(SEND_ACTION_MATRIX as Record<SendAction, SendActionContract>).map(([action, contract]) => {
  const fields = [...contract.required_fields, ...contract.optional_fields.map(field => `${field}?`)];
  return `- ${action} (${contract.at_least_one ? contract.at_least_one.join(" and/or ") : fields.join(", ")}): ${contract.description}`;
}).join("\n");
export const SendInputSchema = z.strictObject({
  agent_id: AgentIdSchema, task: task.optional(),
  action: z.enum(sendActions).default("follow_up"),
  attachments: attachments.optional(),
  search: SearchInputSchema.optional(),
  model: model.optional(), effort: effort.optional(),
  prompt_id: PromptIdSchema.optional(),
  resume: z.boolean().optional().describe("follow_up only: true reconnects a disconnected collaborator for this new work; earlier input is never replayed. worker_unavailable with admission none means this server cannot start a worker; follow its action."),
}).meta({ examples: Object.values(SEND_ACTION_MATRIX).map(contract => contract.example) });
function validateSend(input: z.infer<typeof SendInputSchema>): void {
  const issues: z.core.$ZodIssue[] = [];
  const contract: SendActionContract = SEND_ACTION_MATRIX[input.action];
  const allowed: readonly string[] = [...contract.optional_fields, ...contract.required_fields];
  for (const field of sendFields) if (Object.hasOwn(input, field) && !allowed.includes(field)) {
    issues.push({ code: "custom", path: [field], message: `${field} is not accepted for ${input.action}` });
  }
  for (const field of contract.required_fields) if (input[field] === undefined) {
    issues.push({ code: "custom", path: [field], message: `${input.action} requires ${field}` });
  }
  if (contract.at_least_one && !contract.at_least_one.some(field => input[field] !== undefined)) {
    issues.push({ code: "custom", path: [], message: `${input.action} requires at least one of ${contract.at_least_one.join(", ")}` });
  }
  if (input.action === "steer") input.attachments?.forEach((attachment, index) => {
    if (attachment.kind !== "image") issues.push({ code: "custom", path: ["attachments", index, "kind"], message: "steer accepts only image attachments" });
  });
  if (issues.length) throw new z.ZodError(issues);
}
const maxChars = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(32_000)
  .describe("Budget for JSON.stringify of the complete public result, including its envelope; default 32000. Large records use explicit page.fragments JSON substrings, never apparent partial native requests. Join one record_id in offset order before interpreting it; fragment_reset discards an obsolete incomplete version. A budget below the compact progress frame returns response_budget_too_small without advancing. Host byte/token limits may still shorten output: retry from the previous cursor with a smaller budget. text_file supplies root text only." );
export const WaitInputSchema = z.strictObject({
  targets: z.array(z.strictObject({ agent_id: AgentIdSchema, cursor: cursor.optional() })).min(1),
  until: z.enum(["settled", "change"]).default("settled")
    .describe("settled (default): return when a target stops working, needs an answer or becomes unavailable, with something new since its cursor. change: return on any meaningful update."),
  timeout_ms: z.number().int().min(0).max(600_000).default(120_000)
    .describe("How long to wait. A timeout returns what is available and never stops the work."),
  view: view.optional(),
  max_chars: maxChars.describe("Budget for JSON.stringify of the entire aggregate wait result; default 32000. agents contains only delivered pages, including the triggering target; excluded targets keep their complete input cursor. Rotate delivered targets behind excluded ones for caller-side progress. Large records use fragments as in grok_read; no oversized exception. If the host shortens output, retry from previous cursors with a smaller budget."),
}).meta({ examples: [{ targets: [{ agent_id: exampleAgentId }], timeout_ms: 300_000 }] });
export const ReadInputSchema = z.strictObject({
  agent_id: AgentIdSchema,
  cursor: cursor.optional(),
  view: view.optional(),
  prompt_id: PromptIdSchema.optional().describe("Restrict reading to records of this native prompt; the filter stays in the cursor."),
  max_chars: maxChars,
}).meta({ examples: [{ agent_id: exampleAgentId }, { agent_id: exampleAgentId, view: "records" }] });
export const ListInputSchema = z.strictObject({
  include_closed: z.boolean().default(false).describe("Also list closed collaborators, whose output stays readable."),
  key: nonempty.optional().describe("Only collaborators spawned with this key."),
  limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(20),
  cursor: nonempty.optional().describe("page.next_cursor from the previous grok_list call with the same filters."),
}).meta({ examples: [{}, { include_closed: true, limit: 50 }] });
const questionAnswers = z.record(z.string(), z.union([z.string(), z.array(z.string())]));
const annotations = z.record(z.string(), z.looseObject({
  preview: z.string().nullable().optional(), notes: z.string().nullable().optional(),
})).nullable().optional();
const mcpContent = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]));
export const ResponseSchema = z.union([
  z.looseObject({ outcome: z.union([
    z.looseObject({ outcome: z.literal("selected"), optionId: z.string().min(1) }),
    z.looseObject({ outcome: z.literal("cancelled") }),
  ]) }),
  z.looseObject({ outcome: z.literal("accepted"), answers: questionAnswers, annotations }),
  z.looseObject({ outcome: z.enum(["chat_about_this", "skip_interview"]), partial_answers: z.record(z.string(), z.string()).optional() }),
  z.looseObject({ outcome: z.enum(["approved", "cancelled", "abandoned"]), feedback: z.string().nullable().optional() }),
  z.looseObject({ outcome: z.enum(["accept", "decline", "cancel"]), content: z.json().optional() }),
  z.looseObject({ action: z.enum(["accept", "decline", "cancel"]), content: mcpContent.nullable().optional() }),
]).describe("Native response object for the pending request's exact method, preserved without wrapper tags. Permission uses nested outcome; questions/plans and xAI elicitation use outcome; MCP elicitation uses action. The pending native request validates its applicable branch and offered values.");
export const RespondInputSchema = z.strictObject({ agent_id: AgentIdSchema, request_id: RequestIdSchema, response: ResponseSchema })
  .meta({ examples: [{ agent_id: exampleAgentId, request_id: "request_12345678-1234-4123-8123-123456789abc", response: { outcome: { outcome: "selected", optionId: "actual_authorized_option" } } }] });
export const InterruptInputSchema = z.strictObject({ agent_id: AgentIdSchema, prompt_id: PromptIdSchema.optional() })
  .meta({ examples: [{ agent_id: exampleAgentId }, { agent_id: exampleAgentId, prompt_id: examplePromptId }] });
export const CloseInputSchema = z.strictObject({ agent_id: AgentIdSchema })
  .meta({ examples: [{ agent_id: exampleAgentId }] });

export const ToolInputSchemas = {
  grok_spawn: SpawnInputSchema,
  grok_send: SendInputSchema,
  grok_wait: WaitInputSchema,
  grok_read: ReadInputSchema,
  grok_list: ListInputSchema,
  grok_respond: RespondInputSchema,
  grok_interrupt: InterruptInputSchema,
  grok_close: CloseInputSchema,
} as const;
export type ToolName = keyof typeof ToolInputSchemas;
export type ToolInput<Name extends ToolName> = z.infer<(typeof ToolInputSchemas)[Name]>;
export type SpawnInput = ToolInput<"grok_spawn">;
export type SendInput = ToolInput<"grok_send">;
export type WaitInput = ToolInput<"grok_wait">;
export type ReadInput = ToolInput<"grok_read">;
export type ListInput = ToolInput<"grok_list">;
export type RespondInput = ToolInput<"grok_respond">;
export type InterruptInput = ToolInput<"grok_interrupt">;
export type CloseInput = ToolInput<"grok_close">;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type SearchInput = z.infer<typeof SearchInputSchema>;

/** Retry identity is the original validated request, not the session's current configuration. */
export function normalizedSpawnRequest(input: unknown): Omit<SpawnInput, "key" | "attachments"> & { attachments: Attachment[] } {
  const { key: _key, ...request } = parseToolInput("grok_spawn", input);
  return { ...request, attachments: request.attachments ?? [] };
}

const descriptions: Record<ToolName, string> = {
  grok_spawn: "Delegate a self-contained task in cwd to a detached Grok Build collaborator and return at once; keep working while it runs. Grok does not see your conversation: include result, context, sources and file/effect limits. Non-Git directories are normal. Optional worktree:true asks Grok for an isolated tree including native-supported uncommitted context; you inspect and integrate. Optional sandbox requests an exact native profile; omission leaves native defaults in control, with no implicit readonly profile. A brief/worktree is not a security sandbox. Attachments pass exact paths with kind reference or image. A key reuses its holder only for the identical complete original request, normalizing omitted worktree=false and attachments=[]; changed input conflicts, unverifiable input retains the key, and neither launches. Use grok_send to change work. New admissions return agent_id/operation_id; existing returns agent_id/summary, not the answer: wait, inspect actual artifacts and follow up before close. Startup/provisioning diagnostics and returned directories remain readable; never replay uncertain creation or select a looser profile automatically. worker_unavailable with admission none means this server cannot start a worker: follow its action, usually a new session.",
  grok_send: `Act on an existing collaborator. action defaults to follow_up; each action accepts only its own fields:\n${sendDescription}\nReturns the admitted operation_id; read its effect and the resulting turns with grok_wait.`,
  grok_wait: "Wait for collaborators. settled (default) returns once a target stops working, needs attention or becomes unavailable with something new; change returns on any meaningful update. Timeout stops nothing. agents contains only pages delivered within the complete JSON max_chars budget, including the triggering target. Excluded targets keep their entire input cursor; rotate delivered targets behind them. result (default) groups turns/text/text_file, side_answers, attention, files, issues, failed/not-sent/unknown operations, native queue-removal outcomes and background tasks; records keeps the full typed stream. Large records use fragments as in grok_read. Drain has_more with read, then retain each delivered cursor. text_file is complete root text only. Idle means queue observed empty; ready means no work running but queue unknown. Neither proves quality, final files or background completion.",
  grok_read: "Read retained output passively in result or records view. Omit cursor to start; pass it unchanged to continue while has_more. Its view/prompt_id stay fixed; omit cursor to change them. records adds raw queue, options, capabilities, all operations and resolved attention. max_chars bounds JSON.stringify of the entire public response, not bytes/tokens. Large structured records appear in fragments {record_id,record_type,offset,json,complete}: concatenate exact substrings of one record_id before interpreting or answering. fragment_reset discards an incomplete obsolete version; replay continues without skipping intervening updates. Fragment frames omit the large summary. Too-small budgets return response_budget_too_small without cursor progress. If a host shortens output, retry from the previous cursor with a smaller budget. Reading never starts, resumes, approves or changes work.",
  grok_list: "List collaborators newest first: open ones by default, closed ones too with include_closed. key narrows to collaborators spawned with that key. Use it to recover an agent_id, then grok_wait or grok_read for output. While page.has_more, pass page.next_cursor with the same filters.",
  grok_respond: "Answer a pending request from a collaborator in status attention: pass its request_id and the response object for its method, as shown in the attention record. session/request_permission: {outcome: {outcome: \"selected\", optionId}} with an offered optionId, or {outcome: {outcome: \"cancelled\"}}. _x.ai/ask_user_question: {outcome: \"accepted\", answers: {<exact question text>: answer or [answers]}, annotations?}, {outcome: \"chat_about_this\" or \"skip_interview\", partial_answers?} or {outcome: \"cancelled\"}. _x.ai/exit_plan_mode: {outcome: \"approved\" (implement), \"cancelled\" (revise the plan) or \"abandoned\" (leave planning), feedback?}. _x.ai/mcp/elicit: {outcome: accept, decline or cancel, content?}; elicitation/create: {action: accept, decline or cancel, content?}. Decide within the authority you were given and ask your user only for a decision that is theirs. An invalid response leaves the request pending; a submitted answer is not sent again.",
  grok_interrupt: "Stop a collaborator's current turn, like Ctrl-C; queued prompts stay queued. With prompt_id, instead remove that exact queued prompt if Grok allows it. Read the later native operation/queue outcome: removal can mean combination or steering, not cancellation of a turn or its pending attention. Admission alone proves neither removal nor cancellation.",
  grok_close: "Close a collaborator you no longer need, cancelling any running work; read what you need first. Closing deletes nothing: retained output, the native session and any worktree stay, and no change is applied to your checkout. A spawn key is released on close.",
};
export const toolDefinitions = (Object.keys(ToolInputSchemas) as ToolName[]).map((name) => ({
  name, description: descriptions[name], inputSchema: ToolInputSchemas[name],
}));

export function parseToolInput<Name extends ToolName>(name: Name, input: unknown): ToolInput<Name> {
  if (!Object.prototype.hasOwnProperty.call(ToolInputSchemas, name)) throw new Error(`Unknown Grok tool: ${String(name)}`);
  const parsed = ToolInputSchemas[name].parse(input);
  if (name === "grok_send") validateSend(parsed as SendInput);
  const issues: z.core.$ZodIssue[] = [];
  if (name === "grok_spawn" || name === "grok_send") {
    const search = (parsed as SpawnInput | SendInput).search;
    if (search?.webSearch?.allowedDomains?.length && search.webSearch.excludedDomains?.length) {
      issues.push({ code: "custom", path: ["search", "webSearch"], message: "Nonempty allow and exclude lists cannot be combined" });
    }
    const dates = search?.xSearch?.dateBound;
    if (dates?.fromDate != null && dates.toDate != null && dates.fromDate > dates.toDate) {
      issues.push({ code: "custom", path: ["search", "xSearch", "dateBound"], message: "fromDate must be on or before toDate" });
    }
  }
  if (name === "grok_wait") {
    const seen = new Set<string>();
    (parsed as WaitInput).targets.forEach((target, index) => {
      if (seen.has(target.agent_id)) issues.push({ code: "custom", path: ["targets", index, "agent_id"], message: "Wait targets must name distinct agents" });
      seen.add(target.agent_id);
    });
  }
  if (issues.length) throw new z.ZodError(issues);
  return parsed as ToolInput<Name>;
}

/** Identical conversion and options to the ordinary MCP SDK tool registry. */
export function publicInputSchema(name: ToolName) {
  return toJsonSchemaCompat(ToolInputSchemas[name], { strictUnions: true, pipeStrategy: "input" });
}
