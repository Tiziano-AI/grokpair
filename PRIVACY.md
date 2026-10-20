# Privacy and retained data

grokpair is local software, not a hosted service. It delegates through the
installed Grok Build; Grok, xAI and any service Grok connects to govern their
own handling and retention of what they receive.

## What reaches Grok

A spawn supplies a brief, the facts and sources in it, a working directory,
optional file references and images, model or effort selections and search
intent. Follow-ups continue the same native conversation, and controls supply
steering, queue edits, side questions, session settings and answers to native
requests. Grok does not inherit the caller's conversation; it sees what the
caller sends.

A reference attachment supplies the absolute path of a regular file without
the wrapper reading, embedding, extracting or staging it; Grok's tools can
then read that file, so a reference can expose its contents even though
grokpair never read them. An image attachment supplies the image bytes. No
permanent wrapper copy of an attachment is made.

A real `cwd` lets Grok discover instructions and sources within the delegated
scope. It is also the execution directory unless a native worktree is
requested. Sandbox omission preserves native configuration, which may select
`off`; no profile is a promise that information stays on the computer. Send
only what is authorized for that destination. There is no ACP audio input.

Native worktree creation can copy uncommitted source files, including sensitive
ones, under Grok's copy rules. Grok owns that copy's placement and retention;
grokpair neither stages a second copy nor removes the native worktree.

Grok runs with the environment the server received: Codex forwards a fixed
list of names, including `XAI_API_KEY` when it is set, and Claude Code passes
its whole environment. grokpair does not store that environment.

## Native ownership

Authentication, credentials, native configuration, sessions, conversation,
compaction, memory, models and tools stay in Grok's own state. grokpair
inherits Grok's defaults unless the caller selects a native sandbox, model or
effort; it does not copy credentials, seed a shadow home or scrape native
history, and it does not force an approval policy
or replace the native system prompt. Closing a collaborator does not delete
native or connected-service data.

## Local records

All hosts share one store: `GROKPAIR_HOME`, or `~/.local/state/grokpair`,
followed by `runtime-v2`. It holds:

- `agents/<agent_id>/agent.sqlite` for each collaborator (with SQLite's WAL
  files beside it), created with mode 0600 in 0700 directories;
- `agents/<agent_id>/turns/`, the complete text of each turn that stopped
  running, one plain file per turn with mode 0600, whose front matter holds
  the collaborator and prompt IDs, the status, input and execution directories,
  worktree root, sandbox argument and unavailable sandbox observation, and,
  when they exist, the operation ID, the stop reason and the brief;
- `keys.sqlite`, which maps each spawn key to the collaborator last spawned
  with it.

A collaborator database records the admitted inputs (task text, working
directory, worktree and sandbox selections, attachment paths and kinds, and
for submitted prompts each attachment's size and each image's MIME type),
operation outcomes and effects,
observed native identities, worker and Grok process identities, native requests
with their full payloads and the answers given, the latest queue, model and
effort options and initialize capabilities, authentic root text, side answers,
native file references, background task start and completion payloads, and
diagnostics. Native provisioning records its intent, process identity, returned
directory and outcome, including uncertainty. Failed native startup retains
bounded stderr and its observed exit, with truncation disclosed; successful
initialization discards the capture. Diagnostics keep native image-exclusion
notices and explicit causes from actual failed tool variants, not stdout or successful results, and
they are not pruned by a history cap. These records can contain sensitive
information. They are not a raw ACP, reasoning or complete tool-output archive.
Briefs and Grok's turn text also exist as plain files in the store, which any
tool or person able to read the account's files can open without grokpair.

Read and wait page through retained text and structured payloads without
silently truncating them. Large structured records are returned as explicitly
incomplete JSON fragments from the same database, not copied into an export
store. Their identity pins a particular record version; if it changes before
reading finishes, the caller discards that incomplete version and restarts the
record. Latest-value observations replace earlier values rather than creating
a transcript, so superseded versions are not promised as an archive. Reading
is neither approval nor consent to share onward. Admission receipts and
listings are summaries, not output.

File records hold mutable paths and URIs with available metadata. They may
name inputs, tool locations or outputs, and grokpair does not acquire, hash,
certify or promise to retain their bytes. Durable delivery requires the caller
to preserve inspected contents where it is authorized to.

grokpair does not read or migrate earlier runtime stores;
they stay where they are until their owner decides otherwise.

## Decisions and retention

Native questions, permissions, plans and elicitation can expose source text,
tool input, choices, schemas, URLs or service identity. Answering can disclose
information through Grok to a requesting service. A form does not supply
consent: the caller must stay within the authority it already has. grokpair
does not fetch elicitation URLs or infer authentication from completion
notices.

Expiry of a request, whether by exact prompt cancellation, native interaction
closure or worker loss, keeps its payload, IDs and expiry metadata. It ends
answerability, not retention, and does not establish that an earlier uncertain
answer was never delivered. Removal from the native queue is not prompt
cancellation or approval, and does not by itself expire a request.

Close can cancel work but deletes no retained text, turn text file, file
reference, native session or worktree. The bridge performs no automatic expiry,
migration or cleanup; Grok's native worktree retention still applies. Disposal
needs its own exact authority and does not resolve unknown effects. Native
files follow their owner's lifetime, not a wrapper guarantee,
and receiving a result does not authorize publishing it or attaching it for
third parties.
