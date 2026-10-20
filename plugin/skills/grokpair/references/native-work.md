# Native jobs through the collaborator

Grok owns its tools, skills, integrations, memory and configuration. Describe
the result you need and supply its real sources; Grok's native workflow does
the work. grokpair is not a second media API or a catalog of Grok's tools, and
your own loaded skills and context do not carry over.

## Match the brief to the job

| Job | A useful brief gives | Accept it when |
| --- | --- | --- |
| Engineering | The exact problem, source locations, which files Grok owns, the checks that matter. | The reasoning holds against the source, the real changes are right and you observed the tests. |
| Web research | The question or decision, which authorities count, how recent. | Sources support the claims, with dates, and claims are kept apart from inference. |
| X research | Keyword or semantic search, an account or an exact thread, known IDs or links, the time window. | The actual posts and thread context are there; result counts do not prove full coverage. |
| DOCX, PPTX, PDF | Audience, content, editable or final format, destination, sources. | The contents are right, representative pages render well and it is editable where needed. |
| Images and editing | Composition and use, or the real visual references and what must stay fixed. | You looked at the image and its fidelity to the references. |
| Video | A starting frame or references, motion and camera, duration, audio intent. | You played all of it: continuity, start and end, identities, audio. |

State limits on sources and effects where they matter. An integration being
available authorizes neither disclosure nor changes, and Grok's memory is its
context, not verified evidence. Avoid restrictions that stop Grok's workflow
from producing the result you asked for.

## Interpret native capabilities

When Grok starts, the records view receives a `native_capabilities` record
with `protocol_version`, `agent_info` (possibly null) and Grok's exact
`capabilities`, including `_meta`. It is evidence of what Grok announced, not
a list of what it can do. `native_options` holds the current model and effort
choices. Both are session-wide: a `prompt_id`-filtered read leaves them out.
No probe or calibration turn is needed before real work.

| Field or input | What it means for you |
| --- | --- |
| `promptCapabilities.image: false` | Grok Build 1.0.30 announced this while its image input worked. Send visual input as `kind: "image"` regardless; this is not a promise that every image succeeds. |
| `_meta["x.ai/capabilities"].toolOverrides.x_thread_fetch` and `.x_user_search` false | These X tools ignore the date window. The flags do not say the tools are missing. |
| `.x_keyword_search` and `.x_semantic_search` true | These X tools apply the date window. |
| Audio input | Grok's prompt parser rejects audio blocks and grokpair has no audio kind. The image mismatch is not a reason to ignore every false flag. |

A task beginning with `/name` can run a native session command, skill or saved
workflow. Such commands are not necessarily model instructions: `/session-info`
has returned session information without a model turn. Commands that change
permissions or configuration need authority for those effects. Native built-in
commands can ignore grokpair's appended guidance and attachments, so do not
rely on those to constrain a command. Ordinary tasks use a prose brief;
UI-only shortcuts, dialogs and dictation remain outside the ACP surface.

## Search controls

Tool: grok_spawn

```json
{
  "task": "Compare this repository's stream implementation with the current official Node.js documentation. Cite sources and separate documented claims from reproduced behavior. Do not change files. I am checking error propagation separately.",
  "cwd": "/absolute/path/to/repository",
  "search": { "webSearch": { "allowedDomains": ["nodejs.org"] } }
}
```

Web search takes at most five allowed or excluded domains, and an allow list
and an exclude list cannot both be set; these are Grok's limits. X date bounds
use an inclusive `fromDate` and an exclusive `toDate`, both at 00:00 UTC, and
apply to keyword and semantic search only. Both engines can be set together.
An omitted engine or an empty object keeps Grok's settings; nested nulls mean
omission; only `webSearch: null` or `xSearch: null` clears that engine's
override. None of this forces a search, acts as a firewall or proves coverage.

Tool: grok_send

```json
{
  "agent_id": "agent_12345678-1234-4123-8123-123456789abc",
  "task": "Reassess with Grok's default web search, keeping the same question and evidence standard.",
  "search": { "webSearch": null }
}
```

## Documents

Pass source documents, including Office files and PDFs, as `reference`:
Grok's readers and skills do the extraction and authoring. When a DOCX or PPTX
must embed an image's original bytes, pass that image as `reference` so the
document tool reads the original; add it as `image` too only if Grok must also
see it, since the visual copy may be normalized.

Tool: grok_spawn

```json
{
  "task": "Create decision-brief.docx plus decision-brief.pdf in this directory from the attached notes, using the relevant native skills. Keep the assumptions and open questions; invent no figures. Inspect the rendering and return the files and any rendering limits to me, the calling agent. Leave the notes unchanged and do not contact anyone or publish. I will check the recommendation myself.",
  "cwd": "/absolute/path/to/research-directory",
  "attachments": [{ "path": "/absolute/path/to/research-directory/decision-notes.md", "kind": "reference" }]
}
```

For a deck, give the audience, whether it is presented or read, what content
is fixed and the storyline. Check overflow, chart labels, images and
editability yourself: an export receipt says nothing about layout.

## Images and video

Put a text-to-image brief in the task. For editing, image-to-video and
reference-to-video, attach the real source images as `image` and say which
image plays which role. There is no grokpair media object or parameter
catalog.

Image editing can refer to `[Image #1]`, an input of the current turn; that
reference does not survive into a later turn. Video operations do not resolve
`[Image #1]`: they need an actual image path, HTTPS URL or data URL. Grok's
`<image_files>` context lists the actual normalized paths, whose names may
differ from your originals. In a reference-to-video prompt, `<IMAGE_0>` marks
a reference's position; it is not a path. So for image-to-video, have Grok
pass the normalized path from `<image_files>`, not either marker.

Tool: grok_spawn

```json
{
  "task": "Edit the attached observatory image: add warm window light, and keep the architecture, coastline, framing and every other object unchanged. Use native image editing, save observatory-lit.png in this directory without replacing the original and return its path to me. Do not contact anyone or publish.",
  "cwd": "/absolute/path/to/visuals",
  "attachments": [{ "path": "/absolute/path/to/visuals/observatory.png", "kind": "image" }]
}
```

Text-to-video is two native steps: make a first frame from the scene brief,
then animate it. Image-to-video lasts six or ten seconds; reference-to-video
one to fifteen. With several references, say which one gives the environment,
the subject and the style.

Tool: grok_spawn

```json
{
  "task": "Animate the attached image for six seconds: a slow camera approach to the observatory, stable architecture and coastline, gentle ocean and cloud motion. Pass the image's normalized path from your image_files context to image-to-video, not [Image #1] or IMAGE_0. No text or narration; natural ocean sound. Save observatory.mp4 in this directory and return its path and any limitations to me. Leave the source image unchanged; do not contact anyone or publish.",
  "cwd": "/absolute/path/to/visuals",
  "attachments": [{ "path": "/absolute/path/to/visuals/observatory.png", "kind": "image" }]
}
```

A video or audio file can be passed as a `reference` for a suitable native
tool. A reference is a path, not audio the model hears: grokpair has no ACP
audio input kind or media-generation API of its own. Audio work may still be
delegated when Grok's available tools can perform it; describe the result and
let Grok use those tools without inferring capability from video audio alone.

Requested resolution, duration, ratio or fidelity is intent, not proof. Open
the image and play the whole video before accepting them.

## Background tasks

A `background` record is keyed by Grok's real `task_id` and keeps what was
observed as `observations.backgrounded` and `observations.completed`, each
with its method and full payload. Several tasks stay distinct. The turn ending
does not mean a background task ended: while its result matters, keep waiting
with a cursor that has no `prompt_id` filter (background records are
session-wide), and wait wakes when the task changes.

For example, a backgrounded payload might name `task_id: "task-render-1"` and
`output_file: "/native/session/work/render.log"`, and its completion carries
`task_snapshot` with the same id, `exit_code`, `signal` and some output. If
that output is not enough to judge the result, ask the same collaborator to
read the file instead of rerunning the job:

Tool: grok_send

```json
{
  "agent_id": "agent_12345678-1234-4123-8123-123456789abc",
  "task": "Background task task-render-1 completed, but its retained output is not enough to judge the render. Read its output_file /native/session/work/render.log and return the relevant diagnostics and the paths of the outputs. Do not rerun the render; if the file is missing or incomplete, say so."
}
```

Use the real task, file and agent. A failed job can still leave useful
output, and output you could not inspect stays a limit to report, not a result
to certify.
