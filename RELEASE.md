# Release and installed acceptance

A release is complete only when its supported marketplace acquisition routes
are qualified in isolation, the intended homes select one final distribution
of the exact tagged commit, installed bytes and modes match the tagged
`plugin/` tree, actual CLI and desktop bindings and fresh registries match,
and a fresh caller in each host does useful work through that final package.
Source checks establish none of those later steps.

Consult the repository's [Git tags](https://github.com/Tiziano-AI/grokpair/tags)
for published source identities and the
[Tiziano AI catalog](https://github.com/Tiziano-AI/plugins) for the revision
offered by the shared marketplace. Neither selector alone establishes an
installed consumer's version.

## Source 2.3.4

This source candidate updates only the transitive dependency graph and
generated distribution: body-parser 2.3.0 → 2.4.0, fast-uri 3.1.8 → 3.1.9
and qs 6.16.0 → 6.16.1. All resolve within existing upstream ranges; no
override or direct dependency update is required.

The 27 October 2026 registry audit of the preceding lockfile reported six
advisories: one high-severity body-parser advisory, four fast-uri advisories
(two moderate and two low), and one moderate qs advisory. Patched-version
authority is the upstream
[body-parser advisory](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828),
[fast-uri advisory](https://github.com/fastify/fast-uri/security/advisories/GHSA-w74x-v6f9-j3xg)
and [qs advisory](https://github.com/ljharb/qs/security/advisories/GHSA-6pq8-jhm2-2vcw).
The frozen, script-disabled install passes and the updated registry audit
reports zero advisories across 158 dependencies. These are dependency-graph
findings, not evidence of exploitation: grokpair exposes stdio, not the HTTP
middleware implicated by body-parser. A clean registry audit is not a claim
of universal vulnerability or malware absence.

All 271 tests and the complete [source gates](AGENTS.md#build-test-and-inspect)
passed against the rebuilt payload with Node 24.22.1 and pnpm 12.15.0.
These gates use deterministic peers rather than live provider inference.
Strict Claude validation passed with one directory warning for an ignored,
untracked `plugin/.DS_Store`, absent from the committed Git payload.
Signature verification reported all 158 dependencies verified, with none
invalid or missing; that observation is not a malware certificate.

Adversarial Grok review through Grokpair inspected the actual candidate
against its preceding public source, the upstream advisory ranges, lockfile,
generated payload and Ajv consumer path, and found no supported blocker.
Only fast-uri contributes changed code to the distributed bundle, through
Ajv's schema-ID and reference resolution for elicitation forms. Body-parser
and qs remain outside that stdio payload. The review identified stale
current-version labels in README and the capabilities document; those labels
now describe 2.3.4. It did not repeat the gate chain, audit or signature
verification, and it does not qualify installed consumers.

This is a reviewed source candidate, not a completed release: no public
push, tag, catalog promotion, installation or consumer cutover is included
in this preparation.

## Source 2.3.3

Version 2.3.3 updates ACP SDK 1.8.0 to 2.0.1, Zod 4.6.6 to 4.6.7 and
pinned pnpm 12.11.2 to 12.15.0. Node now requires the security-patched
`>=24.22.1`; the build target preserves that exact patch floor. The ACP
package's default remains stable protocol v1, and the existing app API and
custom-method parsers remain in use. The MCP-v2 hold, public schema 3,
runtime-v2, SQLite format 1, cursors and eight tools are unchanged.

Source qualification on 23 October 2026 used Node 24.22.1 and pnpm 12.15.0.
The frozen, script-disabled install passed with lockfile policy checking
enabled. The exact minimum-release-age exception for ACP 2.0.1 follows review
of its official release, migration guide and registry provenance; the
provenance source commit matches the upstream tag
`2ab61518f7079ef5f6c7a961f0ebcab23ef5f59d`. The general age policy remains
active. Other direct dependencies are current within the adopted Node 24
and MCP-v1 lines; adopting Node 26 types or held MCP-v2 is not part of this
refresh.

All 271 tests and the complete [source gates](AGENTS.md#build-test-and-inspect)
passed against the rebuilt payload. The deterministic ACP peers cover the
public MCP path and real detached worker; those gates used no live provider
inference. Strict Claude validation passed with one directory warning for an ignored,
untracked `plugin/.DS_Store`, which is not in the committed Git payload.
The registry audit reported zero advisories across 158 dependencies;
signature verification reported all 158 verified, with none invalid or
missing. These are registry observations, not a guarantee of universal
vulnerability or malware absence.

Adversarial Grok review through Grokpair inspected candidate
`b89e6f460da7ea9726192f4817cd1c2528623aa2`, its parent, the installed SDK and
generated bundle, and found no supported blocker. Its synthetic in-memory
peer confirmed that required standard payloads retain their original extra
fields and custom methods preserve their full objects outside the stable
session router. That router drops five unstable update discriminants the
parent accepted: `plan_update`, `plan_removed`, `subagent_update`,
`session_message` and `session_message_chunk`. The worker does not consume
them, and their literals were absent from the inspected Grok 1.0.67 binary;
the latter observation is not a live trace of every possible provider update.
The review accepted the exact release-age exception and confirmed that
esbuild accepts `node24.22.1`. That build target is not a runtime guard:
`engines.node` declares the patched requirement, and no `process.version`
refusal was added. The review did not rerun the source gates or qualify useful
fresh-host consumer behavior.

This is a reviewed source candidate, not a completed release: no 2.3.3 tag,
public push, shared-catalog promotion, marketplace acquisition,
intended-home installation or fresh-host
acceptance has been performed. The installed and consumer observations for
2.3.1 below are not inherited by this candidate.

## Source 2.3.2

Version 2.3.2 is scoped to documentation, caller guidance, plugin descriptions
and listing artwork. It changes no native
execution behavior, dependency, tool, public schema, runtime namespace,
SQLite format or cursor contract.

Its generated payload passed all 271 tests and the complete
[source gates](AGENTS.md#build-test-and-inspect), including package, MCP,
skill and native checks and both strict Claude validations. These checks use
no live provider and do not establish publication, catalog selection,
installation or consumer acceptance. The 2.3.1 installed and
consumer observations below remain specific to that tagged payload; they are
not inherited by 2.3.2.

## Released 2.3.1

The public source is tagged
[`v2.3.1`](https://github.com/Tiziano-AI/grokpair/tree/v2.3.1), commit
`fed5d8beda9a3fd7bb26947c4962c75443377f6f`. Version 2.3.1 changes public
packaging, documentation, Git identity and attribution, not the qualified
2.3.0 execution core or public contract.

### Distribution and installed identity

Both product-local native marketplace routes and the shared
[Tiziano AI catalog](https://github.com/Tiziano-AI/plugins) were qualified in
isolated homes. The selected distribution was **`grokpair@tiziano-ai`**;
the catalog pinned the public source commit above and its `plugin/` subtree.

In the intended Codex and Claude Code installations, all 14 committed payload
files matched the tagged source in bytes and executable modes. Fresh
registries exposed server version 2.3.1, public schema 3 and the exact eight
tool names, descriptions and input schemas. The actual caller MCP servers
and detached workers loaded those installed bundles, not a source checkout.

### Useful fresh-caller acceptance

Fresh app-bundled Codex `0.163.0-alpha.10.2` and Claude Code CLI `2.1.304`
performed representative parallel collaboration through the final package,
on macOS arm64 with Node `24.22.0` and Grok Build `1.0.62`. Each caller read
the installed skill, worked independently while Grok ran, inspected the full
contribution and actual output file, requested a substantive correction in
the same native conversation, inspected the revision and closed its own
collaborator. Native closure, drained records and worker/provider process
absence were observed separately. Unrelated retained collaborators were
left unchanged.

The cycles preserved the hosts' user-selected approval and permission
settings; Grokpair added no grants, hooks or invocation overrides. The Claude
caller produced an overlong recovery note and briefly wrote a scratch copy
outside its assigned output scope, then removed that copy. Retained records
were preserved. The functional result is not a claim of flawless caller
behavior or fully accepted artifact quality.

This qualifies the observed fresh CLI paths, not spontaneous skill selection,
every permission mode, Claude Desktop, login or Workflow, continued relay
messaging, media quality, every native attention method or reload of existing
desktop chats. No attention request arose in these cycles. A completed turn
does not certify content or prove unreported background effects absent.

### Source qualification

Before the public snapshot, the unchanged execution core passed all 271
tests and the complete [source gates](AGENTS.md#build-test-and-inspect).
Deterministic regressions cover exact spawn retries, native queue removal,
complete serialized read/wait budgets, structured-record fragments and
version resets, delivered-only wait cursors, optional file snapshots and
Unicode continuation. An adversarial review finding on drained-page budgets
was corrected and covered by a regression before those gates passed.

The pre-publication installed Codex bundle also passed all 75 public
MCP/worker/official-ACP integration tests against deterministic native peers;
the Claude payload was byte-identical. These establish bridge behavior
against the tested peers, not live provider quality or the identity of an
unobserved consumer. They do not replace the final installed checks above.

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
The product-local marketplace is named `grokpair`; the ordinary shared
marketplace is `tiziano-ai`. A catalog promotion is a separate publication
effect and must pin the reviewed release commit. Before publication is accepted,
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
