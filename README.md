# grokpair

grokpair gives a calling agent a detached Grok Build collaborator: disposable
intelligence and extra arms. The caller hands Grok a bounded contribution (a
research question, a review, a candidate implementation in an isolated
worktree, a document or media), keeps working, then reads what Grok said and
made and decides what to adopt. Grok runs with its own identity,
configuration, model, tools, skills and conversation, so the caller's context
pays only for the brief it writes and the answer it reads. The caller keeps
acceptance, integration, credentials, commits, publication and every claim.

**2.3.1 · schema 3 · runtime-v2 · SQLite format 1 · cursors gp1.**
[PLAN](PLAN.md) describes the implementation and known limits;
[RELEASE](RELEASE.md) distinguishes source qualification, distribution and
useful host acceptance.

## Requirements

- Node `>=24.21`, as `node` on the `PATH` the host gives the server. A
  running server whose Node executable an upgrade removed starts its workers
  with the `node` on that `PATH` instead.
- [Grok Build](https://docs.x.ai/build/overview), installed, authenticated
  and callable as `grok` on that `PATH`. Follow its native setup guide;
  grokpair does not install Grok or manage its login.
- Git and a source repository, only for native worktree isolation; Grok's
  utility owns its creation prerequisites.

Bring your own authenticated Grok Build account. Inference and connected
services use that account and its native billing; grokpair provides no account,
hosted backend or included usage. The committed `plugin/` payload is already
built and needs no dependency installation to run. Contributors need the
pinned pnpm and the lockfile; see [AGENTS](AGENTS.md#build-test-and-inspect).

## Install

Install an annotated release tag from this repository's `grokpair`
marketplace. These commands select **2.3.1**.

**Codex**

```bash
codex plugin marketplace add Tiziano-AI/grokpair --ref v2.3.1
codex plugin add grokpair@grokpair
```

Codex gets the MCP server `grokpair` and the operating skill.

**Claude Code**

```bash
claude plugin marketplace add Tiziano-AI/grokpair@v2.3.1
claude plugin install grokpair@grokpair
```

Claude Code gets the tools as `mcp__plugin_grokpair_grokpair__grok_*`, the
operating skill, the relay agent `grokpair:grok`, and the `grokpair` command
on its Bash tool's `PATH`.

**Approvals are yours:** all eight tools follow the host's normal policy.
grokpair ships no auto-allow hook or approval override and does not change
your settings. Choose any standing approvals in your own host, within the
authority you want to delegate.

**Any other MCP host** can start `node /absolute/path/to/grokpair/plugin/bin/grokpair mcp`
from a checkout as a stdio server; give its tool calls a timeout above 600
seconds, the longest wait. **Any agent with a shell** can run
`node /absolute/path/to/grokpair/plugin/bin/grokpair <tool> '<json>'`.
Run `version` first to identify that checkout; using it directly is not a
native plugin installation.

**Grok Build** loads the plugins installed for Claude Code, and grokpair must
not be offered to Grok itself. Where grokpair is installed for Claude Code,
disable it for Grok in `~/.grok/config.toml`:

```toml
[plugins]
disabled = ["grokpair"]
```

If `[plugins]` or `disabled` already exists, add `"grokpair"` to the existing
list; preserve its other entries.

Independently, a grokpair started beneath a collaborator serves no tools.

All hosts share one store at `~/.local/state/grokpair`. `GROKPAIR_HOME`
overrides it; set it for every host or for none, or each host will see its own
collaborators. Installing a new version does not reload servers already
running in open sessions. A host can replace cache directories while a
session retains a previous MCP binding. If that binding's launcher is no
longer available, spawn answers `worker_unavailable` without admission;
obtain a newly resolved binding through the owning host. A version-shaped
path or a connected registry alone does not prove that its files remain
available for worker launch.

Schema 3 retains the runtime-v2 store, not a second runtime namespace. Replace
old consumers only at a verified quiescent cutover: retire their callable
entrypoints through the owning hosts and account for their collaborators,
pending decisions, workers and native processes before admitting new writers
through the package. Installation alone does not fence old processes or
authorize closing their work. See [RELEASE](RELEASE.md) for the delivery procedure.

## First use

In your calling agent, ask: “Use grokpair for a read-only second opinion on
this question while you continue your own analysis. Give Grok the relevant
sources and boundaries, read its complete answer, and check the findings
before adopting them.” The agent should follow the installed operating
skill. The tool-level cycle is shown below.

Grok does not see your conversation. Write a self-contained brief: purpose,
facts and sources, the result you need, and limits on files and effects. Point
`cwd` at the real directory the work is about; it need not be a Git repository.

Start the collaborator with `grok_spawn`:

```json
{
  "task": "Create comparison.docx in this directory from the service proposals and requirements.md. Recommend one with source evidence and the strongest countercase. Inspect the rendered document and return the file and your findings to me, the calling agent. Leave source files unchanged; do not contact anyone or publish.",
  "cwd": "/absolute/path/to/research-directory",
  "key": "service-proposal-document-7f3a"
}
```

It returns `agent_id` and `operation_id` at once, not the answer. The `key`
makes an identical normalized retry return the same collaborator instead of
a second one, with `call_status: "existing"`, its `agent_id` and no
`operation_id`; wait on it by `agent_id` either way.
Reusing a held key with a different brief, attachments, model, effort, search
or placement selection returns a conflict instead of retargeting it. Change
existing work with `grok_send`. Missing or unreadable original state retains
the key; it is not permission to start a duplicate.

Without `worktree`, Grok works in `cwd`. Add `"worktree": true` when the
contribution needs a separate native Git worktree; native copy rules include
uncommitted work but do not promise to copy every file. Add `"sandbox":
"<native profile>"` only for an intentional profile selection. Otherwise no
sandbox flag is passed and Grok resolves its configuration, which may be
`off`. File placement and sandbox selection are independent; the brief still
defines file and effect authority. The returned summary distinguishes the
input directory, observed execution directory, native worktree root and
requested sandbox argument; effective enforcement is not observable through
ACP. A denial is returned, not worked around.

Do your own work, then collect the result with `grok_wait`:

```json
{ "targets": [{ "agent_id": "agent_…" }], "timeout_ms": 300000 }
```

By default it returns once Grok has settled, with each turn's text and outcome,
any question Grok is waiting on, files, issues and background tasks. A turn
that has stopped running can also name `text_file`, a current file in the store holding
its complete text, which you or any tool can open later without grokpair. A
timeout leaves Grok working; wait again with the returned `cursor`. While
`has_more` is true, continue with `grok_read`:

```json
{ "agent_id": "agent_…", "cursor": "gp1.…" }
```

Large structured records arrive as explicitly incomplete JSON `fragments`;
continue with the same cursor until complete before interpreting a request
or responding. No extra file or archive is needed. A constrained multi-target
wait can omit targets: update only returned IDs' cursors, keep omitted
targets' original cursors, and put omitted targets first in the next wait.
If a host shortens a response, reread from the preceding cursor with a smaller
`max_chars`. The [operating skill](plugin/skills/grokpair/SKILL.md) explains
reconstruction and record-version changes.

Follow up with `grok_send` when it improves the result, inspect real files and
changes before using them, and `grok_close` the collaborator when it no longer
helps; closing deletes nothing.

The same cycle from a shell, keeping `timeout_ms` below the shell tool's own
timeout and waiting again as needed:

```bash
node /absolute/path/to/grokpair/plugin/bin/grokpair spawn '{"task":"Create comparison.docx from the sources here; inspect its rendering, leave sources unchanged and return the file to me without contacting anyone.","cwd":"/absolute/path/to/research-directory","key":"service-proposal-document-7f3a"}'
node /absolute/path/to/grokpair/plugin/bin/grokpair wait '{"targets":[{"agent_id":"agent_…"}],"timeout_ms":90000}'
node /absolute/path/to/grokpair/plugin/bin/grokpair read '{"agent_id":"agent_…","cursor":"gp1.…"}'
# Inspect the complete answer and real files; request corrections with send if needed.
node /absolute/path/to/grokpair/plugin/bin/grokpair close '{"agent_id":"agent_…"}'
```

In Claude Code, the relay agent does the whole cycle in the background: ask
for the `grokpair:grok` agent with the brief, and it returns Grok's answer
verbatim with the `agent_id`, cursor and each turn's `text_file`. In auto
permission mode that report reaches you through Claude Code's subagent
hand-back, after its classifier reviews it, and the Agent result itself is only
a short note. It leaves the collaborator open so you can inspect actual
artifacts and request corrections in the same conversation. You close it
after acceptance, or the relay can close it when the brief explicitly asks
for a one-shot contribution. Native worktree retention remains Grok's own
policy; preserve useful work where you are authorized to keep it.

## Disable or uninstall

Use your host's native plugin controls. Removing a plugin stops future
discovery; it does not close detached collaborators, erase results, delete
native sessions or worktrees, revoke Grok credentials, or unload servers that
an existing session already started. Inspect and explicitly close work you
intend to end before removing its callable entrypoint. Close can cancel active
work and deletes no retained data. Native state and connected-service
retention remain with their owners; [PRIVACY](PRIVACY.md) describes the store.

Remove the `grokpair` plugin registration and, if no longer needed, its
`grokpair` marketplace through the owning host. Verify in a fresh caller that
grokpair is no longer offered. Existing sessions may retain a loaded server;
removing files does not establish that it has exited.

## Read further

- [Operating skill](plugin/skills/grokpair/SKILL.md): the collaboration cycle
  as callers use it.
- [VISION](VISION.md): what the product is for and what makes a contribution
  useful.
- [ARCH](ARCH.md): design, invariants, packaging and source owners.
- [Capabilities](docs/capabilities.md): the complete public contract.
- [SECURITY](SECURITY.md), [PRIVACY](PRIVACY.md), [TERMS](TERMS.md):
  authority, retained data and terms.
- [PLAN](PLAN.md), [RELEASE](RELEASE.md), [CHANGELOG](CHANGELOG.md):
  implementation and proof, delivery, changes.
- [AGENTS](AGENTS.md): working on grokpair itself.
