# grokpair

grokpair gives a calling agent a detached native Grok Build collaborator. The
caller delegates a bounded contribution (research, a review, a candidate
implementation in a worktree, a document or media), keeps working in
parallel, then reads what Grok actually said and made and decides what to
adopt. The calling agent keeps acceptance, integration, credentials, commits,
publication and final claims. Grok keeps its own identity, configuration,
model, tools, skills and conversation. A turn that completes natively says
nothing about quality, finished files or background quiescence.

The product is a deliberately thin bridge that serves any agent host. Eight
tools (`grok_spawn`, `grok_send`, `grok_wait`, `grok_read`, `grok_list`,
`grok_respond`, `grok_interrupt`, `grok_close`) are exposed as an MCP stdio
server (`grokpair mcp`) and as the same calls on the command line
(`grokpair <tool> [json | -]`). They write to a transactional SQLite mailbox,
one per collaborator, and one resident detached worker per collaborator holds
the official ACP SDK connection to `grok agent stdio`. Codex and Claude Code
install it as a native plugin from this repository. The name `grokpair` is
shared by the repository, plugin, product-local marketplace, MCP server,
command, skill, environment prefix and store. The ordinary shared marketplace
is `tiziano-ai`.

## Where things live

Read ARCH.md before changing source. Each document owns one question; change
the owner rather than restating it somewhere else.

- [VISION.md](VISION.md): product intent and what makes a contribution useful.
- [ARCH.md](ARCH.md): design, invariants, host packaging and the source-owner
  map for `src/`.
- [docs/capabilities.md](docs/capabilities.md): the public contract (fields,
  send actions, views, cursors, records, attention responses, recovery, CLI).
- [plugin/skills/grokpair/](plugin/skills/grokpair/SKILL.md): the operating
  skill callers actually read, with `references/collaboration.md`,
  `references/files-and-workspaces.md` and `references/native-work.md`. The
  whole package is a primary product surface, written for any calling host;
  `native-work.md` is the one owner of guidance for native jobs (engineering,
  research, documents, images, video).
- [plugin/agents/grok.md](plugin/agents/grok.md): the Claude Code relay agent
  `grokpair:grok`, which runs one brief in the background and leaves the
  collaborator open for the parent's inspection and correction by default.
- [SECURITY.md](SECURITY.md): authority, workspace scope and effect custody.
  [PRIVACY.md](PRIVACY.md): what is stored and retained. [TERMS.md](TERMS.md).
- [README.md](README.md): hosts, installation and first use.
- [PLAN.md](PLAN.md): current implementation, its proof and planned work.
  [RELEASE.md](RELEASE.md): publication, installed identity and acceptance per
  release. [CHANGELOG.md](CHANGELOG.md): changes per version.

In the code:

- `package.json` owns the product name, version, description, keywords, the
  Node floor (`>=24.21`) and the pinned pnpm. Public schema, runtime directory,
  SQLite format and cursor versions are separate contracts; ARCH states the
  current ones.
- `scripts/manifests.mjs` owns host packaging. `pnpm build` typechecks,
  bundles `src/` into `plugin/lib/grokpair.js`, writes
  `plugin/schemas/grokpair-tools.schema.json`, and generates from
  `package.json` the Codex manifest (`plugin/.codex-plugin/plugin.json`), the
  Claude Code manifest (`plugin/.claude-plugin/plugin.json`),
  `plugin/package.json`, and both marketplaces
  (`.agents/plugins/marketplace.json` for Codex,
  `.claude-plugin/marketplace.json` for Claude Code). These outputs are
  committed because both hosts install the committed `plugin/` tree, so change
  `manifests.mjs` or `package.json`, rebuild and commit the outputs with the
  change; `pnpm validate` fails on any drift.
- `scripts/bundled-notices.mjs` derives dependency license and notice texts
  from the production bundle's contributing packages. The build writes
  `plugin/THIRD_PARTY_NOTICES.md` and copies the authored `LICENSE` to
  `plugin/LICENSE`; both ship with the installed payload. Do not hand-edit
  generated legal text or omit a contributing package's notice.
- There is deliberately no `plugin/.mcp.json`: Claude Code loads one beside
  the manifest's inline server, which would start grokpair twice.
- `src/agent-store.ts` owns runtime coordinates and the `RUNTIME_CONTRACT`
  constant; `src/filesystem.ts` owns the store base (`GROKPAIR_HOME`, default
  `~/.local/state/grokpair`) and the protected agent homes; `src/agent-state.ts`
  owns derived collaborator state; `SEND_ACTION_MATRIX` in
  `src/agent-schema.ts` owns send validation, action descriptions and public
  input examples.
- ARCH's source-owner table ("Source ownership and delivery"), the
  `productionOwners` map in `scripts/validate.mjs` and the modules in `src/`
  must agree exactly, with each module in one owner group. `pnpm validate`
  fails when any two disagree, so adding, removing or moving a module changes
  all three together.
- `.cdx-continue/` (continuation state) and `.tmp/` are gitignored runtime
  material, not source; leave them as they are.

## Build, test and inspect

In a fresh checkout or worktree, install dependencies first with the pnpm
version pinned in `package.json`, from the committed lockfile
(`pnpm install --frozen-lockfile`). Run the whole set before integrating a
change (`test`, `validate` and `mcp:check` rebuild first):

```bash
pnpm build
pnpm test
pnpm validate
pnpm mcp:check
pnpm skill:validate
pnpm native:check
claude plugin validate --strict ./plugin
claude plugin validate --strict .
git diff --check
```

- `scripts/test.mjs` runs only `tests/thin-*.test.mjs` and
  `tests/node-target.test.mjs`, serially, with `TMPDIR=/private/tmp` and a
  scratch `GROKPAIR_HOME` it removes afterwards. Name new test files to match
  or they will not run.
- `tests/thin-integration.test.mjs` drives the built entrypoint through public
  MCP, the real detached worker and the official ACP SDK against
  `tests/fixtures/thin-native.mjs`, a deterministic ACP peer placed on a
  test-local PATH as `grok`. Setting `GROKPAIR_TEST_ENTRYPOINT` points that
  file at another bundle, such as an installed plugin's `lib/grokpair.js`; the
  other test files import `src/` directly.
- Tests and checks use isolated state under `/private/tmp`, outside the
  package, and never private native configuration such as `~/.grok`, the real
  `CODEX_HOME`, `~/.claude` or `~/.local/state/grokpair`. Keep new harness
  scratch there too.
- `mcp:check` and `native:check` need no provider. `mcp:check` starts the
  packaged server with a PATH that holds no executables; every call it makes is
  read-only, names an absent collaborator or is rejected before admission, and
  it asserts that no runtime state was created and that a server started
  beneath a collaborator offers no tools. `native:check` concerns compiled
  native code, not Grok: it fails on C/C++, `.node` or other binary artifacts
  in `src/`, `plugin/` or `scripts/`, on any helper in `plugin/bin` besides
  `grokpair`, and on native-module dependencies (SQLite is Node's built-in
  `node:sqlite`). Neither check says anything about live Grok behavior.
- `skill:validate` checks the skill's resources, links and that its examples
  validate against the actual schema; it does not prescribe prose.
  `claude plugin validate --strict` checks the Claude Code manifest and
  marketplace; Codex has no equivalent validator, so its manifest is covered
  by `pnpm validate` and by a real install.

From the checkout, `node plugin/bin/grokpair version`, `schema` and the tool
commands inspect and exercise the package; no arguments prints usage and `mcp`
starts the server. `internal-worker` is how the service launches its own
detached worker, not a recovery command to run by hand.

Prove a change through the public behavior it affects, end to end. When you
replace behavior, remove the replaced code, fixtures and instructions, never
retained results or anyone's runtime state.

## Design lines to hold

The bridge translates and retains native facts; Grok does the work. Limits
follow real native or protocol boundaries, not wrapper policy, and an honest
"unknown" is better than an inferred answer. The recurring temptation is to
add wrapper machinery, so each line below names what does not belong. ARCH and
docs/capabilities.md own the full contract, including observation fidelity,
views, pagination, attention expiry and recovery.

- **Hosts.** One core, thin surfaces: MCP and CLI call the same service, and
  each host's packaging is generated from one owner. Prefer the host's native
  mechanism (manifest fields, plugin agents, hooks, `bin/` on PATH) to
  anything grokpair would have to run itself. Tool descriptions stay
  caller-neutral; host-specific guidance lives only where that host reads it.
  No server-wide MCP instructions, which hosts repeat before every tool.
- **Execution.** One resident worker per collaborator, the official ACP SDK
  (`client().connect()` and `ndJsonStream` own framing) and a transactional
  SQLite claim that binds the exact worker and provider identities. No daemon,
  watchdog, lease, replay, finalizer, custom transport, or forensic or archive
  machinery (such as a raw ACP, reasoning or tool-output archive). Official
  ACP framing uses `maxMessageBytes: Number.MAX_SAFE_INTEGER` to preserve
  large incoming frames rather than adopt the SDK's 32 MiB default; this is
  a finite transport ceiling, not a memory-safety guarantee. The MCP stdio
  transport keeps `maxBufferSize: Infinity`. MCP SDK v2 and modern protocol
  serving are held until intended hosts support them as stable and the
  maintainer explicitly resumes that work; do not add split packages,
  experimental host flags or preparatory compatibility machinery.
- **No recursion.** The worker sets `GROKPAIR_COLLABORATOR` in Grok's
  environment; a grokpair started beneath it serves no tools, the CLI refuses,
  and `internal-worker` refuses, so Grok cannot become another collaborator's
  worker. Grok also loads Claude Code's installed plugins, so installations
  must disable `grokpair` in Grok's configuration; the guard holds even where that
  configuration is missing.
- **Lifecycle.** Read and wait are passive and never launch. Close may cancel
  active work, fences an unclaimed launch so a late worker cannot start,
  releases a spawn key, keeps native closure and process exit separate, and
  deletes no result, original, native session or native worktree. Only an
  explicit new follow-up with resume can continue known native context, and only after
  the exact predecessor worker and provider are proved absent. Unknown
  identity is not absence, and unknown effects stay unknown even after close.
- **Native ownership.** Identity, home, configuration, profile, approval policy,
  model and effort defaults, the queue, background tasks and follow-up
  scheduling stay native. Sandbox is an optional exact native profile name;
  omission passes no flag and may resolve natively to off. Placement and
  profile selection are independent, and ACP does not report effective
  enforcement. No quality preset, calibration gate, derived
  capability roster, `image:true` gate, wrapper scheduler, wrapper decision
  mapper or media API. Attention records (native permission, question, plan
  and elicitation requests waiting for the caller) keep the exact native
  method and full payload. Answering one is the caller's decision within its
  existing authority, and the response is that method's native object.
  Configuration can partly succeed; never invent rollback or in-flight
  retargeting.
- **Views.** The result view groups a page by what the caller acts on; the
  records view keeps all retained typed records. The result view omits, it never
  rewrites: text stays Grok's text and every omitted record remains in the
  records view.
- **Inputs.** Attachments need a path and a kind, `reference` or `image`. A
  reference passes the exact original file URI (with a JSON-encoded path label
  and empty `_meta`) without reading, embedding, extracting or staging it. An
  image is byte-sniffed and progressively base64-encoded, and Grok owns decoding
  and conversion. No invented input caps and no speculative audio path. File
  records are mutable native references, not acquired or hash-certified
  artifacts; the parent inspects the real contents.
- **Workspace.** The cwd must be an existing, absolute, canonical, non-symlink
  directory. Aliases, root, the exact account home and protected state (the
  Codex, Claude Code, Grok and Pi homes and the grokpair store, each at its
  default location and at its environment override, with everything beneath
  them) are denied, and derived Git roots cannot widen protected authority.
  Ordinary work executes in cwd without Git. A brief states file and effect
  boundaries but is not a sandbox. `worktree: true` uses native
  `grok worktree create`, including native defaults for copying uncommitted
  work, not a bridge-owned Git adapter or committed-only seed. Preserve the
  source cwd's relative position and reject native root fallback; a verified
  native creation result is the narrow exception to protected-home admission.
  Grok owns copy semantics, source/Git metadata effects, location and retention;
  the bridge never applies, removes or garbage-collects native worktrees.
  Provisioning outcomes and returned paths survive startup failure, resume
  reuses the admitted directory, and denial never causes permissive fallback.
  The parent inspects and integrates real changes. SECURITY.md owns scope.
- **Runtime store.** `GROKPAIR_HOME` is the base, otherwise
  `~/.local/state/grokpair` under the canonical account home, the same for
  every calling host. `runtime-v<RUNTIME_CONTRACT>` is appended once, and the
  same constant is checked against the store before any record is read. There
  is no old-runtime lookup, migration or compatible reader: a contract change
  starts a new store. Product operation and close never delete retained
  results. Besides the SQLite databases, the one file
  grokpair writes is each finished turn's complete text
  (`agents/<agent_id>/turns/<prompt_id>.md`), derived from the root text in
  the database, which stays authoritative. It is not the archive Execution
  excludes, and a failed write is no error.
- **Public surface.** Tool descriptions carry their local use and recovery
  information within each host's description limit; the full collaboration
  cycle lives in the skill. A public behavior change lands in the tool
  descriptions, the skill, the relay agent when it is affected and
  docs/capabilities.md together.

## Live Grok, processes and shared state

- Live runs spend paid Grok inference. Before one, inspect the actual `grok`
  executable (`which -a grok`, since PATH can hold more than one and each can
  be a symlink), its version (`grok --version`) and its update state
  (`grok update --check` checks without installing). Do not repeat earlier
  live proofs whose evidence still covers unchanged runtime, and do not send
  probes already known to be invalid, such as ACP audio input.
- The provider is launched as `grok --cwd … [--sandbox …] agent --no-leader
  stdio` resolved from PATH, with the caller's environment plus
  `GROKPAIR_COLLABORATOR`. Launch live runs with `node` directly from the shell
  established at the repository root, changing directory inside that shell. A
  separately set executor working directory can start a login shell that
  reorders PATH, which changes the invocation identity a live proof records.
- Hosts start the server with different environments: Codex passes only the
  variables the manifest's `env_vars` lists, Claude Code passes its own, and
  the Claude and ChatGPT desktop apps take only PATH from the login shell.
  Settings Grok needs in every host belong in Grok's own configuration, not
  in shell startup files.
- Recheck a process's exact identity immediately before any change that
  depends on it, such as signaling or closing it, treating it as absent for a
  resume, or selecting its root for cleanup. A PID or command line from a
  receipt or an earlier observation never supplies that authority.
- Other consumers use the installed plugin, possibly an older version, and
  native `.grok` state holds sessions and outputs. Preserve them: a new version
  does not owe compatibility to their old runtime, but it must not disturb
  their live processes or files. Never hand-edit plugin caches or global host
  configuration.
- Cleanup of retired state needs its own authority for exact targets. Select
  only roots that are actually retired, never live collaborators or their
  files; move them to Trash and never empty it; make no backup, export or extra
  archive. Cleanup does not resolve unknown effects.

## Review, integration and release

- Adversarial review is done by Grok through grokpair itself (the installed
  plugin, or `node plugin/bin/grokpair` from the checkout), in one to three
  useful slices. Do not substitute a same-model reviewer, a majority vote or a
  ceremonial panel.
- The coordinating agent may integrate checked increments directly on `main`
  with descriptive commits, unless the task narrows that authority. Check the
  actual remote and visibility before every push. The owner permits pushes to
  this product's private origin; each public push needs explicit authorization.
  Repository creation, rename, visibility changes and shared-marketplace entries
  need their own authority. Public preparation alone authorizes none of those
  effects. A release is an annotated tag `vX.Y.Z` on the commit that carries
  that version, because both hosts pin a marketplace to a Git ref. No npm
  publication and no automatic app restart.
- A release is complete end to end only when the tagged commit is on remote
  `main`, each supported marketplace acquisition route is qualified in isolated
  homes (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`), and the intended homes select one
  final distribution. Tag and catalog SHA pins must resolve to that same
  tagged commit. Install only the selected distribution in the intended homes;
  never install and remove another route there merely to qualify it. Every
  installed byte and file mode, skill resources included, must match the tagged
  plugin tree; fresh registries must show the eight exact tools, descriptions
  and schemas. Verify the actual intended CLI and desktop bindings, not only
  files on disk or a manually launched cache path. A fresh agent in each host
  must do useful parallel work, wait and follow up through the final selected
  package, with complete output and any real files/media inspected, then settle
  and close its collaborator. Inventory consumers and establish quiescence
  before intended-home removal or replacement can affect their payloads.
  Installing on disk does not reload servers or end detached work.
- PLAN.md and RELEASE.md record what was actually observed and its limits, not
  promised readiness.
