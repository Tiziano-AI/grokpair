# Current implementation and planned work

## Where it stands

The current source is **2.3.3**, with public schema 3, runtime-v2, SQLite
format 1 and `gp1.` cursors. It retains one execution core
and the same eight MCP/CLI tools. This version updates ACP SDK to 2.0.1,
Zod to 4.6.7 and pinned pnpm to 12.15.0 and raises the Node floor to
`>=24.22.1`. ACP remains on stable protocol v1; no MCP-v2 work is resumed
and no public or persisted contract changes.

The repository's [Git tags](https://github.com/Tiziano-AI/grokpair/tags)
identify published source revisions; the shared
[Tiziano AI catalog](https://github.com/Tiziano-AI/plugins) selects the
revision offered as **`grokpair@tiziano-ai`**. Neither selector establishes an
installed consumer's version. [RELEASE](RELEASE.md) records source checks,
installed identity and useful fresh-caller acceptance separately.

The implementation leaves approvals with each host's user-selected policy,
identifies the caller as another agent in native prompt guidance, rejects bad
image signatures before admission, validates native forms without schema-ID
collisions and includes legal texts in the installed payload.

Schema 3 adds exact full-request spawn-key identity, preserves native queue
removal without fabricating turn cancellation, fits the complete serialized
read/wait result and fragments oversized retained records through the existing
tools. Wait advances only cursors actually delivered. Mutable partial records
explicitly reset their obsolete representation and replay from the preceding
checkpoint without skipping intervening changes. No new runtime store,
archive, scheduler, artifact service or tool is introduced.

## Product and proof

A caller gives Grok a self-contained brief and an existing directory, keeps
working, then inspects the full contribution and requests corrections in the
same conversation. Grok owns native execution. MCP and CLI expose the same
eight tools through one service, a transactional SQLite mailbox and one
resident detached worker per collaborator using the official ACP SDK.

Ordinary work needs no Git. Optional worktree isolation uses Grok's native
creator, preserves the source subdirectory and retains provisioning outcomes
even if startup fails. Sandbox selection is independent; omission passes no
flag and can resolve natively to off. ACP does not report effective enforcement.
The bridge never applies, removes or garbage-collects native trees.

Public schema is 3; runtime-v2, SQLite format 1 and the `gp1.` cursor prefix
remain. An optional cursor field distinguishes JSON-fragment offsets from
existing text offsets. There is no migration or compatible reader for older
runtimes. The Claude relay leaves Grok open for parent inspection and correction
unless a one-shot contribution explicitly requests closure. Close releases a
spawn key and can cancel work, but deletes no retained result or native state.

[ARCH](ARCH.md) owns design and source ownership;
[capabilities](docs/capabilities.md) owns the exact contract;
[the operating skill](plugin/skills/grokpair/SKILL.md) owns caller guidance.
The provider-free gates in [AGENTS](AGENTS.md#build-test-and-inspect) use isolated
state. Integration tests drive the built bundle, real worker and official SDK
against a deterministic native peer. They do not establish live native
behavior, installed identity, discovery or useful fresh-host acceptance.

## Known limits and remaining work

These are known gaps, not capabilities claimed by this release. Native
details derived from earlier inspections must be rechecked against the
applicable native contract before a repair.

- **Background work visibility.** The bridge retains shell-task start and
  completion but not every native background snapshot, typed subagent,
  workflow, scheduled-task or monitor event. An idle turn with no background
  entry is not proof of quiescence; close can end native work. Native wake
  work can also stop without the ordinary completion event. Do not teach
  ongoing-work recipes until those identities and settlement rules are
  qualified. No wrapper scheduler belongs here.
- **Result-view file weight.** Full native file metadata, including diffs,
  can displace the answer into another page. A lean result projection should
  retain paths, MIME/name and native identities while records keep the full
  payload. Do not infer read-only behavior from tool names.
- **Receiving-turn identity.** Native queue removal is preserved without a
  false cancellation, but its receiving turn is not established by matching
  text or concurrent activity. Do not infer that identity or replay removed
  work. Old expired attention cannot be recreated by reinterpreting retained
  false terminals.
- **Unadmitted store failures.** A failure after creating a collaborator
  store but before committing admission can leave an unadmitted store.
  Reconcile only that state in the same call, without removing any admitted
  or uncertain operation or retained result.
- **Unidentified child launch.** The claim fence prevents duplicate Grok
  execution, but a spawned child whose exact process identity was unavailable
  can lose its first launch when the reserver exits. Distinguish a child
  launched without attestation from one never launched; elapsed time does
  not prove absence.
- **Native turn-end facts.** Reported model, usage/cost, search overrides and
  cancellation details are not all retained. Preserve reported native facts
  and leave absent values unknown, not zero.
- **Small reporting repairs.** Pending counts can briefly include a response
  arriving after its turn ended. Input errors should present paths/messages
  rather than a stringified validation array, and configure failure should
  not repeat the same cause through several diagnostics.

## Delivery and acceptance

Source preparation for 2.3.3 and its remaining review and delivery limits are
recorded in [RELEASE](RELEASE.md#source-233). Source results do not establish
publication, catalog selection, installation or consumer acceptance.

Installed and useful fresh-caller acceptance is recorded for 2.3.1 and is not
inherited by 2.3.3. For 2.3.1, both product-local and shared-marketplace
acquisition routes were qualified in isolated homes. The selected
`grokpair@tiziano-ai` payload matched the `v2.3.1` source in both intended
hosts, with byte/mode and eight-tool registry parity. Useful fresh-caller
acceptance reached the app-bundled Codex CLI and Claude Code CLI, not every
desktop mode.

Isolated installation proves that distribution route, not intended-home
materialization or a desktop session's active package. Intended-home bytes,
on-disk selection and the package actually bound by a caller are separate
observations. They need not be changed in one operation, and an app restart
is not a prerequisite in principle; only a verified, scoped host refresh or
a fresh caller establishes the new binding. Detached work survives host
reloads and must be reconciled separately before candidate writers enter the
shared runtime.
The removal of packaged approval bypasses is qualified by the recorded
native-host cycles, not inherited from the previous release's auto-allow
evidence. [RELEASE](RELEASE.md) records the observations and their limits.

The 2.3.1 fresh guided CLI cycles do not qualify spontaneous skill selection,
the full permission/Desktop/Workflow matrix, continued relay messaging, media
quality or every native attention method. The Claude caller produced an
overlong note and exceeded its assigned scratch-file write scope; functional
acceptance is not a claim of flawless caller behavior. Other projects that
refer to older bridge names remain with their owners; this release changes
no consumer repository.

## Decisions reserved to the owner

- Future source publication and catalog promotion require destination-specific
  authority; the completed release is not standing approval for another push.
- Whether to adopt additional native secret restrictions. Profile names
  alone prove neither provenance nor enforcement.
- Whether to remove Claude session variables, including messaging tokens,
  from the environment passed to Grok.
- Whether to add retained-result disposal. The present contract never deletes
  retained data; manual cleanup needs exact target authority.

## Deferred capabilities

None is activated by this release. Native named-agent selection needs
confirmed fallback and resume semantics; a role is not a sandbox. Structured
output, individual background-task controls, latest activity, native command
discovery, conversation forks and side-answer files need their own demonstrated
consumer need and native contract. More host integrations must preserve the
required timeouts and lifecycle, not create per-host execution cores.

MCP SDK v2, modern protocol serving and preparatory compatibility machinery
remain **held** until intended hosts support them as stable and the maintainer
explicitly resumes the work. Do not add split packages or experimental host flags.
