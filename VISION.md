# Grok as extra arms for the calling agent

grokpair exists to make a calling agent better at the task in front of it. It
gives the agent disposable intelligence and extra arms: a Grok collaborator it
can hand a bounded piece of work, keep working beside, and then consult. Used
well, it improves the caller's work, keeps long investigations out of the
caller's context, and raises the signal and quality of whatever the task is:
an independent review or counterexample, research with sources, a candidate
implementation to compare, a document, images or video. The agent using it is
the product's user, so grokpair has to be ergonomic for an agent: little to
learn, few calls, results it can use without reconstructing them.

It serves whichever harness the caller runs in. Codex and Claude Code are the
hosts it must serve well; any MCP host or any agent with a shell can use it
too, and all of them share one store, so a collaborator started in one is
visible from another.

## What makes a contribution useful

A contribution is useful when it changes what the caller does: a finding it
did not have, a candidate it can test, an objection it has to answer, an asset
it can place. Wrapper reports, ceremonial rounds and a fixed number of turns
do not give delegation its purpose. The caller supplies the context Grok needs
in a self-contained brief, receives what Grok actually said and made, and
chooses what to use.

Follow-up and discussion earn their place when they improve the contribution.
Native questions from Grok are the caller's to decide within the authority it
already holds; they do not return ordinary delegated decisions to the human.
The caller keeps overall responsibility, credentials, integration and
publication.

## Preserve native capability without inventing it

Grok owns its model, reasoning, instructions, skills, tools, queue, background
tasks and conversation, and grokpair inherits its identity and defaults.
Choosing a model or effort is an explicit session setting, not a side effect of
every follow-up. Native requests reach the caller in their own method and
response vocabulary.

A real `cwd` lets Grok work where the task is, including creating documents or
media without Git. Optional isolation uses Grok's native worktree creation and
copy rules; optional sandbox selection requests a native profile independently.
Omitting the selection leaves Grok's native configuration in charge.
References hand Grok actual local files and images hand it actual images.
Native tools own reading documents, extracting, converting and producing
media; no wrapper catalog can stand in for their availability or their
successful use.

## Authentic contribution, deliberate acceptance

Root text is kept in the order Grok produced it, and side answers stay
separate. Admission, execution, native completion, delivery and acceptance are
different facts: useful partial output can survive a failed operation without
making it a success, and background work keeps its own identity and outcome.

The caller inspects actual changes, file contents and media before adopting
them. Native file references are mutable, not certified artifacts, and a file
Grok mentions may be an input or a place a tool looked rather than a new
output. When visual or auditory quality is part of the request, seeing or
hearing the result is part of accepting it.

## Ergonomic for the agent that calls it

A caller should get Grok's answer in one wait and read it as turns of text,
not rebuild it from a record stream; the full stream is there when it needs
the queue, options or every operation. Paged reads keep the answer reachable
when a host shortens a result; a finished turn's complete text is also offered
as a plain file when its write succeeds. Retained text outlives crashes,
restarts and close. One cursor continues both reading and
waiting. A spawn key makes a retried or re-run step return the same
collaborator instead of paying for a second one. The same eight calls work as
MCP tools or as a command, and in Claude Code a relay agent can run the whole
cycle in the background.

## One thin bridge

Eight tools and a complete operating skill connect the caller to one resident
worker per collaborator through a transactional SQLite mailbox and the
official ACP SDK. The mailbox keeps admissions and useful observations, not a
duplicate archive of Grok's reasoning, tool output or conversation.

Honest unknown queue state is better than inferred emptiness, and complete
native decision payloads are better than a truncation that makes the decision
unusable. Limits follow real native or protocol boundaries, not editorial
convenience. Losing the worker leaves uncertainty rather than guesses: reading
is passive and recovery never replays old work. Close is deliberate, can stop
active work and deletes no contribution or native data.

[PLAN](PLAN.md) owns implementation and proof, [RELEASE](RELEASE.md) delivery.
Correct source, a working installation in each host and useful collaboration
are separate requirements for an end-to-end result.
