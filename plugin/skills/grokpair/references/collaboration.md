# Continue, observe and intervene

## Choose the intervention by its effect

The [action table](../SKILL.md#choose-the-next-action-by-its-effect) lists the
fields of each `grok_send` action. What follows is the native behaviour that
decides between them.

`follow_up` asks for no cancellation, but Grok's own follow-up setting
(`ui.follow_up_behavior: steer`) can deliver it at once while a turn is
running and nothing else is queued. `steer` redirects current work without
cancelling it: Grok inserts it at the next safe point, or makes it a priority
turn if none comes. `send_now` is for new work that deserves priority even at
the cost of the current turn; it does not preempt unconditionally. An active
Goal (Grok's ongoing goal work, not a single prompt) is steered rather than
replaced, an entry Grok has not yet accepted is not cancelled, and the queue
stays first in, first out. Read the queue and the turns that follow rather
than equating admission with interruption.

A native `removedFromQueue` outcome appears as a completed operation in the
result view. The prompt is no longer independently queued; this is not a
cancelled turn. Removal can also mean combination or interjection, whose
receiving turn is not always identified. Keep the native outcome instead of
guessing from text, and do not expire or answer attention on its authority.

Tool: grok_send

```json
{
  "agent_id": "agent_12345678-1234-4123-8123-123456789abc",
  "action": "steer",
  "task": "Keep the current investigation on duplicate-request handling."
}
```

Tool: grok_send

```json
{
  "agent_id": "agent_12345678-1234-4123-8123-123456789abc",
  "action": "send_now",
  "task": "Answer this first, it now decides the design: can the server recognize a retry after the client timed out?"
}
```

A side question runs beside the conversation without adding a turn. Its
answer arrives in `side_answers`, keyed by the operation that asked it, and is
a separate model contribution: use turns, queue and background records, not
the side answer, to learn what the main work is doing. If a side question's
delivery is unknown, read before asking again.

Tool: grok_send

```json
{
  "agent_id": "agent_12345678-1234-4123-8123-123456789abc",
  "action": "side_question",
  "task": "Which function currently decides whether a retry is safe?"
}
```

## Edit a queued prompt

Take the `prompt_id` from the latest `queue` record in the records view. Its
entries carry Grok's `id`, `version`, `owner`, `lastEditor`, `text` and
`combinedTexts`. Similar text, array position or an operation_id do not
identify a queued prompt.

Tool: grok_send

```json
{
  "agent_id": "agent_12345678-1234-4123-8123-123456789abc",
  "action": "edit",
  "prompt_id": "native-prompt-queued",
  "task": "Narrow the queued review to duplicate-request handling; recommend, do not implement."
}
```

Edit replaces the text and keeps grokpair's workspace guidance after it. It
keeps queued image inputs unchanged; a prompt carrying file references, or
whose inputs are unknown, is refused rather than silently losing them, and
edit takes no new attachments. To replace the inputs of a queued prompt, ask
`grok_interrupt` to remove that exact `prompt_id`, then read the operation
outcome and queue before sending a replacement `follow_up`. Admission alone
does not prove removal; if the prompt started instead, inspect what ran before
deciding what new work is needed. An admitted edit is not proof that the
queue changed. Inspect the operation outcome and latest queue; a later turn
shows what ran.

The summary's `queue_observation` is `{status: "observed"}` or
`{status: "unknown", reason}`. While it is unknown, `counts.queued_prompts` is
null and a connected collaborator with nothing running reads `ready` rather
than `idle`.

## Configure model and effort

Grok's defaults need no discovery turn. For a deliberate choice, read the
latest `native_options` record in the records view and use its exact IDs.
Configure changes the session, also during work, without retargeting inference
already running; it takes no task.

Tool: grok_send

```json
{
  "agent_id": "agent_12345678-1234-4123-8123-123456789abc",
  "action": "configure",
  "model": "<exact native model ID>",
  "effort": "<exact effort ID offered for that model>"
}
```

The model is set first and its catalog decides which efforts exist. The
operation's `effects.configuration.model` and `.effort` each record the value
and `not_sent`, `submitted`, `applied`, `rejected` or `unknown`. An applied
model followed by a rejected effort is a real partial change and is not rolled
back. A failed configuration appears in the result view's `operations`; a
completed one only in the records view. Spawn also accepts model and effort,
with the prompt recorded separately under `effects.prompt`. A `follow_up`
uses the session's configuration; change it with `configure`, not fields on
the follow-up.

## Answer attention

`status: "attention"` means Grok is waiting on you. Read the pending
`attention` record completely: its `method`, `payload` and `request_id`.
`grok_respond.response` is the native response object for that method.

Decide what the brief and your own authority already settle, and ask your user
only for a preference, disclosure or authority that is theirs. An offered
permission or plan cannot widen the task, and a form asking for data does not
authorize disclosing it.

| attention.method | Native response |
| --- | --- |
| `session/request_permission` | `{outcome: {outcome: "selected", optionId: "<offered id>"}}` or `{outcome: {outcome: "cancelled"}}` |
| `_x.ai/ask_user_question` | `{outcome: "accepted", answers, annotations?}`, `{outcome: "chat_about_this" or "skip_interview", partial_answers?}` or `{outcome: "cancelled"}` |
| `_x.ai/exit_plan_mode` | `{outcome: "approved" or "cancelled" or "abandoned", feedback?}` |
| `_x.ai/mcp/elicit` | `{outcome: "accept" or "decline" or "cancel", content?}` |
| `elicitation/create` | `{action: "accept" or "decline" or "cancel", content?}` |

For a permission, choose an offered option only when its effect is authorized:

Tool: grok_respond

```json
{
  "agent_id": "agent_12345678-1234-4123-8123-123456789abc",
  "request_id": "request_12345678-1234-4123-8123-123456789abc",
  "response": { "outcome": { "outcome": "selected", "optionId": "actual_authorized_option" } }
}
```

With `outcome: "accepted"`, `answers` are keyed by the exact question text,
each a string or an array of strings; `partial_answers` (with `chat_about_this`
or `skip_interview`) take strings only. Partial and empty answers are valid; do
not invent answers to complete a form. Annotations can carry notes, also beside
an ordinary choice.

Tool: grok_respond

```json
{
  "agent_id": "agent_12345678-1234-4123-8123-123456789abc",
  "request_id": "request_12345678-1234-4123-8123-123456789abc",
  "response": {
    "outcome": "accepted",
    "answers": { "Which path should the repair prioritize?": "Uploader" },
    "annotations": { "Which path should the repair prioritize?": { "notes": "Preserve the downloader behavior." } }
  }
}
```

`chat_about_this` turns the interview into discussion and `skip_interview`
skips it; both can carry `partial_answers`. `cancelled` resolves the question
normally and does not stop the turn.

Plan outcomes differ: `approved` accepts the plan and proceeds to implement it
within existing authority; `cancelled` rejects this plan and keeps Grok in
plan mode, so `feedback` can ask for a revision; `abandoned` leaves plan mode
without implementing. Absent, empty and null feedback are distinct values.

Tool: grok_respond

```json
{
  "agent_id": "agent_12345678-1234-4123-8123-123456789abc",
  "request_id": "request_12345678-1234-4123-8123-123456789abc",
  "response": {
    "outcome": "cancelled",
    "feedback": "Keep the repair within request identity and retries; deployment is out of scope."
  }
}
```

For elicitation, read the method and its schema, and accept only authorized
content that fits it; nothing is defaulted, coerced or dropped for you.
`elicitation/create` uses the flat MCP form shape (top-level string, number,
boolean or string-array values); `_x.ai/mcp/elicit` accepts JSON content under
its own schema. Decline and cancel need no content. A URL in a request is
neither fetched by grokpair nor evidence that an authentication succeeded.

A response that does not fit leaves the request pending: correct it while it
is still pending. A submitted answer is never sent twice; if its delivery is
unknown, read rather than answer again. Authoritative cancellation of the
exact prompt, native interaction closure, request abort, connection end or
proved worker loss ends the relevant request. Normal turn completion or
removal from the queue does not. `interaction_resolved` means closure, not
approval. An expired request keeps its payload and reason, an answer admitted
but not yet sent becomes `not_sent`, and uncertain delivery stays uncertain.
A later request for the same tool is a new request; do not reopen or recreate
the old one.

## Read results

The result view, the default for `grok_wait` and `grok_read`, groups each page
by what you act on: `turns` (each prompt's text with its status, stop reason,
the operation that sent it and `text_file`), `side_answers`, `attention` not
yet resolved, `files`, `issues`, `operations` that failed, were not sent, have
unknown outcomes or completed with native `removedFromQueue`, and `background`
tasks. Text of consecutive native
message blocks is joined with a blank line. A turn's status can arrive on a
later page than its text.

Once a turn has stopped running (completed, cancelled, or `unknown` because its
worker was found gone), grokpair writes its complete text to a file in its
store and names it as the turn's `text_file`, an absolute path. The file starts
with front matter (agent_id, prompt_id, status, input cwd, execution_cwd,
worktree_root, sandbox_argument and unavailable sandbox_observation;
operation_id and the
brief as `task` when grokpair sent the prompt; stop_reason when known), then
the text joined as the result view joins it. It
outlives crashes, restarts and close, so you or any tool can reopen it later
without grokpair or paging. A turn cut off by a crash keeps its text readable
with `grok_read` and gets its file when the collaborator is closed or resumed;
if a write fails, its text stays readable there. A `text_file` is offered only
when its contents match the database's current turn; an older file left behind
by a failed rewrite is not offered.

The records view (`view: "records"`) returns all retained typed records in
change order: `content` fragments with `prompt_id`, `block_index`
and `native_message_id`, `turn`, every `operation` with its effects, all
`attention`, `file`, `issue`, `background`, and the observations the result
view leaves out: `queue`, `native_options`, `native_capabilities` and
`elicitation_completion`. Records that change (an operation, a turn, an
attention request, an observation) arrive again with their latest value under
the same identity; replace, do not accumulate. Only text fragments of the same
block concatenate, exactly as given.

A cursor remembers its view and any `prompt_id` filter. To switch view or
filter, read again without a cursor. A `prompt_id` filter returns only that
prompt's records and leaves out session-wide ones (side answers, background,
queue, options, capabilities, most issues); the summary fields stay
session-wide. An unknown `prompt_id` is an error, not an empty page.

`max_chars` (default 32,000) bounds the entire serialized JSON result in
UTF-16 code units: envelope, header, grouping, cursors and escaping count.
Text splits without loss or separation of valid surrogate pairs. Large
structured records arrive in `fragments` rather than exceeding the budget:

```json
{
  "record_id": "<opaque record version>",
  "record_type": "attention",
  "offset": 0,
  "json": "<initial portion of the public record's JSON>",
  "complete": false
}
```

Continue with each page's returned cursor. Concatenate contiguous `json` pieces
within the same `record_id` and parse after `complete: true`; they encode the
public retained record, including its `type`, not a partial native request.
Do not answer until the full attention payload is available. The reading can
be divided; the native decision and response remain atomic and subject to
the same authority. Fragment pages carry just `agent_id`, `status`, `cursor`,
`has_more` and `fragments`, plus `fragment_reset` when needed, not the full
summary.

If the record changes during reading, `fragment_reset` names the prior
incomplete `record_id` to discard. Reading resumes from its preceding
checkpoint, including intervening changes. The current version can arrive
normally or as new fragments at offset 0; never append it to old pieces.
The database remains the only owner: no extra
export or archive is created, and superseded latest-value observations are
not a retained history. Restarting the server or closing a collaborator does
not remove retained payloads. Close or expiry can still make an attention
request no longer answerable. A budget unable to fit even a minimal frame
returns `response_budget_too_small` without cursor progress; use a sufficient
budget. The compact error envelope itself cannot fit an impossibly small
budget.

This character budget cannot guarantee that a host's byte or token limit
preserves the page. If the host shortens a result, reread from the previous
cursor with a smaller `max_chars`, not from the unreadable response's trailing
cursor. The same MCP reads work in Codex and Claude without shell or file
access. A turn's `text_file` supplies root text only, not the remaining
records. While `has_more` is true, continue with `grok_read` and the returned
cursor, then keep the last cursor for later waits. A drained page means
everything available so far was read, not that work ended.

Wait wakes on meaningful changes, not on every text chunk. With `until:
"settled"` (the default) it returns once some target has something new and has
stopped working, needs attention or can no longer be observed; with `until:
"change"` it returns on any meaningful change, which suits watching progress.
`timeout_ms` defaults to 120,000 and allows up to 600,000; 0 takes a snapshot.
A timeout returns what is available and cancels nothing. One unreadable
target or bad cursor is reported on that target without failing the others:
its entry has `status: "unavailable"` and a null cursor. The problem appears
in `issues` in the result view, or as a `type: "issue"` entry in `records`
in the records view. Keep that target's input cursor for a separate
`grok_read`, and exclude the unavailable target from subsequent `grok_wait`
calls on the remaining targets. An unavailable target counts as settled;
passing it again with a null cursor makes the wait return immediately.
Do not pass its returned null cursor or a reconstructed cursor to `grok_wait`.

A wait fits the combined result, so `agents` can contain only a subset of the
requested targets. Update only included IDs' cursors; an excluded target keeps
its entire input cursor unchanged. If A is delivered at nextA but B is omitted,
continue with B at its original cursorB and A at nextA, in that order. Move
delivered targets behind excluded ones on subsequent constrained waits; no
server-maintained fairness is promised. A target that triggered `changed` or
`settled` is included, not silently replaced by a sibling. Insufficient
remaining budget defers a target rather than claiming it was read.

Tool: grok_wait

```json
{
  "targets": [
    { "agent_id": "agent_12345678-1234-4123-8123-123456789abc", "cursor": "<cursor returned for this agent>" },
    { "agent_id": "agent_87654321-4321-4321-8321-cba987654321", "cursor": "<cursor returned for this agent>" }
  ],
  "until": "change",
  "timeout_ms": 300000
}
```

An illustrative result entry (fields trimmed, cursor shortened):

```json
{
  "agent_id": "agent_12345678-1234-4123-8123-123456789abc",
  "status": "idle",
  "cursor": "gp1.…",
  "has_more": false,
  "turns": [
    {
      "prompt_id": "12345678-1234-4123-8123-123456789abc",
      "operation_id": "operation_87654321-4321-4321-8321-cba987654321",
      "status": "completed",
      "stop_reason": "end_turn",
      "text": "Retry only after checking acceptance.\n\nTwo sequences duplicate an upload: …",
      "text_file": "/Users/you/.local/state/grokpair/runtime-v2/agents/agent_12345678-1234-4123-8123-123456789abc/turns/12345678-1234-4123-8123-123456789abc.md"
    }
  ],
  "files": [{ "path": "/absolute/path/to/repository/src/uploader.ts", "prompt_id": "12345678-1234-4123-8123-123456789abc" }]
}
```

Never construct a cursor; pass back the one returned.

## Find collaborators

Tool: grok_list

```json
{ "include_closed": true, "limit": 20 }
```

List returns summaries, newest first: open collaborators by default, closed
ones too with `include_closed`, and only those spawned with a given `key` when
you pass one, plus that key's holder shown as `unavailable` when its state
cannot be read. Follow `page.next_cursor` with the same filters. A summary is
not delivered content; read the collaborator for that. An `unavailable`
summary means its state could not be read, not that it never existed.

## Stop, close and recover

Tool: grok_interrupt

```json
{ "agent_id": "agent_12345678-1234-4123-8123-123456789abc" }
```

Without `prompt_id`, interrupt is Grok's Ctrl-C for the current turn; queued
prompts stay queued. With `prompt_id`, it asks Grok to remove that queued
prompt at the version seen at admission, subject to Grok's own ownership and
edit rules; it never falls back to cancelling the session. The turn can finish
first. Learn the outcome from later turn and queue records.

Close cancels running work and has no unread-output guard, so read what you
need first unless stopping matters more. It releases a spawn key, stops a
launch that has not started, and deletes nothing: output, turn text files,
native files, the native session and any worktree remain. It does not resolve
earlier unknown outcomes. During native provisioning, close cancels that
utility through its exact process identity and observes its exit; returned
paths and unresolved outcomes remain recorded. Native worktree retention is
Grok's policy, not a promise made by close.

A collaborator outlives the process that called it: your own disconnection is
no reason to spawn again. When its worker or Grok process is gone, or a launch
can no longer be claimed because its worker exited first or the process that
reserved it is gone, status is `disconnected`. A new `follow_up` with
`resume: true` continues the known native conversation with new work, once
grokpair has proved the old processes absent; it never replays earlier input.
Resume reuses the admitted directory and sandbox argument; omission stays
omitted, so Grok resolves its configuration anew. Missing execution context
is a failure rather than permission to create a new tree or run in the source
directory. A different requested profile requires a new collaborator; it
cannot retarget a keyed spawn or a resumed process.

Tool: grok_send

```json
{
  "agent_id": "agent_12345678-1234-4123-8123-123456789abc",
  "action": "follow_up",
  "resume": true,
  "task": "Continue from the retained context. Do not repeat the earlier change; say what remains uncertain about it and what evidence would settle it."
}
```

On `call_status: "error"`, read `error.admission`. `none` means nothing was
admitted and carries no operation_id: correct the input or precondition. With
`confirmed` or `unknown` the operation_id is kept and effects may exist, so
read before doing anything that would repeat them. Structural input errors
from the host can arrive as plain text instead of the JSON result.
