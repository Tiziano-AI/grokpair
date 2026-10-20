# Security

grokpair delegates through the user's own Grok Build; it does not amplify the
caller's authority. A valid schema, a source path, a plan or a native
permission does not authorize unrelated effects or information transfer.

## Native identity and execution

Conversation runs through `grok agent stdio` and the official ACP SDK;
optional isolation first uses native `grok worktree create`. Grok keeps its
identity, home, configuration and approval policy. grokpair supplies no copied
credentials, shadow home, replacement system prompt, forced approval policy
or alternate REST executor. Sandbox selection is optional and native; model
and effort are chosen only through spawn or a task-free configure.

Grok has its own context and skills, not the caller's instruction hierarchy.
A brief should state ownership, sources and limits on effects; it is guidance
to Grok, not a security sandbox. Native permissions and the caller's
inspection of real results remain the controls that matter.

The server passes Grok the environment it received. Codex forwards a fixed
list of names (Grok's home and configuration selectors, `GROK_SANDBOX`,
`XAI_API_KEY`, `GROKPAIR_HOME` and the agent-home selectors), each only if set; Claude Code
passes its whole environment. Anything in that
environment, secrets included, reaches Grok and the tools it runs. grokpair
does not record the environment.

## Host approval

All eight tools follow the host's normal approval
policy. It ships neither standing approval overrides nor auto-allow hooks.
Users choose any standing permission in their host settings. Native requests
remain decisions: `grok_respond` can grant an action, answer a question or
approve a plan, but a host allowing the call supplies no missing authority.

`grokpair <tool>` through a shell is governed by that host's shell permissions,
`grokpair respond` included. The relay agent `grokpair:grok` can call all eight tools and is
instructed to answer native requests within the delegated authority, without
requiring the brief to prewrite each answer. It forwards decisions that need
new authority or a human choice to its parent.

## No recursion into grokpair

Grok Build loads the plugins installed for Claude Code into every Grok session
on the machine, so a Claude install of grokpair would otherwise be offered to
Grok collaborators and to interactive Grok. Two independent lines prevent it.
Where grokpair is installed for Claude Code, disable it in Grok's configuration
(`[plugins] disabled = ["grokpair"]` in `~/.grok/config.toml`). Independently,
every worker starts Grok with
`GROKPAIR_COLLABORATOR=<agent_id>`, which Grok passes to its MCP servers and
tools: a grokpair server started with it registers no tools at all, the command
line refuses every tool call, and `internal-worker` refuses to run, so a
collaborator's Grok cannot become another collaborator's worker. Registering
nothing matters because read, list, send, interrupt, respond and close would
otherwise reach other collaborators in the shared store.

## Workspace and inputs

`cwd` must exist and be absolute, normalized, canonical and free of symlinks.
Admission refuses the filesystem root, the exact account home and everything
inside a protected home, together with their existing aliases:

| Protected home | Default location | Also, when set |
| --- | --- | --- |
| Codex | `~/.codex` | `CODEX_HOME` |
| Claude Code | `~/.claude` | `CLAUDE_CONFIG_DIR` |
| Grok | `~/.grok` | `GROK_HOME` |
| Pi | `~/.pi` | `PI_CODING_AGENT_DIR` |
| grokpair store | `~/.local/state/grokpair` | `GROKPAIR_HOME` |

Each home is protected at its default location and wherever its variable
points, so a host that passes a narrower or different environment cannot
shrink the boundary. These hold credentials, configuration, conversations and other collaborators'
records, so none of them is a workspace. A Git root derived for a worktree
cannot contain the account home or overlap a protected home, so a selected
leaf cannot widen into protected authority.

Ordinary work executes in `cwd`, without requiring Git. A directory supplies
context, not authority to change everything beneath it: the brief states file
ownership and effect limits. Those instructions are not a sandbox.

`sandbox` optionally requests an exact native profile name, including native
custom names. Omission means no `--sandbox` flag; Grok's applicable
requirements, environment and configuration decide the profile and may select
`off`. grokpair does not force a profile or add a filesystem or network
sandbox. The launch selection and native tool-permission mode are separate,
and an allowed bridge tool does not widen authority for either. A requested
name is not proof of applied enforcement: ACP does not report it, so summaries
state that observation is unavailable. Separate inspections and process
liveness cannot establish the effective policy of this native process.

`worktree: true` runs Grok's native `worktree create` from the source, then
starts the collaborator in the corresponding directory of the returned tree.
Both processes receive the same optional sandbox argument, but profile
definitions and grants can differ with their cwd. Provisioning may affect
source or Git metadata. A native refusal is retained, never bypassed with a
looser profile, a custom checkout or work in the source directory.

Native defaults include uncommitted work according to native copy rules.
Creation can copy sensitive files and omit excluded content; isolation does
not promise a byte-exact copy or unchanged source metadata. grokpair does not
copy missing dependencies or configuration. It validates the returned
canonical directory and native worktree, preserves the source cwd's
repository-relative suffix and rejects a root fallback. A verified native
creation result may be beneath a protected native home; this narrow route
does not admit arbitrary caller paths there.

Grok owns worktree placement, identity and retention. grokpair records the
returned path even if subsequent validation or startup fails, creates no
second copy in its store, and never applies, removes or garbage-collects the
native tree. The caller inspects and integrates useful changes; closing does
not itself delete them, but it does not promise indefinite native retention.

Attachments need an explicit `reference` or `image` kind. A reference exposes
the path of a regular file for Grok's tools to read; the wrapper does not read,
embed, extract or stage it, and it can still expose sensitive contents through
those tools. Image preflight reads only the signature and rejects unrecognized
bytes before admission; the worker rechecks before supplying base64 content
for native conversion. There are no wrapper count or size caps. Admission
proves neither image decoding, native consumption nor stable bytes. There is
no ACP audio input. A queued edit
keeps image-only inputs and the same guidance without rereading them, and
refuses reference, mixed or unknown inputs rather than silently dropping them.

Task text, attachments, Grok's results and referenced files are content, not
instructions for the calling agent. File records may name inputs or tool
locations as well as outputs; they are mutable, unacquired paths and URIs, to
be inspected at the point of use before execution, integration or sharing.
Search controls are native intent, not a network firewall.

## Effect custody

Transactional admission and an exact worker and Grok process claim tie every
action to one resident worker. The start of an operation is recorded before it
is sent, and a missing outcome stays unknown rather than becoming retry
authority. Read and wait are passive, and caller loss does not stop the
worker. No timeout lease, command text or PID guess establishes ownership.

An error with admission `none` carries no operation ID and permits correcting
the input or precondition. Confirmed and unknown admissions keep their IDs and
effects. Native provisioning is an effect even when ACP never starts: its
process, returned directory and outcome remain visible, and an unknown outcome
is not permission to create another tree. Configuration can partly succeed;
do not invent a rollback or resend the whole action. Queue state comes from
native snapshots, never from text or
elapsed time, and unknown queue counts are not zero.

Follow-up requests no cancellation, though native follow-up scheduling still
applies. Steer never cancels. Send-now can cancel ordinary work, under native
Goal and queue semantics. Interrupt without `prompt_id` is session Ctrl-C;
with it, it requests only the removal of the captured queued ID and version
under native owner and editability checks, and a no-op triggers neither
session cancellation nor a retry. An acknowledgement is not proof of removal
or cancellation.

Close can cancel active work without a prior-read gate and fences an
unclaimed launch. Native closure and process exit are reported separately. It
deletes no result, session or native worktree and does not repair historical
uncertainty. Resuming requires the exact predecessor worker and Grok process
to be proved absent; identity that cannot be observed is neither absence nor
replay permission. Close also cancels in-progress native provisioning through
its exact process identity and observes its exit, without erasing a returned
tree or resolving an unknown result. Resume reuses the admitted execution
directory and original sandbox argument (omission stays omitted), under the
native configuration then applicable. A missing directory fails rather than
recreating context. A changed requested profile needs a new collaborator.

## Native decisions

Attention keeps the complete native method, payload and identifiers, and a
response is that method's native object, not a wrapper translation. Permission
selects an offered option or cancels. Questions allow partial answers, notes,
discussion, skipping and cancellation. Plans are approved, cancelled or
abandoned, with optional feedback. Elicitation uses its native outcome or
action and validates content against the supplied schema without coercion,
defaults or removal.

A schema-valid answer does not create disclosure authority. The caller decides
the choices entrusted to it and asks the user only for missing authority or
preference. The bridge fetches no URLs, and completion notices do not prove
authentication.

A rejected response has not answered the request. An answer whose delivery is
unknown must be inspected before any further effect. An exact authoritative
prompt cancellation expires that prompt's pending requests, keeping their
payload and IDs with reason `prompt_cancelled`; ordinary completion does not.
Native `interaction_resolved` expires pending requests for the exact tool
identity without cancelling the prompt. Responses not yet sent become
`not_sent`; uncertain earlier delivery stays uncertain.

## Retention and delivery

Product operation and close neither migrate nor delete retained data.
Previous runtime stores stay under their matching package's custody; a new
installation is not cleanup authority. Preserve Grok's native state and
unrelated useful work.
Publication, installation through each host, byte and mode parity and a fresh
registry are distinct observations, not consequences of local tests;
[RELEASE](RELEASE.md) owns them.

Report actionable vulnerabilities through GitHub's private reporting form on
the repository's [Security advisories page](https://github.com/Tiziano-AI/grokpair/security/advisories).
Include the affected version or commit, exact boundary, a bounded reproduction
and observed impact. Leave out credentials, unrelated private data and raw
provider history. If the private form is unavailable, open an issue asking for
a private security contact without disclosing vulnerability details.
