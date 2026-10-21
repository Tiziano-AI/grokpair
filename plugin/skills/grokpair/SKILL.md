---
name: grokpair
description: "Delegate a bounded task to a detached Grok Build collaborator: research, review, a candidate implementation, documents or media. Keep working, then inspect Grok's answer and files before deciding what to use."
---

# grokpair

grokpair gives you a Grok Build collaborator that works beside you, detached
with its own model, tools, skills and conversation. Use it for an
independent view (a review, a second opinion, a counterexample), for work that
can run in parallel with yours (research, a candidate implementation, a
document, images or video), or to keep a long investigation out of your own
context. Grok contributes; you inspect the result, decide what to use and stay
responsible for integration and final claims.

The tools are `grok_spawn`, `grok_send`, `grok_wait`, `grok_read`,
`grok_list`, `grok_respond`, `grok_interrupt` and `grok_close`. Where the
`grokpair` command is on your PATH (Claude Code's Bash tool adds it), the same
calls run as `grokpair <tool> '<json>'`, for example
`grokpair wait '{"targets":[{"agent_id":"..."}]}'`. In Claude Code, the
`grokpair:grok` agent runs one brief in the background and returns
Grok's answer with the collaborator open for your inspection and correction;
call the tools yourself when you want to follow up, steer or run
several collaborators. In auto permission mode Claude Code delivers the relay's
report through its subagent hand-back (SubagentHandback) after its classifier
reviews it, so the Agent result itself may be only a short note.

## Write a brief Grok can act on

Grok does not inherit your conversation, instructions or loaded skills. Give
it a self-contained brief with:

- the purpose, and the decision or change the result will feed;
- the facts and sources that matter, with absolute paths, and what you already
  ruled out;
- the result you need and its form (a recommendation with evidence, a patch in
  its worktree, a DOCX at a named location);
- limits on files and effects, and what you are doing in parallel so the work
  does not overlap.

A brief states boundaries but is not a sandbox. Grok's own tools, skills and
integrations are available to it; restrict them only where the work needs it.
Grok also runs with its owner's personal instructions, which can tell it to
notify people, send messages or publish. The bridge identifies the request as
delegated and its answer as returning to you, the calling agent. Your brief
still names whether it may contact anyone and the exact effects entrusted to it.

A task beginning with `/name` can invoke a native command, skill or workflow,
including one that changes permissions or configuration. Use it only when
those effects are authorized; built-in commands may ignore the appended
guidance and attachments. Ordinary work starts with a prose brief.

## Run the cycle

Spawn with the existing absolute physical directory where the work belongs,
with symlinks already resolved. Grok can create a document there without Git
or a staging directory:

Tool: grok_spawn

```json
{
  "task": "Create comparison.docx in this directory from the service proposals and requirements.md. Recommend one with source evidence and the strongest countercase. Use the relevant native document skills and inspect its rendering. Return the file and your findings to me, the calling agent. Leave source files unchanged; do not contact anyone or publish. I am checking the commercial assumptions separately.",
  "cwd": "/absolute/path/to/research-directory",
  "key": "service-proposal-document"
}
```

Spawn returns `agent_id` and `operation_id` at once, not the answer. With a
`key`, repeating the same normalized initial request while that collaborator
is open returns it (`call_status: "existing"`, with its `agent_id` and summary but no
`operation_id`) instead of starting a second one. Recover a lost spawn response
with `grok_list` by key or repeat the same keyed call, never a new key. An
error reporting confirmed or unknown admission is read by its returned
identity before any further action. A changed brief, attachment, model,
effort, search or placement selection conflicts with a held key; use
`grok_send` to change existing work. Omitted worktree equals false and omitted
attachments equal `[]`; other omission is distinct from explicit selection,
including search omitted versus `{}`. A missing or unreadable original
request retains the key and returns an error, not permission to relaunch.
Keep working, then wait on the returned `agent_id`:

Tool: grok_wait

```json
{
  "targets": [{ "agent_id": "agent_12345678-1234-4123-8123-123456789abc" }],
  "timeout_ms": 600000
}
```

Wait returns `settled` once a target has stopped working or needs you, with
something new since your cursor; `until: "change"` returns on any update
instead. A `timeout` returns what is available and leaves the work running:
wait again with the returned cursor. Each entry of `agents[]` holds:

- `status`: `working`, `idle` (Grok's queue is observed empty), `ready` (the
  queue is not observed, so queued work may remain), `attention` (Grok is
  asking you something), `starting`, `disconnected`, `closed` or
  `unavailable`. Neither `idle` nor `ready` means a background task has
  finished, and closing cancels one that still runs;
- `turns`: per prompt, Grok's `text` with the turn's `status` and
  `stop_reason`, the `operation_id` that sent it and, once the turn has
  stopped running and a current file is available, `text_file`, a file in
  grokpair's store holding its complete text;
- when present: `side_answers`, pending `attention`, `files`, `issues`,
  `operations` that failed, were not sent, have unknown outcomes or completed
  with native `removedFromQueue`, and `background` tasks;
- `cursor` and `has_more`: pass the cursor back to receive only what is new.
  While `has_more` is true, call `grok_read` with it until it is false.

`max_chars` (default 32,000) bounds the entire serialized JSON result, escaping
and envelope included, in UTF-16 code units. A wait may return only some of
its requested targets: update only the returned IDs' cursors, keep excluded
targets' input cursors, and move delivered targets behind excluded ones in
the next wait. Nothing was delivered for an omitted target.

A large structured record arrives in `fragments`, not as a partial native
object. Continue with each page's returned cursor, concatenate contiguous
`json` pieces for one `record_id` by `offset`, and parse only when `complete`
is true.
A page's `fragment_reset` names an incomplete version to discard: reading
resumes before that record, preserving intervening changes, and its current
version arrives normally or as new fragments at offset 0. Read attention
completely before deciding or responding. Fragment pages have only identity,
status and continuation fields, not the full summary. If the budget cannot
fit even a minimal frame, `response_budget_too_small` preserves the read
position; use a sufficient budget.

Characters cannot guarantee that a page fits a host's byte or token limit,
especially with multibyte text. Page with `grok_read` rather than raising the
budget. If the host shortens a result, read again from the previous cursor
with a smaller `max_chars`. A turn's `text_file` is another way to read its
root text only; still drain the pages for attention and other records.

Idle means the turn ended, not that the answer is right. Check what the
contribution claims before using it: open the files and media it reports,
inspect worktree changes and run the relevant checks yourself. Follow up in
the same conversation when a correction or another question would improve the
result:

Tool: grok_send

```json
{
  "agent_id": "agent_12345678-1234-4123-8123-123456789abc",
  "task": "The comparison table is clipped in the rendered document. Repair the layout in comparison.docx, inspect the rendered result and leave its recommendation and source claims unchanged. Return the corrected file to me without contacting anyone."
}
```

Close the collaborator when it has nothing more to give. Closing cancels
running work and deletes nothing. Native worktree retention remains Grok's
policy, so preserve inspected work at an authorized destination when it must
last. The relay leaves Grok open by default; you close after accepting the
contribution or deciding no correction is needed. An explicitly one-shot
relay brief may ask it to close after collecting the result.

Tool: grok_close

```json
{ "agent_id": "agent_12345678-1234-4123-8123-123456789abc" }
```

## Choose the next action by its effect

Every `grok_send` names `agent_id`; `action` defaults to `follow_up`. Each
action accepts only its own fields.

| Need | Action | Fields |
| --- | --- | --- |
| More work in the same conversation | `follow_up` | `task`; optional `attachments`, `search`, `resume`. Requests no cancellation, though Grok's follow-up setting may deliver it at once. |
| Redirect current work without cancelling it | `steer` | `task`; optional image `attachments`. Inserted at Grok's next safe point. |
| Priority work that may cancel the current turn | `send_now` | `task`; optional `attachments`, `search`. An active Goal is steered instead. |
| A question beside running work | `side_question` | `task`. The answer arrives in `side_answers`, not in a turn. |
| Rewrite a prompt still in the queue | `edit` | `task` and the queued `prompt_id` from the records view. |
| Change model or effort | `configure` | `model` and/or `effort`, exact native IDs; no task. |

| Other need | Tool |
| --- | --- |
| Answer Grok's question or permission request (`status: "attention"`) | `grok_respond` with the `request_id` and the native response for its method |
| Stop the current turn, or remove one queued prompt | `grok_interrupt`, with `prompt_id` for a queued prompt |
| Find a collaborator again | `grok_list`, optionally by `key` or with `include_closed` |

Answer attention within the authority you were given, and ask your user only
for a decision that is theirs; the brief need not prewrite your exact answer.
Native `removedFromQueue` means that prompt is no longer independently queued,
not that a turn was cancelled or attention was approved or expired. It may
have been combined or interjected; do not guess a receiving turn from text.

## Choose isolation and sandbox only when the work needs them

`cwd` is working context, not permission to change everything in it. Without
`worktree`, execution uses that directory. `worktree: true` asks Grok to create
its native Git worktree and preserves your directory's position within it.
Native defaults include uncommitted work under native copy rules, rather than
a committed-only or byte-exact copy. Inspect the returned `worktree_root` and
`execution_cwd`, then adopt changes yourself; the bridge never applies them.

Optional `sandbox` is an exact native profile name, independent of worktree
placement. Omit it to pass no flag and let Grok resolve its configuration,
which may select `off`. `sandbox_argument` reports only that launch request;
`sandbox_observation` is unavailable because ACP does not report resolved
enforcement. A brief is not a sandbox. If verified confinement is essential,
this missing observation matters; it is not a reason to add a discovery
ritual to ordinary work. Native denials are returned intact, never bypassed
with a looser profile or an output-location workaround.

## Keep effects and uncertainty straight

A result with `call_status: "error"` carries `error.admission`: `none` means
nothing was admitted, so correct the input or the precondition `error.action`
names (for `worker_unavailable`, a new session) and call again; `confirmed` or
`unknown` means an operation may have taken effect, so read before acting and
never resend it blindly. Your own disconnection does not stop a detached
collaborator. Reading and waiting never start or change work. A collaborator
whose process has gone reports `disconnected`; a new `follow_up` with
`resume: true` continues its conversation with new work and never replays
earlier input.

## Go deeper

- [Collaboration](references/collaboration.md): steering, queue edits,
  configuration, answering each kind of attention, views, cursors and
  pagination, several collaborators, interruption and recovery. Open it before
  answering attention or when a result is not what you expected.
- [Files and workspaces](references/files-and-workspaces.md): attaching
  files and images, native sandbox selection, asking for output files, and
  reviewing a native worktree. Open it before attaching inputs or
  integrating a candidate.
- [Native work](references/native-work.md): briefs and acceptance for
  engineering, web and X research, documents, images and video, search
  controls, native capabilities and background tasks. Open it for any job
  beyond reading and reasoning over files.
