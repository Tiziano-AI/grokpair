# Inputs, files and execution directories

## Choose where work happens

Ordinary work executes in `cwd`; Git is unnecessary. Name the files Grok may
change and the effects it may perform in the brief. The directory supplies
context, not authority to change everything in it.

`cwd` must be an existing absolute physical directory with symlinks already
resolved. Agent homes (Codex,
Claude Code, Grok, Pi and the grokpair store) and the account home itself are
refused, and a Git root derived from the cwd cannot widen that.

`worktree: true` requests native Git isolation. `sandbox` separately requests
an exact native profile name. Omission passes no sandbox flag and leaves
Grok's requirements, environment and configuration in charge, including a
possible `off` profile. Native `read-only`, `workspace` and custom names are
profile requests, not grokpair modes. Empty names are rejected.

The summary's `sandbox_argument` is the requested name or null for omission;
`sandbox_observation` states that effective enforcement is unavailable through
ACP. A profile name, a live process or an unrelated inspection cannot prove
confinement. Native tool permissions are separate from sandbox selection. If
Grok refuses the requested work, inspect its diagnostic rather than moving
output or choosing another profile to bypass it.

## Attach files as references or images

Each attachment has an existing absolute canonical `path` to a regular file
and a `kind`:

| Kind | What Grok receives | Use it for |
| --- | --- | --- |
| `reference` | A native reference to the file at that path. grokpair does not read, embed, extract or copy it. | Documents, source, spreadsheets, PDFs, video or any file Grok's tools should read. |
| `image` | The image bytes, for Grok to decode and convert. | Visual input for understanding, editing or image-driven generation. |

Use `image` for visual input even if Grok's capabilities announce otherwise
(see [native capabilities](native-work.md#interpret-native-capabilities)).
Images can be PNG, JPEG, WebP, GIF, BMP, TIFF or ICO. There is no grokpair
limit on the number or size of files; what Grok's readers can consume is
Grok's to decide. Image preflight reads only the signature and refuses
unrecognized bytes before admission; the worker checks again before sending.

Tool: grok_spawn

```json
{
  "task": "Compare the attached specification with the implementation and the diagram. Read the PDF with the appropriate native reader. Cite concrete contradictions; do not modify the repository. If a source cannot be read, name the missing evidence rather than guessing.",
  "cwd": "/absolute/path/to/repository",
  "attachments": [
    { "path": "/absolute/path/to/repository/specification.pdf", "kind": "reference" },
    { "path": "/absolute/path/to/repository/context.png", "kind": "image" }
  ]
}
```

A reference is a path, and the file can change after admission. Keep it in
place until Grok has used it, and if exact bytes matter, hand Grok a stable
copy you control. A PDF reference is a locator, not its text or pages: ask
Grok to open that PDF with its native reader and to inspect the pages a table
or layout finding depends on. If the reader fails, the right result is the
missing evidence, not a guess.

There is no audio input kind. An audio file passed as `reference` is a path
for a suitable native tool, not audio the model hears.

Admission and consumption are separate. A file can change or become
unreadable after preflight, so an admitted operation can still fail before
the prompt is sent:
read the operation's effects rather than retrying without the input. Grok can
also drop an image it received; a `native_image_dropped` issue keeps Grok's
full notification and notes, which say whether it left one request or the
conversation.

## Add inputs to later work

`follow_up` and `send_now` accept references and images, `steer` accepts
images only, and `edit` accepts none: it keeps the queued prompt's image
inputs and refuses prompts with references or unknown inputs (see
[editing a queued prompt](collaboration.md#edit-a-queued-prompt)). To replace
queued inputs, follow that removal-and-observation procedure first; a new
follow-up alone leaves the old prompt queued. To add work with new inputs:

Tool: grok_send

```json
{
  "agent_id": "agent_12345678-1234-4123-8123-123456789abc",
  "action": "follow_up",
  "task": "Reassess the recommendation using the revised spreadsheet and say what changed from the original evidence.",
  "attachments": [
    { "path": "/absolute/path/to/repository/revised.xlsx", "kind": "reference" }
  ]
}
```

## Ask for output you can use

Name the file, its content and where it should go in the task, normally in the
working directory you supplied. Grok writes with its own tools subject to its
native configuration. grokpair imposes no
report format; when a current file is available, the finished turn's
`text_file` names its complete root text in the bridge store. Database text
remains readable even if file writing fails.

A `file` record is a native path or URI with the prompt and tool call it came
from. It can be an input Grok read, a location it looked at, or an output it
wrote: match it with what Grok said and open the file. References can change,
disappear or still be written after the turn ends, and grokpair neither copies
nor keeps them. Move what you want to keep to a destination you own. Resolve a
relative path in Grok's context, not your own cwd; if the base is unclear, ask
the same collaborator for the absolute path.

## Review a native worktree

Tool: grok_spawn

```json
{
  "task": "Implement the duplicate-request repair in the uploader with regression tests. Change only those files, run the relevant tests and report what you observed. Do not commit, push or publish. I am checking timeout behavior separately.",
  "cwd": "/absolute/path/to/repository",
  "worktree": true
}
```

Grok's `worktree create` provisions the tree before the collaborator starts.
Its default includes HEAD and uncommitted work under native copy rules, not
a byte-exact copy of all ignored, untracked or generated files. It may affect
source or Git metadata; it need not use any particular Git linkage or branch
form. Do not assume missing caches, dependencies or configuration were copied,
and do not silently copy them yourself to broaden the brief.

The summary distinguishes the source and execution locations, for example:

```json
{
  "cwd": "/work/service/packages/uploader",
  "worktree": true,
  "worktree_root": "/native/worktrees/retry-review",
  "execution_cwd": "/native/worktrees/retry-review/packages/uploader",
  "sandbox_argument": null,
  "sandbox_observation": {
    "status": "unavailable",
    "reason": "Native ACP does not report the resolved sandbox or its enforcement."
  }
}
```

`execution_cwd` stays null until supplied to an observed provider process;
provisioning can return a path before that. A source subdirectory must map to
the same repository-relative location in the new tree. Missing suffixes and
native fallback to the root are rejected before launch. Non-Git isolation
fails instead of running in the source directory. A verified native creation
may live beneath Grok's protected home without admitting arbitrary caller
paths there.

When Grok reports a change to `src/uploader.ts`, inspect it relative to
`execution_cwd`, not your source checkout. Inspect the native tree's actual
Git state, including new, untracked and binary files, and compare with the
source state you delegated and your current work. Native copied changes were
already present; do not attribute every diff to the collaborator. A reported
test pass is Grok's observation; run relevant checks yourself before adopting.

Provisioning receives the same optional sandbox argument as the later
conversation, but the source and execution directories can resolve different
profile definitions and grants. A refusal is not retried permissively. A
returned directory stays reported even after a later failure; an unknown
provisioning result must be reconciled before another creation. Follow-up and
explicit resume reuse the same directory; missing context is a failure, not a
fresh worktree or source-directory fallback.

grokpair never applies, removes or garbage-collects native trees. Integration
is your decision and your action. Closing does not itself delete the tree,
but Grok owns its retention policy; preserve useful changes at an authorized
destination rather than treating the path as permanent storage.
