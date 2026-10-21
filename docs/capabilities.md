# Public capabilities

grokpair **2.3.2** · public schema **3** · runtime-v2 ·
SQLite format 1 · cursors `gp1.`

Version 2.3.2 refines documentation, caller guidance and plugin presentation
without changing runtime behavior or public contracts from 2.3.1.
[RELEASE](../RELEASE.md) separates source qualification from installed and
useful fresh-caller acceptance; those installed observations are specific
to 2.3.1. The repository's
[Git tags](https://github.com/Tiziano-AI/grokpair/tags) identify published
source; the shared [catalog](https://github.com/Tiziano-AI/plugins) selects
its offered revision.

This is the public contract: the eight tools, what each accepts and returns,
how output is read and continued, and the command line that mirrors them. The
tool descriptions and input schemas are generated from `src/agent-schema.ts`
into `plugin/schemas/grokpair-tools.schema.json` (also printed by
`grokpair schema`); this document explains them and has to agree with them.
The [operating skill](../plugin/skills/grokpair/SKILL.md) teaches the ordinary
collaboration cycle. Grok keeps its own identity, home, configuration, model
and effort defaults; the caller keeps acceptance, integration and every effect
beyond the collaboration itself.

## Entry points

Every surface calls the same service and returns the same JSON object.

| Surface | How a tool is named | Notes |
| --- | --- | --- |
| MCP, any host | `grok_spawn` … `grok_close` on the server `grokpair` | Started as `grokpair mcp` over stdio. |
| Claude Code plugin | `mcp__plugin_grokpair_grokpair__grok_spawn` … | Claude Code prefixes plugin tools with the plugin and server names. |
| Command line | `grokpair spawn` … `grokpair close` | Mirrors the tools one to one; see [Command line](#command-line). |

The tools are `grok_spawn`, `grok_send`, `grok_wait`, `grok_read`,
`grok_list`, `grok_respond`, `grok_interrupt` and `grok_close`. The server
publishes no server-wide instructions; each tool description carries its own
use and recovery information.

## Results and errors

Every call returns one JSON object with `schema_version: "3"` and a
`call_status`. Over MCP it is a single text content block, with no
`structuredContent` or output schema, and `isError` is true exactly when
`call_status` is `error`. On the command line it is one line on stdout.

| call_status | Returned by | Meaning |
| --- | --- | --- |
| `ok` | grok_read, grok_list | The read or listing succeeded. |
| `admitted` | grok_spawn, grok_send, grok_respond, grok_interrupt, grok_close | An operation was admitted. The result carries `agent_id`, `operation_id` and the collaborator summary as `agent`; it is a receipt, not output. |
| `existing` | grok_spawn with `key` | An open collaborator holds the key for the same normalized initial request. The result carries its `agent_id` and summary and no `operation_id`; nothing was started. Collect its output with grok_wait by `agent_id`. |
| `settled` | grok_wait with `until: "settled"` | At least one target settled with something new since its cursor. |
| `changed` | grok_wait with `until: "change"` | At least one target has something new since its cursor. |
| `timeout` | grok_wait | The deadline passed first; the delivered target pages carry what is available within the combined budget. |
| `error` | any tool | The call failed; `error` explains it. |

An error has the shape `{code, message, action, details, admission}`, plus
`agent_id` and `operation_id` when they are known. `admission` says whether
the call changed anything:

- `none`: nothing was admitted and `operation_id` is absent. Correct the input
  or the precondition named in `action` and call again.
- `confirmed`: the operation was recorded and `operation_id` is present. Read
  it before doing anything else; do not submit the same work again.
- `unknown`: admission may have happened and `operation_id` is present. Read
  the collaborator before any further effect.

Over MCP, a structurally invalid input (an unknown field, a wrong type, a
missing required field) is rejected by the MCP layer with a plain-text input
validation error instead of this envelope. Inputs that are structurally valid
but break an action's own rules, such as `prompt_id` on a follow-up, return the
envelope with `invalid_input` and `admission: "none"`. On the command line every
input error returns the envelope.

| Code | When |
| --- | --- |
| `invalid_input` | The input breaks a schema or action rule; nothing was admitted. |
| `invalid_cursor` | A cursor is malformed, belongs to another collaborator, view or prompt filter, or is ahead of retained state; a list cursor was issued for other filters. |
| `response_budget_too_small` | The serialized response cannot fit a minimal progress frame. No read position advances; repeat from the same input cursor with a sufficient `max_chars`. The compact error itself is not constrained to an impossibly small requested budget. |
| `workspace_not_admitted` | `cwd` or a derived Git root falls outside the workspace boundaries. |
| `spawn_key_conflict` | A collaborator holds the key for a different normalized initial request; nothing new was launched. Read the holder and use the appropriate send action to change its work, or choose a distinct key for separately authorized work. |
| `attachment_not_admitted` | An attachment path, kind or content cannot be admitted; the message names its index. |
| `collaborator_not_found` | No collaborator with this `agent_id` exists in the store in use. |
| `collaborator_closed`, `collaborator_closing` | The collaborator is closed, or a close is already pending. |
| `collaborator_disconnected` | The collaborator is not observably connected; read it, or resume it with a new follow-up. |
| `attention_not_pending`, `attention_already_responded` | The request is resolved or expired, or an answer to it was already admitted. |
| `prompt_not_found` | A `prompt_id` filter names a prompt this collaborator never observed. |
| `prompt_not_queued`, `prompt_running`, `queue_not_observed`, `queue_version_unknown` | A queued edit or removal does not name an exact eligible queued prompt. |
| `runtime_contract_mismatch` | A collaborator database belongs to another runtime contract; nothing was read or changed. |
| `worker_unavailable` | This server cannot start a worker for spawn or resume: its own package file is gone, or its Node executable is gone and its `PATH` has no `node`. Nothing was admitted; existing collaborators stay readable and closable. Follow `action`: a new session when the package is gone; Node on the host's `PATH`, then a new session, when Node is missing. |
| `call_failed` | Another failure, such as a resume whose predecessor is not proved absent. |
| `nested_collaborator`, `invalid_command` | Command line only: called beneath a collaborator, or an unknown command. |

Some failures happen after admission and appear as the `error` of a failed or
unknown operation rather than as a call error, for example
`search_unavailable`, `native_option_unavailable`, `resume_unavailable`,
`session_identity_unknown` and `worker_not_launched`. Native creation can
report `native_worktree_failed` (including its observed exit and stderr),
`native_worktree_result_unknown` (creation may have happened but no directory
was returned), or `native_worktree_not_admitted` (the returned directory failed
validation). Read retained provisioning before any new creation. A failed ACP
initialization reports `native_startup_failed` with startup stderr, whether it
was truncated, and the observed exit when available. Successful initialization
discards that diagnostic capture.

## Identity

`agent_id` (`agent_<uuid>`) identifies a collaborator, `operation_id`
(`operation_<uuid>`) one admitted action and `request_id` (`request_<uuid>`) one
native request waiting for an answer. Native session, prompt, message, tool
call and task identifiers are kept exactly as observed, untrimmed and
untruncated. An operation ID is not a native prompt ID: a turn links to the
operation that sent it through `operation_id`, and an operation names its
native prompt in `native_prompt_id`.

## grok_spawn

| Field | Meaning |
| --- | --- |
| `task` | Required. A nonblank, self-contained brief: purpose, relevant facts and sources, the result needed, and any limits on files or effects. Grok does not see the caller's conversation. The text is passed unchanged. |
| `cwd` | Required. The existing absolute canonical directory the work is about. No default is supplied. |
| `worktree` | Optional boolean, default false. True requests native worktree creation before the collaborator starts; false or omission executes in `cwd`. |
| `sandbox` | Optional nonblank string, passed as the exact native profile name. Omission passes no sandbox flag and preserves Grok's native selection. |
| `attachments` | Optional list of `{path, kind}` with kind `reference` or `image`; see [Attachments](#attachments-and-output-custody). |
| `search` | Optional native per-turn search overrides; see [Search](#search-and-native-jobs). |
| `model`, `effort` | Optional exact native selections for the new session; omitted, Grok's own defaults apply. |
| `key` | Optional idempotency key chosen by the caller. |

`cwd` must exist and be absolute, normalized, canonical and free of symlinks
in every component. The filesystem root and the exact account home are
refused, and so is anything inside an agent home: the Codex home
(`~/.codex` and `CODEX_HOME`), the Claude Code home (`~/.claude` and
`CLAUDE_CONFIG_DIR`), the Grok home (`~/.grok` and `GROK_HOME`), the Pi home
(`~/.pi` and `PI_CODING_AGENT_DIR`) and the grokpair store
(`~/.local/state/grokpair` and `GROKPAIR_HOME`). Each home is protected at its
default location and, when its variable is set in the server's environment,
there too, together with existing aliases.

Ordinary work needs no Git and executes in `cwd`. A directory is working
context, not authority to change everything in it. The task supplies the
file and effect boundaries.

Worktree placement and sandbox selection are independent. Native `read-only`,
`workspace` and custom names are profile names, not bridge modes. A supplied
name is preserved exactly; an empty or whitespace-only name is rejected
before admission. When `sandbox` is omitted, no `--sandbox` flag is passed:
Grok resolves its requirements, environment and configuration, including a
possible `off` profile. A requested name is not proof of applied enforcement.
Native tool permissions remain separate, and grokpair adds no sandbox. Native
custom profile definitions resolve from Grok's home and actual execution
directory; isolation can change their availability or meaning. A refusal is
never retried with a different profile or directory.

`worktree: true` needs a non-bare Git repository; Grok's native utility owns
the remaining creation prerequisites.
The source root may not contain the account home or overlap a protected home.
The worker runs `grok --cwd <source> [--sandbox <name>] worktree create`,
retains its returned directory, validates it, then starts `grok --cwd
<execution> [--sandbox <name>] agent --no-leader stdio` there and uses that
same directory for ACP session creation. Provisioning receives the same
optional profile selection; its source-directory grants can differ from the
later process's execution-directory grants.

Native defaults seed from HEAD plus uncommitted work under native copy rules.
This is not a promise to copy every ignored, untracked or generated file, nor
of a particular Git linkage, branch form or absence of source/Git metadata
effects. The bridge copies no missing dependencies or configuration. The
returned canonical directory must belong to the observed native worktree and
preserve the source cwd's repository-relative suffix. A native fallback to the
worktree root when that suffix is missing is rejected before ACP launch; a
non-Git source fails rather than falling back to its original directory. A
verified native creation may be beneath a protected native home through this
narrow route, not through arbitrary caller-supplied cwd admission.

Grok owns worktree identity, source-copy semantics and retention. The bridge
records provisioning intent, process identity, returned directory and outcome;
a returned directory survives in that record even if validation or ACP startup
fails. An unknown provisioning result is not permission to create again.
grokpair creates no worktree copy in its store, calls no native apply, remove
or GC, and promises no indefinite path retention. The caller inspects and
integrates useful work.

Grok receives the task as its own text block, followed by a short grokpair
block carrying the brief's file and effect boundaries and, for isolation, the
source-to-execution mapping. Absolute source paths in the brief do not grant
edits outside the execution tree. Ordinary work has no injected read-only
rule or output-staging requirement. Attachments follow the guidance.

The public schema has no `workspace` field or compatibility alias. Schema 3
retains runtime-v2, SQLite format 1 and existing cursors; it changes read/wait
delivery and keyed retry matching without migrating stores or replaying work.

Workspace and attachments are checked before anything is recorded, so their
errors carry `admission: "none"`. So is the server's ability to start a
worker: its own package file must exist, and so must a Node executable, which
is the server's own while that exists and otherwise `node` on an absolute
entry of the server's `PATH`. When either is missing, typically because an
update replaced the plugin or Node under a running server, spawn returns
`worker_unavailable` and creates no collaborator or key. A successful spawn
returns `admitted` with status `starting`; the answer arrives through
grok_wait. The spawn's own operation has kind `follow_up`. A worker that
cannot be launched after this check, or that exits before claiming its launch,
fences the launch at once: the operation settles `not_sent` with
`worker_not_launched`, and the collaborator reads `disconnected` and can be
resumed.

**Keyed spawn.** With `key`, spawning is idempotent across callers and hosts
that share the store. Spawn observes the key's holder outside the registry's
write lock, and a claim commits only if the key still names the holder that
was observed, so callers racing on one key admit one collaborator. While the
holder is not closed, the full normalized request must match the immutable
input of its initial spawn operation. The comparison excludes `key`, treats
omitted `worktree` as false and omitted `attachments` as `[]`, and ignores
object property order. Task whitespace and Unicode, attachment order, paths
and kinds, cwd, sandbox, model, effort and search remain exact. Omission of a
native default differs from choosing it explicitly; omitted search differs
from `{}`. Attachment references are not reread or byte-certified for retry
identity.

A match returns `existing` with the holder's `agent_id` and summary and no
`operation_id`, without dispatch. A different request returns
`spawn_key_conflict`; changing work belongs in `grok_send`, not in a changed
spawn masquerading as a retry. An unreadable or missing original request,
including a missing collaborator directory, returns an explicit error and
retains the key. Current configuration and a later resume do not redefine
the original request. Disconnection, startup failure and uncertain effects
do not release it. Only confirmed closure releases a held key for a new
spawn; this is not perpetual exactly-once protection after close. Keys are
matched exactly; grok_list can filter by key.

## grok_send

`agent_id` is required and `action` defaults to `follow_up`. Each action
accepts only its own fields; any other field, or a missing required one, is
rejected before admission.

| Action | Required | Optional | Effect |
| --- | --- | --- | --- |
| `follow_up` | task | attachments, search, resume | Queue new work in the same conversation. It asks for no cancellation. |
| `steer` | task | image attachments only | Redirect current work without cancelling it: inserted at Grok's next safe point, or a priority turn if none comes. |
| `send_now` | task | attachments, search | Priority work; Grok may cancel an ordinary running turn for it. |
| `side_question` | task | — | Ask beside running work without adding a turn; the answer is this operation's side answer. |
| `edit` | task, prompt_id | — | Replace the text of an exact queued prompt. |
| `configure` | model and/or effort | — | Change the session model or effort without a task, even during work. |

**Follow-up** asks for no cancellation, but it is not a promise that the
current turn continues untouched. With Grok's native `ui.follow_up_behavior`
set to steer, a turn that is running, blocked in a wait, and has no held user
work queued can trigger native auto-send-now. That decision belongs to Grok.
Use `steer` when the intervention must not cancel the current turn.

**Steer** carries text and images through Grok's native interjection. It
never requests cancellation.

**Send-now** is not unconditional preemption. With an active native Goal (Grok's
ongoing Goal work rather than a single prompt), ordinary text steers the Goal
instead of replacing it; an unaccepted front entry is not cancelled; FIFO order
stays native. Admission does not establish insertion, queue consumption or
cancellation.

**Side question** answers are a separate model contribution kept apart from
root text. They are not authoritative progress reports: establish progress
from turns and relevant files.

**Edit** needs a `prompt_id` that is currently in the observed native queue
(the queue record in the records view gives ids and versions) and that this
collaborator submitted. It accepts no replacement attachments. Native edit
collapses text blocks, so grokpair sends the new task, two newlines and the
same guidance block ordinary prompts carry. A prompt whose inputs were images
only keeps those images unchanged without rereading them; a prompt with a
reference, mixed or unknown inputs is refused and stays intact. The
caller can add new work with a follow-up. To replace the queued prompt's
inputs, first request removal of that exact prompt with `grok_interrupt` and
observe the operation outcome and queue, then send the replacement. Admission
is not removal; if the prompt has started, inspect what ran before deciding
what new work is needed. The bridge never removes and resubmits automatically.

**Configure** accepts no task, attachments, search, prompt_id or resume. It
applies the model first and then the effort against the options that result;
the native setter is authoritative. Read `native_options` (records view) for
the exact supported IDs; defaults need no discovery prompt. The operation's
`effects.configuration` records each field with status `not_sent`,
`submitted`, `applied`, `rejected` or `unknown`, and an error when one is
available. A later effort failure does not roll back an applied model, and a
configuration change in flight does not promise to retarget inference already
running.

Prompt-bearing operations record `effects.prompt` with status `not_sent`,
`submitted`, `completed`, `rejected` or `unknown`; `not_sent` can coexist with
an applied configuration change made by the same operation. Steer and side
questions record `effects.native_request` in the same vocabulary.

**Resume.** `resume: true` belongs to `follow_up` only. It reconnects a
disconnected collaborator to carry this new work and never replays earlier
input. It is admitted only when the previous worker and its Grok process are
proved absent by exact process identity, or when the previous launch was
reserved and can no longer be claimed: its recorded worker or, when none was
recorded, the process that reserved it is proved gone, or the launch was
fenced. A worker whose identity cannot be observed is not absent, and a native
session whose identity was never recorded cannot be resumed. The resumed worker
reopens the known native session when Grok offers session resume. Before
relaunching, operations left unfinished by the predecessor settle as `not_sent`
or `outcome_unknown`, running turns become `unknown` and get their [text
files](#turn-text-files), pending requests expire with reason `worker_absent`,
and the queue becomes unknown.

Resume checks, before admission, that this server can start a worker, as
spawn does, and otherwise returns `worker_unavailable`.

Resume reuses the admitted execution directory and original sandbox argument;
omission stays omitted. Native configuration is resolved anew for the resumed
process, so this does not pin the previous effective profile. Missing native
context is an actionable failure, not permission to create another worktree
or execute in the source directory. A different requested sandbox selection
requires a new collaborator.

## Collaborator summary

Admission receipts, `existing` results and grok_list return a compact summary;
read and wait pages start with the same fields.

| Field | Meaning |
| --- | --- |
| `agent_id`, `cwd`, `worktree`, `created_at` | Identity and admission facts; `cwd` is always the caller's input directory. |
| `execution_cwd` | Directory supplied to an observed provider process; null until that observation. Not a planned location. |
| `worktree_root` | Validated native worktree root, or null. |
| `sandbox_argument` | Exact requested native profile name, or null for no flag. |
| `sandbox_observation` | `{status: "unavailable", reason: "Native ACP does not report the resolved sandbox or its enforcement."}`. A launch selection is not an enforcement observation. |
| `provisioning` | When native worktree creation was requested: its status (`starting`, `running`, `completed`, `failed`, `outcome_unknown` or `not_launched`), and `returned_cwd`, exit or failure details when observed. The validated root is the separate `worktree_root` field. |
| `status` | Derived state; see below. |
| `counts` | `pending_operations`, `queued_prompts`, `pending_attention`, `unknown_operations`. |
| `queue_observation` | `{status: "observed"}` or `{status: "unknown", reason}`. |
| `key` | The spawn key, when one was given. |
| `native_session_id` | Once the native session is known. |

| Status | Meaning |
| --- | --- |
| `starting` | A launch is reserved and may still be claimed, because its recorded worker or, when none was recorded, the process that reserved it (the MCP server or the command line) is not proved gone; or the worker is opening the native session. |
| `working` | A turn is running, prompts are queued, an operation still represents activity (see below), or a close is stopping it. |
| `attention` | A native request is waiting for the caller. |
| `idle` | Connected, the native queue is observed and nothing is running. |
| `ready` | Connected with nothing known to be running, but no native queue observation proves it idle. |
| `disconnected` | The worker or Grok process is proved gone, the worker could not be launched or exited before claiming its launch, or a reserved launch can no longer be claimed. |
| `closed` | Closed; output stays readable. |
| `unavailable` | Process identity cannot be observed, or the collaborator's state cannot be read. |

Without a native queue observation, `queued_prompts` is `null`, not zero, and
a connected collaborator is `ready` rather than certified `idle`. Idle is not
background quiescence, finished files or acceptance.

`pending_operations` counts all admitted or started bridge operations. A
`follow_up` or `send_now` whose exact native prompt is already completed or
cancelled no longer represents activity, even if its bridge operation has
not settled yet. A summary can therefore be `idle` or `ready` with a nonzero
pending count, and a settled wait can return that snapshot. The native turn
and the operation receipt settle separately.

Native `removedFromQueue` completes the correlated operation, not a cancelled
turn. It can mean explicit removal, prompt combination or interjection; it
does not identify a receiving turn or prove which work ran. That exact prompt
no longer counts as autonomous queued or running activity, even if the latest
queue observation or an inferred running notice still names it. Queue edit
and removal use the same effective eligibility. No attribution is inferred
from matching text. Retained legacy `removed_from_queue` turn records do not
establish authoritative cancellation.

An unreadable collaborator is summarized with its `agent_id`, null admission and execution
fields, `status: "unavailable"` and the error, with no counts, never with
invented zeros.

## Reading output

grok_read and grok_wait return pages of a collaborator's retained output in
one of two views, continued by an opaque cursor.

### Views

`view: "result"` (the default) groups a page by what the caller does with it.
After the summary fields, a page holds only the lists that have entries:

| Field | Contains |
| --- | --- |
| `turns` | One entry per native prompt on this page, in order of first appearance: `prompt_id`, `operation_id` of the operation that sent it (when grokpair sent it), `status` (`running`, `completed`, `cancelled` or `unknown`), `stop_reason` when known, the page's `text`, and `text_file` when a current [text file](#turn-text-files) is available. |
| `side_answers` | `{operation_id, text}` for side questions. |
| `attention` | Native requests that are pending, expired or rejected; resolved ones are omitted. |
| `files` | Native file references. |
| `issues` | Diagnostics. |
| `operations` | Operations that failed, were not sent or have unknown outcomes, plus completed operations with native `removedFromQueue` outcomes. |
| `background` | Native background tasks. |

Other completed operations, and operations still admitted or started,
appear only in the records view: a completed prompt delivers through its turn,
a completed side question through its side answer, and a completed control
through later turn, queue or attention records. The result view also leaves
out the native queue, `native_options`, `native_capabilities` and
elicitation-completion notices. Turn text joins the page's text blocks in
order, with a blank line where a new native text block starts; a page that
resumes a block mid-way starts without one. Concatenate the text of the same
`prompt_id`, and of the same side-answer `operation_id`, across pages in order.
When a page holds text for a prompt but not its turn record, the turn's
current status is filled in.

`view: "records"` returns the full typed stream as `records`, each with a
`type`:

| Record | Meaning |
| --- | --- |
| `content` | Authentic root text: `prompt_id`, `block_index`, `text`, and `native_message_id` when the native chunk supplied one. |
| `operation` | An admitted action: `operation_id`, `kind`, `status`, timestamps, and when available `native_prompt_id`, `effects`, `result` and `error`. |
| `side_answer` | Operation-keyed auxiliary text, never merged into root text. |
| `turn` | Native prompt state: `prompt_id`, `status`, `source`, `stop_reason` when known, and `text_file` when a current [text file](#turn-text-files) is available. |
| `attention` | Exact native `method`, complete `payload`, `request_id`, and status `pending`, `resolved`, `expired` or `rejected`. |
| `file` | A structured native path or URI with its metadata: an input, a tool location or an output. |
| `background` | A real native `task_id` with `observations.backgrounded` and `observations.completed`, each keeping the native method and full payload, which carries the tool-call identity when Grok supplies it. An event without a task ID is kept with `correlation: "unknown"` and an issue. |
| `elicitation_completion` | A native completion notice with method and full payload; not proof of authentication. |
| `issue` | A diagnostic with its relevant details and native prompt association when supplied. |
| `queue` | The native queue snapshot: entries with exact id, version, owner, lastEditor, text and combinedTexts, and the running prompt, when supplied. |
| `native_options` | The current native model and effort choices. |
| `native_capabilities` | The initialize evidence: `protocol_version`, optional `agent_info` (including null) and the exact optional `capabilities`, `_meta` included. |

Operation kinds are `follow_up` (including a spawn's initial prompt and a
resume), `steer`, `send_now`, `side_question`, `edit`, `configure`, `respond`,
`interrupt` and `close`. Operation status is `admitted`, `started`,
`completed`, `failed`, `not_sent` or `outcome_unknown`. A successful read can
show an older operation that failed or whose outcome is unknown. Records keep
their identity: a changed latest-value record (an operation, a turn, the
queue, options, a file, a background task) replaces its earlier value rather
than adding a copy, so keep earlier values locally and replace them by
identity. Text pieces concatenate within their block; JSON fragments described
below concatenate only within their exact `record_id` and offsets.

Native completion, successful delivery of text and acceptable work are
different facts. `has_more: false` means the available records are drained,
not that the work is finished.

### Pages

`max_chars` bounds the full public JSON text: `JSON.stringify(result).length`
counts UTF-16 code units, including the tool envelope, header, turn grouping,
cursors and JSON escaping. It is a positive integer defaulting to 32,000,
with no policy maximum. It is not a byte or token budget. A wait fits all
delivered pages inside that one combined limit, not equal per-target shares.
Text splits without loss or separation of valid surrogate pairs; records
omitted by a view do not consume its budget. `has_more` is true while more
records are available now.

A retained record that cannot fit normally is delivered through `fragments`,
not an oversized whole-record exception. A fragment page carries just
`agent_id`, `status`, `cursor`, `has_more` and `fragments`; it does not repeat
the session summary. `fragment_reset` is also present when a partially read
version was replaced. Each fragment entry has:

| Field | Meaning |
| --- | --- |
| `record_id` | The exact retained record version, pinned by existing sequence/change coordinates. Treat it as opaque. |
| `record_type` | The retained record's type, such as `attention` or `operation`. |
| `offset` | The starting UTF-16 offset in that record's JSON serialization. |
| `json` | This portion of the exact public retained record's JSON text, including its `type`; it is not necessarily a complete JSON document. |
| `complete` | True only for the final fragment of that version. |

Continue with the same opaque page cursor. Concatenate contiguous `json`
pieces of one `record_id` in offset order, then parse only when `complete` is
true. Do not treat an incomplete payload as a native attention object or act
on partly delivered choices. If the record changes between pages, the page's
`fragment_reset` names the old incomplete `record_id`; discard that version.
Reading resumes from the checkpoint before it, preserving intervening
changes. The replacement can arrive in its ordinary view shape or as
fragments at offset 0 with a new `record_id`; never combine it with the old
pieces. Earlier superseded versions are not archived.
Fragmenting is read-only: it creates no export, read receipt or extra store.
The original payload remains in the database across server restart and close;
close or expiry can end answerability without removing that payload.

If even a minimal continuation frame cannot fit, the compact
`response_budget_too_small` error returns without cursor progress. Increase
the budget enough for that frame; the plugin never advances over unread data
merely to meet a limit. An impossibly small budget cannot bound the error
envelope itself.

Codex and Claude Code may still shorten or externalize a response according
to their own byte or token limits, especially with multibyte text. These are
not controlled by this character budget, and grokpair supplies no host
large-output override. Page rather than raising the budget. If a host shortens
a result, read again from the previous cursor with a smaller `max_chars`.
The same MCP reads recover structured payloads in either host without shell
or filesystem access. A turn's `text_file`, when available, is an additional
way to read root text only; drain the pages for attention and other records.

### Cursors

Each page carries `cursor` (a `gp1.` string) and `has_more`. The cursor keeps
the position, the view and the prompt filter it was created with, and it is
how grok_wait tells what is new. Pass it back unchanged; do not decode,
build or edit it. Omitting the cursor reads from the beginning. A cursor used
with another collaborator, view or prompt filter, or one ahead of the retained
state, is `invalid_cursor`; to change view or filter, start again without a
cursor. There is one cursor for both draining pages and later waits.

`prompt_id` on grok_read restricts the page to records associated with that
native prompt, and the filter stays in the cursor. Records without a prompt
(the queue, options, capabilities, side answers, background tasks,
elicitation-completion notices, and issues such as image-exclusion notices
that carry no prompt ID) are then excluded, while the summary fields stay
session-wide. Read without a cursor or filter to establish an unfiltered
cursor again. A prompt the collaborator never observed is `prompt_not_found`.

### Turn text files

When a turn stops running (it completed or was cancelled, or became `unknown`
because its worker was found gone at close or resume), grokpair writes the
turn's complete text to
`<store>/runtime-v2/agents/<agent_id>/turns/<prompt_id>.md`, where `<store>`
is `GROKPAIR_HOME` or `~/.local/state/grokpair`; a prompt ID that is not a
plain lowercase file name is replaced by its SHA-256, so two IDs that differ
only by case never share a file on a case-insensitive volume. The file has
mode 0600 in a 0700 directory and is written atomically, through a temporary
file and a rename, once the change that stopped the turn has committed; text
that arrives for a stopped turn rewrites it. A running turn carries no
`text_file`.
Result-view turn entries and records-view turn records carry its absolute path
as `text_file` only when its bytes match the current authoritative turn.

The file starts with front matter whose values are JSON scalars, and therefore
valid YAML: `agent_id`, `prompt_id`, `operation_id` (when grokpair sent the
prompt), `status`, `stop_reason` (when known), input `cwd`, `execution_cwd`,
`worktree_root`, `sandbox_argument`, `sandbox_observation: "unavailable"` and
`task` (the brief, when grokpair sent it). The text follows, its blocks separated by a blank line
exactly as the result view joins them.

The database stays authoritative: a failed write produces no error, and
grok_read still returns the text. An absent, unreadable or stale file is not
offered as `text_file`, including after a failed rewrite or store reopen;
the old file may remain on disk. The file survives crashes,
restarts and close, and any tool or person can read it without grokpair;
close deletes nothing. A turn cut off by a crash keeps its text in the
database and gets its file when the collaborator is closed or resumed. It is
the only file grokpair writes besides its SQLite databases, and it holds root
text only. Native worktrees live outside the bridge store under Grok's own
placement and retention.

## grok_wait

| Field | Meaning |
| --- | --- |
| `targets` | Required, at least one `{agent_id, cursor?}`, with distinct agents and no count limit. |
| `until` | `settled` (default) or `change`. |
| `timeout_ms` | 0 to 600,000, default 120,000. Zero takes an immediate snapshot. |
| `view` | `result` (default) or `records`. A target with a cursor keeps the cursor's view; naming a different view makes that cursor invalid. |
| `max_chars` | UTF-16 code units of the whole serialized result, default 32,000. Delivered target pages share this combined budget; see [Pages](#pages). |

The result is `{call_status, agents}` with only the target pages actually
delivered, each with its own `agent_id`, `status`, `cursor` and `has_more`.
`agents` can be a subset of `targets`. Update only the cursors of included
IDs; keep each excluded target's complete input cursor unchanged. When some
are excluded, put delivered targets behind them for the next wait. There is
no server-maintained global fairness guarantee.

For example, if the input is A at cursorA and B at cursorB but only A is
delivered at nextA, the next wait uses A at nextA and B still at cursorB.
Insufficient remaining space defers a sibling; it never advances that
sibling's cursor. The target that justified `changed` or `settled` is included
from the same observation used to project its page.

A target has something new when its records have not all been read (the
previous page had more), when a meaningful change happened since its cursor,
or when its status changed. Without a cursor, a target is new once anything
meaningful has happened or it is settled. With `until: "settled"`, the call
returns once any target that has something new is `idle`, `ready`,
`attention`, `disconnected`, `closed` or `unavailable`: in other words, it has
stopped working, needs an answer or became unavailable. With
`until: "change"`, it returns once any target has something new.
Meaningful changes include operation outcomes, turn outcomes, attention,
queue, options, files, background tasks, issues and status changes, not each
text chunk. Otherwise the call returns `timeout` at the deadline with what is
available. A timeout never stops work; wait again with the returned cursors.

The deadline bounds the wait, not the task. Waiting and reading never launch,
resume or change work. When a target cannot be read, or its cursor is
invalid, its compact entry has `agent_id`, `status: "unavailable"`,
`cursor: null`, `has_more: false` and the failure as an issue (`records` in
that view); it does not repeat an unreadable summary. Other targets are
unaffected. Because an unavailable target counts as settled, a `settled`
wait then returns at once;
drop that target to keep waiting on the others.

While a target's `has_more` is true, continue it with grok_read and its own
cursor, and keep its final cursor for the next wait; a turn's `text_file` also
holds its complete text. After the root turn ends, keep waiting with an
unfiltered cursor if background work or session notices matter.

## grok_read

| Field | Meaning |
| --- | --- |
| `agent_id` | Required. |
| `cursor` | Optional; omit to read from the beginning. |
| `view` | `result` (default) or `records`; must match the cursor's view when both are given. |
| `prompt_id` | Optional native prompt filter, kept in the cursor. |
| `max_chars` | Characters of the whole result, default 32,000; see [Pages](#pages). |

The result is `{call_status: "ok", agent}` with one page. Reading never waits,
starts, resumes or changes work. Repeat with the returned cursor while
`has_more` is true.

## grok_list

| Field | Meaning |
| --- | --- |
| `include_closed` | Default false: open collaborators only (every status except closed). True adds closed ones, whose output stays readable. |
| `key` | Only collaborators spawned with this key, plus the key's registered holder when its state cannot be read, which appears as unavailable. |
| `limit` | Positive integer, default 20, no policy maximum. |
| `cursor` | `page.next_cursor` from the previous call with the same filters. |

The result is `{call_status: "ok", agents, page: {has_more, next_cursor?}}`
with summaries newest first. A collaborator whose state cannot be read appears
as an unavailable summary, which is not evidence that no work existed. The
list cursor is separate from read and wait cursors and is valid only with the
filters that produced it. List is for discovery and recovering an `agent_id`,
not for output.

## Attachments and output custody

Each attachment is `{path, kind}`: an absolute canonical path, free of
symlinks, to a regular file the server can open, and an explicit kind. Nothing
is inferred from the extension, and a path mentioned in prose is not an
attachment. A file whose identity or metadata changes while it is being
prepared is refused.

- `reference` passes the file's mutable native resource reference (its exact
  file URI, with a JSON-encoded path label) without the wrapper reading,
  embedding, extracting or staging it. Any regular file is eligible; Grok's
  tools decide whether and how to read it.
- `image` preflight reads only the signature and recognizes PNG, JPEG, WebP,
  GIF, BMP, TIFF or ICO before admission. The worker checks again and sends
  the bytes as ACP base64 image content; Grok owns decoding and conversion.
  Unrecognized bytes are refused, with no conversion or fallback to reference.

There is no count or size cap and no permanent copy or digest receipt. Keep
referenced files available while Grok uses them. Admission is not
consumption: a file can change or become unreadable after preflight, so image
preparation can still fail after admission and before the prompt
is sent, which leaves an admitted operation with its actual effects rather
than a silent drop. Later native image-exclusion notices become
`native_image_dropped` issues with the exact method, the full notification and
Grok's notes; exclusion from one request is not necessarily removal from the
conversation or failure of the prompt. Notices without a prompt ID need an
unfiltered read. There is no ACP audio input: a reference to an audio file is
a path for native tools, not model audio, and UI dictation and sound in
generated video are separate things.

A file record can identify an input, a place a tool read, or an output; it is
not automatically a deliverable. Paths and URIs can change or disappear and are
not acquired, hashed, validated or retained. Inspect the actual contents at the
point of use, and preserve accepted bytes at an authorized destination when
they must last. Inspect a native worktree at `worktree_root`, resolving Grok's
relative paths from `execution_cwd`. Compare its actual Git state with the
source state delegated and the caller's current work, including new,
untracked and binary changes and relevant tests. Native creation may have
copied existing changes; not every diff was made by the collaborator. Nothing
is automatically applied, staged, committed, merged or pushed by grokpair.
Close does not delete the tree; native retention remains Grok's policy.

## Native attention responses

grok_respond takes `agent_id`, the exact `request_id` of a pending request and
`response`, the native object for that request's method. The pending request
must still be pending and unanswered, and the response is validated against
its method and the values it offered before admission.

| Method | Response |
| --- | --- |
| `session/request_permission` | `{outcome: {outcome: "selected", optionId}}` with an offered optionId, or `{outcome: {outcome: "cancelled"}}`. |
| `_x.ai/ask_user_question` | `{outcome: "accepted", answers, annotations?}`; `{outcome: "chat_about_this"}` or `{outcome: "skip_interview"}` with optional `partial_answers`; or `{outcome: "cancelled"}`. |
| `_x.ai/exit_plan_mode` | `{outcome: "approved" \| "cancelled" \| "abandoned", feedback?}`. |
| `_x.ai/mcp/elicit` | `{outcome: "accept" \| "decline" \| "cancel", content?}`. |
| `elicitation/create` | `{action: "accept" \| "decline" \| "cancel", content?}`. |

Question `answers` map the exact question text to a string or an array of
strings, preserved without normalization; partial and empty answers are valid.
`annotations` may carry `preview` and `notes` per question, including for a
free-form answer. `partial_answers` map question text to a string. Cancelling a
question resolves it normally. No wrapper rule requires every question to be
answered, restricts answers to offered choices or fixes their number.

For a plan, `approved` accepts it and proceeds to implementation, `cancelled`
rejects the proposed plan and stays in plan mode (feedback can guide a
revision) and `abandoned` leaves plan mode without implementing. These are not
interchangeable ways to decline. `feedback` may be absent, empty or null.

Elicitation content is validated against the supplied schema without defaults,
coercion or removal. A valid form is not disclosure authority: the caller
decides the choices entrusted to it and asks its user only for authority or
preferences that are genuinely missing. An invalid response leaves the request
pending and correctable. An answer that was submitted is not sent again, and
an answer whose delivery is unknown needs inspection, not another response.

Requests end in three ways besides an answer. An authoritative cancellation of
the exact prompt expires its pending requests, including ones arriving late,
with reason `prompt_cancelled`; an ordinary completed turn expires nothing.
Grok's `interaction_resolved` notice expires pending requests for that exact
tool identity with reason `interaction_resolved` and source
`native_interaction_resolved`, including a request that arrives after the
notice; a later pending interaction can reopen that identity for a new request.
Worker loss expires them with reason `worker_absent`. An expired request keeps
its IDs, payload, `source`, `expired_at` and any linked response operation; an
answer admitted but not yet sent becomes `not_sent`, and an uncertain one stays
uncertain. Do not answer expired requests or manufacture replacements. A
malformed native request is retained with status `rejected` and its error.

## Search and native jobs

`search` is native per-turn intent, not forced grounding or a network
firewall, and it is available only when Grok advertises per-prompt tool
overrides (otherwise the operation fails with `search_unavailable`).

- `webSearch` takes `allowedDomains` or `excludedDomains`, each at most five
  domains; nonempty lists of both are rejected.
- `xSearch.dateBound` takes canonical `fromDate` and `toDate` (`YYYY-MM-DD`),
  `fromDate` inclusive and `toDate` exclusive at 00:00 UTC, with `fromDate` on
  or before `toDate`. The bound applies to native keyword and semantic search,
  not necessarily to account lookup or thread fetching.

Omitted engines and semantically empty objects keep native settings. Nested
null fields mean absence, not clearing; only `webSearch: null` or
`xSearch: null` clears that engine's override. Cutoff and coverage flags
qualify the evidence, not admission.

`native_capabilities` preserves omission as omission and null as null; it is
evidence, not an allowlist, and it is separate from `native_options`. Grok
1.0.30 was observed announcing `promptCapabilities.image: false` while
accepting and consuming ACP image input, so use `kind: "image"` for visual
input rather than declining the job or substituting a reference. In
`_meta["x.ai/capabilities"].toolOverrides`, `x_user_search: false` and
`x_thread_fetch: false` mean those tools do not apply the X date cutoff, not
that they are absent. Direct ACP audio is a real rejection. The
[native-work reference](../plugin/skills/grokpair/references/native-work.md)
owns the caller's detailed reading of these values and the guidance for
engineering, research, documents, images and video.

For visual editing, image-to-video and reference-to-video, supply
`kind: "image"`; native video tools need actual resolved image paths, not
image-position markers. Text-to-video creates a first frame and animates it
for six or ten seconds. There is no wrapper media API or ACP audio input.
Audio work can still be delegated to available native tools, with audio or
video files passed as references. Native skills, MCP servers, memory and
background work stay native. A leading `/name` in a task can invoke a native
command, skill or workflow through ACP; it is not necessarily literal model
text. Authorize its effects before sending, and do not rely on built-in
commands to consume appended guidance or attachments. UI-only interactions
remain outside ACP. Requested dimensions, duration or fidelity are not proof: inspect
the real files, images and complete videos.

## Interrupt, close and recovery

**grok_interrupt** without `prompt_id` sends Grok's session cancel, like
Ctrl-C; queued prompts stay queued. With `prompt_id` it instead asks Grok to
remove that queued prompt at the exact version observed at admission. The
prompt must be uniquely present in the current native queue, not running, not
already terminal and have a usable version; otherwise the call is refused
before admission. Grok's owner and editability checks still apply, so a
stale, drained, protected or other-owner entry can stay unchanged; there is
no retry with a refreshed version and no fallback to session cancel, and
targeted removal never cancels a running prompt. The acknowledgement is not
removal: the outcome shows in later turn and queue records.

**grok_close** closes a collaborator, cancelling any running work, with no
requirement to have read its output first. It deletes nothing: retained output,
turn text files, the native session and any worktree stay, and nothing is
applied to the caller's checkout. A live worker cancels, closes the native
session and exits, and native closure and process exit are reported separately.
When the worker is proved gone, or a reserved launch was never claimed, close
retires the collaborator at once without starting anything (`reason`
`resident_absent` or `unclaimed_launch_fenced`); fencing the reservation means
a late worker cannot start. When process identity cannot be observed, close is
refused. Close does not resolve older uncertain outcomes, and it releases the
collaborator's spawn key. In-progress provisioning is cancelled through its
exact process identity and its exit observed, retaining any returned path or
unresolved outcome. Closure neither rolls back native creation nor authorizes
another creation after an unknown outcome.

**Recovery.** The worker survives the caller and its host. Read and wait are
passive. Continuing a disconnected collaborator takes an explicit new
`follow_up` with `resume: true`, admitted only on the evidence described under
[grok_send](#grok_send); elapsed time, a stale PID or command text never
substitute for it, and resume never replays old admissions. Product operation
never migrates or deletes retained state; see [PRIVACY](../PRIVACY.md) and
[SECURITY](../SECURITY.md).

## Command line

`grokpair` is the same service as a command:

```text
grokpair <tool> [json | -]    tool: spawn send wait read list respond interrupt close
grokpair mcp                  serve the eight tools over MCP stdio
grokpair schema               print tool names, descriptions and input schemas
grokpair version              print product, version and schema_version
grokpair                      print usage (also help, --help, -h)
```

A tool may also be named in full (`grokpair grok_list`). Its input is one JSON
object as the single argument, or read from stdin with `-`; with no argument
the input is `{}`. The result object is printed as one line on stdout, with
exit status 0, or 1 when `call_status` is `error`. Invalid JSON prints the
error envelope on stderr with exit status 1; an unknown command or extra
arguments print it with code `invalid_command` and exit status 2.
`internal-worker` is how the service starts its own worker and is not a
command to run by hand.

```bash
grokpair spawn '{"task":"Create comparison.docx from the sources here; inspect its rendering, leave sources unchanged and return the file to me without contacting anyone.","cwd":"/absolute/path/to/research-directory"}'
grokpair wait '{"targets":[{"agent_id":"agent_…"}],"timeout_ms":90000}'
grokpair read '{"agent_id":"agent_…","cursor":"gp1.…"}'
```

A shell tool has its own timeout; keep `timeout_ms` below it and wait again
rather than blocking past it.

## Hosts and nesting

Codex starts the server with `tool_timeout_sec` 660; Claude Code uses a
660,000 ms timeout. Both follow their host's normal approval policy, with no
packaged standing approval override or auto-allow hook. Native requests
remain decisions within the caller's delegated authority; see
[SECURITY](../SECURITY.md#host-approval). On the command line, the host's shell
permissions govern every call, `grokpair respond` included. Bounded paging
uses the same contract in each host, without a host large-output override.

Claude Code also receives the relay agent `grokpair:grok`, defined in
[plugin/agents/grok.md](../plugin/agents/grok.md). It runs in the background,
spawns Grok with the brief unchanged and a spawn key, and waits until Grok is
finished: status `idle`, nothing more to read and no background task the brief
needs still running. It returns Grok's answer verbatim with `agent_id`,
status, cursor and each turn's `text_file`, plus anything the caller must act
on; in auto permission mode Claude Code delivers that report through its
subagent hand-back after classifier review, and the Agent result is only a
short note. It answers native requests within delegated authority, without
requiring a prewritten exact answer, and forwards human-only decisions or
requests for new authority. It leaves the collaborator open for the parent to
inspect artifacts and request correction in the same conversation. The parent
accepts and closes it. Only an explicitly one-shot brief permits relay closure
after required work finishes; on `ready` it returns without closing and says
Grok's queue could not be observed.

Each worker starts Grok with `GROKPAIR_COLLABORATOR=<agent_id>` in its
environment, and Grok passes it on to its MCP servers and tools. A grokpair
server started with it set serves no tools, and the command line refuses every
tool call and `internal-worker` with `nested_collaborator`, so a collaborator
cannot delegate to grokpair and its Grok cannot become another collaborator's
worker.
