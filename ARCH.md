# grokpair architecture

```text
calling agent (Codex, Claude Code, any MCP host, any shell)
  -> grokpair mcp  |  grokpair <tool> '<json>'     one service, eight tools
  -> SQLite mailbox per collaborator (+ shared key registry)
  -> one resident detached worker per collaborator
  -> official ACP SDK
  -> grok agent stdio
```

grokpair is a thin bridge. It admits a caller's action into a transactional
mailbox, hands it to one resident worker that holds the only connection to
Grok, and retains what Grok actually did so the caller can read it later. Grok
does the work. The bridge translates and retains native facts; limits follow
real native or protocol boundaries rather than wrapper policy, and an honest
"unknown" is preferred to an inferred answer. [VISION](VISION.md) says why the
product exists; [docs/capabilities.md](docs/capabilities.md) owns the exact
public contract.

## Contract versions

| Contract | Current | Owner |
| --- | --- | --- |
| Product version | 2.3.1 | `package.json` |
| Public schema | `"3"` | `PUBLIC_SCHEMA_VERSION` in `src/core.ts` |
| Runtime contract | 2, directory `runtime-v2` | `RUNTIME_CONTRACT` in `src/agent-store.ts` |
| SQLite format | 1 | `src/agent-store.ts` |
| Cursors | `gp1.` for read and wait, `gp1.list.` for list | `src/agent-service.ts` |
| Node floor | `>=24.21` | `package.json` engines |

These are separate contracts that change independently. A runtime-contract
change starts a new store directory; there is no migration, compatible reader
or old-runtime lookup.

Schema 3 changes held-key matching and bounded read/wait delivery. Runtime-v2,
SQLite format 1 and existing cursors are retained, with no store migration or
replay. Replacement requires a verified quiescent cutover of old consumers,
not mixed old and new writers. MCP remains on the maintained v1 SDK and
existing stdio protocol.
MCP SDK v2 and modern protocol serving are
held until the intended hosts support them as stable and Tiziano reopens that
work; no split-package path, experimental host flags or compatibility layer is
part of grokpair.

## Why a bridge of this shape

The residual responsibility is detached collaboration, not model execution:

- The caller needs a stable `agent_id` across independent calls, full output
  after caller loss, follow-up in the same conversation and exact native
  decisions. A one-shot subprocess cannot carry that job alone.
- One resident ACP connection carries native steer, side questions, queue
  controls, permissions and plans. The official SDK owns framing and RPC;
  the bridge owns translation and retained outcomes, not a second transport.
- SQLite commits admission before dispatch and keeps uncertain effects
  uncertain. A shared key registry prevents duplicate spawn retries without
  making the MCP server a broker daemon.
- CLI and MCP call the same service. Host plugins only expose that core and
  teach its collaboration cycle; per-host lifecycle implementations would
  create competing owners.

An upstream native feature can replace one of these responsibilities when it
preserves the required semantics. A similar feature name is not enough.

## Native ownership and transport

Grok owns authentication, its home and configuration, profile, approval
policy, model, reasoning, tools, instructions, skills, sessions, conversation,
compaction, queue and background jobs. The bridge does not clone native state,
supply a replacement system prompt or force an approval behavior.

The conversation executor is `grok --cwd <execution_cwd> [--sandbox <name>]
agent --no-leader stdio`, resolved from the worker's `PATH` and driven through the
official ACP SDK: `client().connect()` and `ndJsonStream` own framing,
serialization and RPC routing. There is no parallel parser, relay, alternate
REST executor, daemon, watchdog, lease, replay loop or per-turn provider
restart. The worker is started detached with no stdio, as its own session
leader, so a caller's terminal never reaches Grok.

ACP SDK 1.8.0's stable v1 entrypoint supplies that connection. Its incoming
NDJSON framing defaults to a 32 MiB message limit introduced after the
previously pinned 1.5.0. The adapter explicitly passes
`maxMessageBytes: Number.MAX_SAFE_INTEGER` to official `ndJsonStream` rather
than introduce that smaller cutoff into existing large-output behavior.
The option requires a positive safe integer and does not accept `Infinity`.
It is a finite framing ceiling, not a claim of unlimited allocation or memory
safety, and it does not impose an outgoing-frame limit. The deterministic
peers use the same setting so large encoded image prompts exercise the real
official framing path.

The worker passes Grok the environment the server received, plus
`GROKPAIR_COLLABORATOR=<agent_id>`. The package supplies no environment
defaults of its own.

The optional `sandbox` string is passed as the exact native profile name.
Omission means no `--sandbox` flag: Grok resolves its own requirements,
environment and configuration, which can select `off`. Worktree placement
does not select a profile. Native project profile definitions resolve at the
actual execution directory and may differ from the source directory's
definitions. Native tool permissions and sandbox selection are separate.
The bridge records `sandbox_argument` as the requested string or null, not as
an effective policy. ACP startup does not report resolved profile or
enforcement, so `sandbox_observation` remains unavailable; process liveness,
stderr and a separate inspection process cannot establish it.

With `worktree: true`, the same admitted launch first runs
`grok --cwd <source_cwd> [--sandbox <name>] worktree create`, then starts the
conversation executor in the validated returned directory. Provisioning has
its own recorded intent, process identity and result; it is not an ACP turn.
The requested sandbox selection is identical for both launches, but their
directory-specific grants need not be. A denial never triggers a more
permissive retry. Failed ACP startup retains its diagnostic stderr and exit
outcome, with any truncation disclosed; successful initialization discards
that capture rather than retaining a native-output archive.

## Hosts and packaging

`scripts/manifests.mjs` is the one owner of host packaging. From
`package.json` it generates, on every `pnpm build`:

- `plugin/.codex-plugin/plugin.json`, the Codex manifest, with the server
  inline (`./bin/grokpair mcp`, cwd the plugin root, `startup_timeout_sec` 30,
  `tool_timeout_sec` 660) and the skill directory;
- `plugin/.claude-plugin/plugin.json`, the Claude Code manifest, with the
  server inline (`${CLAUDE_PLUGIN_ROOT}/bin/grokpair mcp`, timeout 660,000 ms);
- `plugin/package.json`;
- `.agents/plugins/marketplace.json` and `.claude-plugin/marketplace.json`,
  the two marketplaces, both named `grokpair` and serving `./plugin`.

`pnpm validate` fails on approval overrides, packaged hooks, drift from the
generator, or `plugin/.mcp.json`, which Claude Code would load beside the
manifest's inline server. The 660-second tool timeout covers the longest
public wait with a transport margin.

Tool approval stays with the host's normal policy. No plugin hook or manifest
field grants standing approval; a user can choose that in native host settings.

Codex starts stdio servers with a minimal environment, so its manifest
forwards exactly the variables that say where Grok, its configuration and its
credentials are (`GROK_HOME`, `GROK_CONFIG`, `GROK_CONFIG_PATH`, `GROK_SANDBOX`,
`XAI_API_KEY`) and where the homes grokpair protects are (`GROKPAIR_HOME`,
`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`), each present or
absent as in Codex's own environment. Claude Code passes its own environment
to the server. Grok's settings belong in its configuration file, which Grok
reads alike whichever host started it. A Grok setting exported only in a
shell reaches Grok only through a Claude Code command line started from that
shell: Codex forwards just the names above, and the desktop apps take only
PATH from the login shell.

The rest of `plugin/` is hand-authored or built:

| Path | Role |
| --- | --- |
| `plugin/bin/grokpair` | The two-line Node launcher every host and the shell run. |
| `plugin/lib/grokpair.js` | The bundle `pnpm build` makes from `src/`. |
| `plugin/schemas/grokpair-tools.schema.json` | The generated tool descriptions and input schemas. |
| `plugin/skills/grokpair/` | The operating skill with its references; Codex reads only the frontmatter name and description plus `agents/openai.yaml`. |
| `plugin/agents/grok.md` | The Claude Code relay agent `grokpair:grok`; Codex ignores it. |
| `plugin/LICENSE` | The authored license copied by the build into the installed payload. |
| `plugin/THIRD_PARTY_NOTICES.md` | License and notice texts generated from packages contributing bytes to the bundle. |

The notices owner is `scripts/bundled-notices.mjs`; it includes esbuild's
injected runtime helpers, which have no package input in its metafile. The
build fails if a contributing package has no license text. Installed and tree-shaken packages
are not listed merely because they exist in `node_modules`.

Claude Code loads the skill and the agent automatically and puts
`plugin/bin` on its Bash tool's `PATH`, so a shell agent can call
`grokpair <tool>`. It names the tools `mcp__plugin_grokpair_grokpair__grok_*`;
`pnpm validate` checks that the relay agent lists exactly those eight.
Claude Code backgrounds a long MCP call only in the interactive CLI's main
conversation, while subagents, Workflow stages, print mode and the Desktop
Code tab block for the whole wait, which is why the relay agent runs in the
background. In auto mode Claude Code delivers a relay agent's
report through its hand-back, after the classifier reviews it.

Any other MCP host can start `grokpair mcp` itself. Releases are annotated
`vX.Y.Z` tags because both hosts pin a marketplace by Git ref;
[RELEASE](RELEASE.md) owns delivery.

## Entry points and the recursion guard

`src/agent-main.ts` is the one entrypoint. `mcp` serves the eight tools over
stdio through MCP SDK v1 with `maxBufferSize: Infinity`;
`<tool> [json | -]` runs one call and
prints its result; `schema` and `version` describe the package;
`internal-worker` is how the service starts a worker. Both the server and the
command line call `AgentService.invoke`, so a tool and its command take the
same input and return the same object. The server publishes no server-wide
instructions: hosts can repeat those before every tool, so each description
carries its own use and recovery, and the collaboration cycle lives in the
skill. Claude Code cuts tool descriptions at 2,048 characters, so each stays
below that.

Grok Build loads the plugins installed for Claude Code, so a Claude install of
grokpair would reach every Grok session on the machine, collaborators included.
Two independent lines keep a collaborator from recursing into grokpair. Where
it is installed for Claude Code, disable it in Grok's own configuration
(`[plugins] disabled = ["grokpair"]` in `~/.grok/config.toml`). Independently,
each worker starts Grok with
`GROKPAIR_COLLABORATOR` set, which Grok passes to its MCP servers and tools: a
grokpair server started with it registers no tools at all, the command line
refuses every tool call, and `internal-worker` refuses to run, so a
collaborator's Grok cannot become another collaborator's worker. Registering
nothing, rather than refusing only spawn, matters because read, list, send,
interrupt, respond and close would otherwise reach other collaborators in the
shared store.

## Durable state and lifecycle

The store base is `GROKPAIR_HOME`, or `~/.local/state/grokpair` under the
canonical account home. It is the same for every host and deliberately not
inside any one harness's home; a host that sees a different `GROKPAIR_HOME`
sees a different store. `runtime-v2` is appended once and holds
`agents/<agent_id>/agent.sqlite` per collaborator, its turn text files under
`agents/<agent_id>/turns`, and `keys.sqlite`, the spawn-key registry. Store
directories are created with mode 0700, and collaborator databases and turn
files with 0600. Before any record is read, a collaborator database's
runtime contract and format are checked, and its directory and file identity
are attested around every transaction.

Each collaborator database retains admissions, outcomes and effects, authentic
root text, side answers, attention, the latest queue, options and initialize
capabilities, background tasks, file references and diagnostics. It is not a
raw ACP, reasoning or complete tool-output archive. Records are current
semantic owners, not an append-only journal: a changed value replaces the
earlier one and moves forward in the change order, which is what cursors
follow. Each change also advances a wake counter unless it is a text chunk, a
running-turn notice or another non-meaningful step, so waits wake for
meaningful changes rather than every chunk.

When a turn stops running (completed, cancelled, or `unknown` because its
worker was found gone at close or resume), the store also writes the turn's
complete root text to a file under `agents/<agent_id>/turns/`, named by the
prompt ID when it is a plain lowercase file name and by its SHA-256 otherwise.
The file is written through a temporary file and a rename, after the
transaction that stopped the turn commits, so it never describes state the
database rolled back; text arriving for a stopped turn rewrites it. Front
matter with JSON-scalar values names the collaborator, prompt, status, input
cwd, execution_cwd, worktree_root, sandbox_argument and unavailable
sandbox_observation, plus the operation and brief when grokpair sent the
prompt and the stop reason when known. The text blocks follow joined as the
result view joins them. The database
stays authoritative: a failed write produces no error. A file is offered as
`text_file` only when its bytes match the current turn; a stale file left by a
failed rewrite is withheld, including after reopening the store. The
file lets a caller, or any tool or person, reopen a turn's complete text
without grokpair and without paging, after crashes, restarts and close. A turn
cut off by a crash keeps its text in the database and gets its file when the
collaborator is closed or resumed. It is the only file grokpair writes besides
its SQLite databases, and it holds root text only. Worktrees are created and
retained by Grok outside this store.

Admission stores the operation and, for spawn and resume, the launch
reservation in one transaction, before any process can start. The worker
claims the reservation with its exact process identity (PID and birth time)
before starting Grok, and the claim records Grok's identity once it runs.
Operation start is recorded before the SDK call; a lost outcome stays
`outcome_unknown` and never becomes retry authority. Elapsed time never
supplies takeover authority.

Status is derived passively from this state by `src/agent-state.ts`; the worker
maintains no status mirror. A reserved launch reads `starting` only while it
may still be claimed: while its recorded worker or, when none was recorded,
the process that reserved it (the MCP server or the command-line process) is
not proved gone. Otherwise it reads `disconnected` and can be resumed with a
new `follow_up` and `resume: true`. This covers a reserving process that died
before it launched a worker. A worker child that cannot be created, or that
exits before claiming its launch, fences the launch at once: the operation
settles `not_sent` and the collaborator reads `disconnected`.

A worker is this server's own bundle run by Node, and a long-running server can
outlive both: a host update removes a superseded plugin folder, and a
package-manager upgrade removes the versioned executable that
`process.execPath` resolved to when the server started. The server therefore
runs the worker with its own executable while that exists, and otherwise with
the `node` its launcher (`#!/usr/bin/env node`) would find on the server's
`PATH` now, searching only absolute entries because the worker starts in the
collaborator's directory. Spawn and resume check both before anything is
recorded and refuse with `worker_unavailable` and `admission: "none"` when the
bundle is gone or no Node is found, so no collaborator or key is left behind.
The launch resolves them again; a removal between the check and the launch
still fences the launch with its exact diagnostic.

The worker survives the caller and its host. Read and wait are passive. Only
an explicit new `follow_up` with `resume: true` continues a collaborator, and
only after the exact predecessor worker and Grok process are proved absent;
unknown identity is not absence, and a native session identity cannot be
reconstructed by guessing. Resume settles the predecessor's unfinished work as
not sent or unknown and never replays it.

Close may cancel active work and has no prior-read gate. It fences an
unclaimed launch so a late worker cannot start, retires a proved-absent
resident without starting anything, and keeps native closure and process exit
distinct. Unknown identity blocks close and resume. Close deletes no text,
native session, file or worktree, and cannot repair older uncertain effects.

**Keyed spawn.** `keys.sqlite` maps a caller key to the collaborator last
spawned with it. Spawn observes the key's holder outside the registry's write
lock, so the lock is never held while a holder's state is read, and commits a
claim only if the key still names the holder it observed; two callers racing
on the same key therefore admit one collaborator. A holder that is proved
closed releases the key. Missing or unreadable state does not: unknown is not
closed, and grok_list by key still shows that holder as unavailable.
An existing holder is returned only when the full normalized request matches
the immutable input of its initial operation, not its current configuration
or a later resume. Omitted worktree equals false and omitted attachments
equal an empty list; all other supplied values and omission remain exact,
including search omitted versus `{}`. A different request conflicts; an
unverifiable original returns an explicit error and retains the key. A failed
startup does not release the key or replay provisioning.

## Public protocol and views

Eight tools: `grok_spawn`, `grok_send`, `grok_wait`, `grok_read`, `grok_list`,
`grok_respond`, `grok_interrupt` and `grok_close`. Input schemas are closed,
and results use one JSON text carrier without a duplicate structured copy or
output schema. `SEND_ACTION_MATRIX` in `src/agent-schema.ts` owns send
validation, action descriptions and public input examples.

Mutations return a compact admission receipt, never output. Read and wait
return pages whose first fields are `agent_id`, `status`, `cursor` and
`has_more`, followed by the summary and the body. Fragment pages use only
those four header fields and `fragments`, with `fragment_reset` when an
incomplete version was replaced. The body has two views over the same records:

- **result** (the default) groups a page by what the caller acts on: each
  turn's text, status and stop reason linked to the operation that sent it,
  side answers, attention that is not resolved, files, issues, background
  tasks, operations that failed, were not sent or have unknown outcomes, and
  completed operations whose native outcome is `removedFromQueue`. A caller
  gets Grok's answer without reconstructing it from records.
- **records** is the full typed stream, including the queue, options,
  capabilities, elicitation completions, resolved attention and every
  operation.

Root text keeps its observed order, supplied message IDs and block
boundaries; thoughts, tool output and child activity are never promoted into
it. Side answers stay keyed by their operation. Queue, options and
capabilities are latest-value observations, revised when they change rather
than replayed. A missing queue observation never implies an empty queue.
Background tasks are kept per real native task ID with their start and
completion payloads. Issues are not pruned, and diagnostics keep the actual
native failure variants and causes, not stdout or successful output.

## Reading, waiting and pagination

One opaque cursor per collaborator carries position, view, prompt filter, the
last seen wake counter and status. It serves both draining pages and later
waits, so a caller keeps a single handle. `max_chars` bounds the whole
serialized public JSON result a host receives: `JSON.stringify(result).length`
counts UTF-16 code units, including the envelope, header, grouping and escaping.
One snapshot freezes each page's projection metadata, including available turn
text files. Complete records are tried first; partial text is fitted against
the actual serialization without splitting valid surrogate pairs. Records a
view omits spend no budget. A retained structured record that cannot fit is
serialized into `fragments` with its record identity, type, offset, JSON text
and completeness. Existing sequence/change coordinates pin that version; a
changed version emits `fragment_reset` for the incomplete version and resumes
from its preceding checkpoint, preserving intervening changes rather than
mixing fragments. The replacement can arrive normally or as new fragments.
No export, archive or server-resident read state is created. Even a minimal
frame that cannot fit returns `response_budget_too_small` without advancing
the cursor; no whole-record oversized exception remains. The default is
32,000 characters, not a guarantee
against a host's byte or token limits;
[capabilities](docs/capabilities.md#pages) owns recovery from shortened results.

Wait polls its targets, reading each in its own snapshot, and returns when any
target has something new and, with `until: "settled"`, has stopped working,
needs an answer or became unavailable; with `until: "change"`, on any
meaningful update. Packing fits the entire wait response, includes the target
that justified the wake, and returns only the target pages actually delivered.
Excluded targets keep their input cursors unchanged; the caller rotates
delivered targets behind excluded ones when continuing a constrained wait.
There is no server fairness state. The deadline (at most 600,000 ms) bounds
waiting, not the task, and a timeout never stops work. One target's failure is
reported in its own entry without erasing the others.

## Native controls and attention

Follow-up adds rich work without requesting cancellation; native follow-up
scheduling stays native. Steer uses native safe-point interjection or a
priority new turn and never cancels. Send-now is priority work under native
Goal and queue semantics. Side questions produce separate operations and
answers. Queued edit replaces exact queued text and keeps image-only inputs
and the bridge's guidance block, refusing references rather than dropping
them. Configure applies model then effort and keeps partial effects without
inventing rollback. Interrupt without a prompt is session Ctrl-C; with one it
removes only the captured queued ID and version, with no retry or
session-cancel fallback.

Native `removedFromQueue` completes the prompt operation with its exact
response; it does not establish a cancelled turn. The native queue can remove,
combine or interject a prompt without executing it as an independent turn.
The correlated operation makes that prompt ineligible as autonomous queued or
running activity even if a previous queue snapshot or inferred running notice
is stale. No recipient turn is guessed from text or timing. Retained legacy
`removed_from_queue` turn records are not treated as authoritative cancellation.

Attention keeps the exact native method and full payload, and a response is
that method's native object, validated against what was offered. No wrapper
completeness, offered-only or cardinality rule replaces native semantics.
Exact prompt cancellation and native interaction closure expire only their
own pending requests, including late ones; normal completion expires nothing.
Queue removal expires nothing either, and `interaction_resolved` is closure,
not approval. Request abort, connection end and proved worker absence retain
their own lifecycle meanings.
An admitted answer not yet sent becomes `not_sent`; an uncertain one stays
uncertain.

## Inputs and workspace boundaries

Admission requires an existing absolute, normalized, canonical `cwd` with no
symlinks. The filesystem root, the exact account home and every protected
home are refused, with their existing aliases: the Codex home, the Claude Code
home, the Grok home, the Pi home and the grokpair store, each resolved from
its environment variable or default. A Git root derived for a worktree cannot
contain the account home or overlap a protected home, so a derived root never
widens authority. Ordinary work needs no Git and executes in `cwd`; the brief
states file and effect boundaries but is not a sandbox. The bridge neither
forces a profile nor directs ordinary output away from that directory.

`worktree: true` selects Grok's native `worktree create`, not a custom Git
adapter. Native defaults seed from HEAD plus uncommitted work under native
copy rules; this is not a byte-exact copy of all ignored, untracked or
generated material. Grok owns the source-copy semantics, possible source/Git
metadata effects, worktree location and retention. The bridge neither copies
missing dependencies nor calls native apply, remove or GC.

The native result must be a canonical directory in the observed worktree,
preserving the source cwd's repository-relative suffix. A native fallback to
the new root when that suffix is missing is rejected before ACP launch, as
is non-Git isolation; neither falls back to work in the source directory.
Verified native creation is the narrow exception to caller-supplied protected
home admission. A returned path is retained even if validation or startup
fails, and an outcome lost after provisioning started stays unknown rather
than becoming retry permission. Resume reuses the same admitted directory;
missing context is an error, never a fresh tree or source-directory fallback.

Summaries distinguish the input `cwd`, the native `worktree_root`, and
`execution_cwd`, which stays null until supplied to an observed provider
process. They keep the requested `sandbox_argument` and unavailable effective
`sandbox_observation`. Finished-turn headers carry the same distinctions.

Attachments need a path and an explicit kind. A reference passes the file's
exact URI without the wrapper reading, embedding, extracting or staging it;
an image's signature is checked before admission and its bytes are checked
again and base64-encoded by the worker. Grok owns decoding and conversion.
There are no wrapper count or size caps, no inferred kinds and no audio input
path. File records are mutable native references, never acquired or certified
artifacts, and deliverables are never manufactured by scanning the workspace
or parsing prose.

## Source ownership and delivery

| Boundary | Modules under src/ |
| --- | --- |
| Public protocol | core.ts, agent-schema.ts, agent-main.ts, agent-service.ts |
| Durable state and lifecycle | agent-store.ts, agent-state.ts, process.ts, worker.ts |
| Native adapter and decisions | native.ts, attention.ts |
| Workspace and inputs | filesystem.ts, workspace.ts |

This map, the `productionOwners` map in `scripts/validate.mjs` and the modules
in `src/` must agree exactly, each module in one group, and `pnpm validate`
fails when they differ. `src/filesystem.ts` owns the store location and the
protected homes, `src/agent-store.ts` the runtime coordinates, contract
constant and key registry, `src/agent-state.ts` the derived status, and
`src/agent-service.ts` views, cursors, wait and list. Outside `src/`,
`scripts/manifests.mjs` owns host packaging and `package.json` the product
version, Node floor, pinned pnpm and exact dependency pins. The build owns
`plugin/lib`, the generated schema and every generated manifest; they are
committed because both marketplaces install the committed `plugin/` tree. The
whole skill package is a primary product surface; its validator checks
resources, links and that its examples match the schema, not its prose.

The provider-free gates (build, test, validate, mcp:check, skill:validate,
native:check and the whitespace check) prove the source. Useful native
behavior, Grok's review, the tagged commit, installation through each host and
fresh use are separate observations that [PLAN](PLAN.md) and
[RELEASE](RELEASE.md) record.
