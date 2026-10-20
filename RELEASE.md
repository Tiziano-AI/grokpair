# Release and installed acceptance

A release is complete only when its supported marketplace acquisition routes
are qualified in isolation, the intended homes select one final distribution
of the exact tagged commit, installed bytes and modes match the tagged
`plugin/` tree, actual CLI and desktop bindings and fresh registries match,
and a fresh caller in each host does useful work through that final package.
Source checks establish none of those later steps.

## Qualification inherited by the public source snapshot

The 2.3.0 implementation was qualified before the clean public source
snapshot. The observed environment was macOS arm64 with Grok Build 1.0.62,
Codex 0.163.0 and Claude Code 2.1.304. These observations describe that build
and those consumers; they do not establish installation or acceptance of a new
public commit, tag or repository. Version 2.3.1 changes documentation, package
identity and legal notices, not the execution core or public contract.

The canonical isolated source runner passed all 271 tests. Build, validation,
MCP, skill/native checks, both strict Claude manifest/marketplace validations
and the whitespace check passed. Deterministic regressions cover exact spawn
retries, native queue removal, complete serialized read/wait budgets,
structured-record fragments and version resets, delivered-only wait cursors,
optional file snapshots and Unicode continuation. These establish bridge
behavior against deterministic peers, not live provider quality.

Adversarial Grok review identified one drained-page budget defect. The compact
fallback was removed, a regression demonstrated the defect before correction,
and a focused source follow-up confirmed the correction. The complete source
gates passed after the repair. That follow-up did not rerun tests or inspect
the generated bundle.

Both host marketplace routes were exercised in isolated and intended homes
against the pre-publication tag. All four installed payloads matched the 14
committed product files, bytes and executable modes. Fresh registries exposed
the eight exact tool descriptions and schemas. The installed Codex bundle
passed all 75 public MCP/worker/official-ACP integration tests against
deterministic native peers; the Claude payload was byte-identical.

Fresh Codex and Claude CLI callers completed guided representative
collaboration through their selected installed plugins. Each caller worked
independently in parallel, read the complete native contribution and actual
file, requested a substantive correction in the same conversation, inspected
the revised result and explicitly closed its collaborator. Final records were
drained, operation and queue counts were zero, and worker/provider absence was
observed separately. No process was signaled and no app restart was used.

Those cycles used the hosts' existing user-selected approval and permission
settings, without added grants, hooks or invocation overrides. They qualify
representative CLI collaboration, not spontaneous skill selection, every
permission/Desktop/Workflow mode, media quality, every native attention method
or existing desktop-chat bindings. A completed native turn does not certify
generated content or prove unreported background effects absent.

## Release procedure

### Prepare and review the exact candidate

Use a clean, intentionally scoped source state. Read current [PLAN](PLAN.md)
limits and [AGENTS](AGENTS.md#build-test-and-inspect), install dependencies from
the frozen lockfile and run every required gate. Rebuild generated manifests,
schemas, bundle and installed license texts; commit them with their owners.
Review the actual diff, dependencies, public docs and full installed payload.

Obtain adversarial review through grokpair itself, read the complete response
and adjudicate supported findings. A review is not an independent gate run
unless it actually performs one. Do not repeat live inference for unchanged
proof, and do not publish credentials or private provider history as evidence.

### Publish only with destination authority

Confirm repository visibility, exact remote, outgoing commit range,
marketplace identity and intended consumers before tagging or pushing.
Cleaning the current tree does not clean prior commits: audit the history
that would be exposed, or publish an explicitly selected clean source snapshot
without making the private development history public. Never push a private
clone's refs or use a mirror push for a history-free publication.

An annotated release tag belongs on the commit carrying that version.
The product-local marketplace is named `grokpair`. Any shared catalog is a
separate distribution destination; do not advertise that installation route
before its entry exists and has been checked. Before publication is accepted,
enable and verify the private vulnerability-reporting route named in
[SECURITY](SECURITY.md).

### Qualify acquisition routes in isolated homes

Qualify each supported marketplace route against the exact tagged commit in
dedicated isolated homes, not by cycling routes through the intended homes.
The product-local marketplace route is pinned to the release tag:

```bash
CODEX_HOME=/absolute/path/to/isolated-codex-home codex plugin marketplace add Tiziano-AI/grokpair --ref vX.Y.Z
CODEX_HOME=/absolute/path/to/isolated-codex-home codex plugin add grokpair@grokpair
CLAUDE_CONFIG_DIR=/absolute/path/to/isolated-claude-home claude plugin marketplace add Tiziano-AI/grokpair@vX.Y.Z
CLAUDE_CONFIG_DIR=/absolute/path/to/isolated-claude-home claude plugin install grokpair@grokpair --scope user
```

When a shared catalog is part of the release, qualify its native route in
separate isolated homes too. Its exact SHA must equal the release tag's
peeled commit; compare installed files/modes and fresh registries for each
route. A route's acquisition proof does not require another inference cycle.

A local-directory marketplace rehearsal proves layout and local registration,
not Git acquisition or ref pinning. Claude can load relative local plugins in
place rather than copy them into its versioned cache. Verify Git-backed
installation separately once the authorized remote exists.

### Install only the final distribution without disturbing consumers

Identify the final ordinary distribution and its source revision before
touching intended homes. Install only that distribution there. Do not install
and remove a different route as a qualification step: its isolated acquisition
proof and the final intended installation establish different things.

Record which package existing servers and workers actually use. Preserve their
matching entrypoints, stores, native sessions and worktrees; old files or
disconnected records are not cleanup authority. Installing a new version does
not reload an existing server. Do not stop someone else's work or edit plugin
caches to force a cutover.

Treat payload availability, on-disk selection, live MCP binding and activation
as separate steps. Isolated preparation can leave old sessions untouched;
an intended-home install can remove the cache payload they still use. Before
removal or replacement can affect those consumers, establish the quiescent
boundary: old callable ingress is retired through its owner, and workers,
native processes, claimable reservations and pending decisions are accounted
for. `idle` alone does not establish that boundary. Installation is not a fence
against an old process, and a host reload does not end detached work. If the
boundary cannot be established, keep the isolated preparation without changing
intended payloads or activating candidate writers.

Use native operations to retire the superseded plugin identity and its
product-local marketplace registration, then install the final distribution.
When changing a product-local marketplace ref, remove/add that marketplace
rather than assuming plugin removal updates its source. When using an existing
shared catalog, refresh only its named source and select Grokpair; do not
remove the whole shared marketplace or update unrelated plugins. End with one
ordinary Grokpair distribution per host, not duplicate registrations.

Use a fresh caller or the owning host's appropriately scoped reload route to
qualify selection. Inspect the resulting Grokpair entrypoint; a version-shaped
path or connected registry alone does not prove its files still exist.
Refreshing unrelated MCP servers or restarting an app is not an implied
Grokpair installation step. Neither a fresh binding nor a host reload proves
that detached collaborators have ended.

### Verify the installed consumer

Compare every installed product file and executable mode with the tagged
`plugin/` tree, including complete skill resources, licenses and notices.
Exclude only identified host-owned markers, not unexplained files.
Check `version` and a fresh MCP registry from each installed entrypoint.
Repeat this identity check through the actual intended CLI and desktop
consumers' selected entrypoints, not only a path launched manually from the
new cache. Isolated-home parity does not establish intended-home installation
or a desktop binding. Inspect the effective package after the supported scoped
reload or fresh caller; unchanged open chats can retain their earlier binding.

Use a fresh caller in each host on the final selected distribution for useful
parallel work, complete output and artifact inspection, same-conversation
correction and observed closure.
Exercise the host's user-selected approval and permission policies; do not
prescribe another mode or restore a packaged auto-allow hook to make
acceptance pass. Inspect real files and any media; a completed turn does not
establish their quality or that native background work has stopped.

Record exact source and installed identities, observed outcome, remaining
limits and recovery needed. Keep source qualification, delivery, discovery and
useful acceptance separate. Do not claim broader host coverage than observed.
