# Changelog

## 2.3.4 — Transitive security fixes

- **Patched locked dependencies.** Update body-parser 2.3.0 to 2.4.0,
  fast-uri 3.1.8 to 3.1.9 and qs 6.16.0 to 6.16.1 within their dependents'
  existing version ranges. This removes six registry advisories without new
  overrides, direct dependency changes or protocol migrations.
- **Rebuilt distribution.** Regenerate the bundled code and host metadata so
  the committed plugin selects the patched dependency graph. The stdio-only
  public transport, eight tools and persisted contracts are unchanged.

[RELEASE](RELEASE.md#source-234) records source qualification and the separate
review, publication and installed-consumer boundaries.

## 2.3.3 — Stable dependency refresh

- **Current upstream dependencies.** Update ACP SDK 1.8.0 to 2.0.1, Zod
  4.6.6 to 4.6.7 and pinned pnpm 12.11.2 to 12.15.0. The ACP package's
  default remains stable protocol v1; no experimental ACP-v2 or held MCP-v2
  migration is included. Other direct runtime and development dependencies
  are already current within the adopted Node 24 and MCP-v1 lines.
- **Patched Node floor.** Require Node `>=24.22.1`, which incorporates the
  [21 October security fixes](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).
  The build target preserves the exact patch floor instead of accepting
  vulnerable Node 24.22.0 through a rounded minor requirement.
- **One generated payload.** Rebuild the bundle, schemas, host manifests and
  dependency notices together. Public schema 3, runtime-v2, SQLite format 1,
  cursors and the eight tools are unchanged.

[RELEASE](RELEASE.md#source-233) records source checks and the separate
review, publication and consumer-acceptance limits.

## 2.3.2 — Documentation and plugin presentation

- **Clearer onboarding.** Lead with the shared `tiziano-ai` marketplace,
  explain prerequisites before installation, and use one coherent read-only
  first contribution. Keep advanced tool and release-pinned examples
  available without crowding the first path.
- **Accurate caller guidance.** Clarify edit acknowledgments, retained-record
  ordering, view-specific wait errors and continuation with returned cursors.
  These corrections describe the existing behavior; they change no tool or
  runtime contract.
- **Plugin presentation.** Refine descriptions and listing artwork. No native
  execution behavior, dependency, public schema, runtime namespace, SQLite
  format or cursor contract changes.

The 2.3.1 installed and consumer acceptance in [RELEASE](RELEASE.md) remains
specific to that payload; it is not inherited by 2.3.2.

## 2.3.1 — Clean public source snapshot

- **One source.** Published a history-free public repository from the qualified
  implementation, with source, tests, generated payload and both native
  marketplace manifests in the same tree. This changes no execution behavior,
  tool, schema, runtime namespace or cursor contract from 2.3.0.
- **Portable onboarding.** Removed maintainer-specific installation diaries,
  identified approvals as user-owned, linked native setup and explained installation,
  first use, removal and the distinction between source and host acceptance.
- **Complete attribution.** Included esbuild's injected runtime helper license
  alongside the bundle's package-input licenses. Identify the bundle as
  generated and transformed; no native compiler binary is distributed.
- **Release identity.** Used a new version for the new public Git root rather
  than rebinding the pre-publication `v2.3.0` tag to unrelated ancestry.

## 2.3.0 — Pre-publication implementation

- **Native queue outcomes.** Keep `removedFromQueue` as a completed operation
  visible in the result view, not an invented cancelled turn. One effective
  queue/activity derivation removes that prompt's stale eligibility without
  guessing the receiving turn. Queue removal and ordinary turn completion do
  not expire attention; native cancellation, interaction closure and request
  lifecycle keep their distinct meanings.
- **Bounded reads.** Fit the entire serialized public JSON response, including
  escaping, grouping, cursors and envelope. Page large retained structured
  records through the existing read/wait cursor as version-pinned JSON
  fragments, with explicit incompleteness. A changed version restarts instead
  of mixing pieces. Remove the oversized-whole-record exception, raw-text
  budget heuristic and Claude's large-output override; no export store,
  archive, new tool or read receipt is added.
- **Delivered wait progress.** Pack the combined response and return only
  target pages actually delivered. Omitted siblings retain their complete
  input cursors. Include the target that caused the wake; let callers rotate
  delivered targets behind excluded ones without a server fairness mechanism.
- **Exact spawn retries.** Compare the full normalized request with the
  immutable initial operation input, not just placement or current settings.
  Conflicting requests never dispatch; an unverifiable original retains the
  key and returns an explicit error. Startup failure and disconnection remain
  no authority for replay.
- **Separate contracts.** Public schema 3 retains runtime-v2, SQLite format 1
  and `gp1.` cursors. A controlled quiescent cutover replaces old consumers;
  no runtime migration, parallel namespace or MCP-v2 preparation is added.

- **Native approvals.** Remove packaged standing approval overrides and the
  Claude auto-allow hook. All eight tools follow the host's normal policy.
- **Delegated origin.** Tell Grok explicitly that its answer returns to the
  calling agent and that contact and publication require scope in the brief.
- **Image admission.** Reject unrecognized image signatures before creating a
  collaborator or operation; retain the worker check for changes after admission.
- **Native forms.** Compile each supplied form in an isolated validator without
  cached meta-schemas, closing a pre-existing `$id` collision that could accept
  invalid responses. Preserve schema identity, relative references, formats
  and non-mutating validation.
- **Installed licenses.** Include the authored license and contributing
  dependencies' license and notice texts in the installed `plugin/` payload.
- **Public-facing documentation.** Replace private release diaries with
  current acceptance and a portable release procedure, refresh onboarding,
  explain removal, and prune obsolete implementation archaeology.

[PLAN](PLAN.md) records current capabilities and limits;
[RELEASE](RELEASE.md) records qualification scope and the delivery procedure.
