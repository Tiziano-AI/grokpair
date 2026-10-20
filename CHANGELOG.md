# Changelog

## 2.3.1 — Clean public source snapshot

- **One source.** Prepare a history-free public repository from the qualified
  implementation, with source, tests, generated payload and both native
  marketplace manifests in the same tree. This changes no execution behavior,
  tool, schema, runtime namespace or cursor contract from 2.3.0.
- **Portable onboarding.** Remove maintainer-specific installation diaries,
  identify approvals as user-owned, link native setup and explain installation,
  first use, removal and the distinction between source and host acceptance.
- **Complete attribution.** Include esbuild's injected runtime helper license
  alongside the bundle's package-input licenses. Identify the bundle as
  generated and transformed; no native compiler binary is distributed.
- **Release identity.** Use a new version for the new public Git root rather
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
