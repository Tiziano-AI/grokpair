<img src="skills/grokpair/assets/grokpair.png" width="72" height="72" alt="">

# grokpair

Give your agent a Grok Build collaborator for research, an independent review,
an alternative implementation, a document or media. Grok works in its own
conversation while your agent continues; your agent inspects the result and
decides what to use.

## Before first use

- Stable Node.js 24, version 24.22.1 or later within 24.x (`^24.22.1`),
  available as `node` on the host's `PATH`. Other majors are not supported
  and are rejected before command dispatch.
- Grok Build installed, authenticated and available as `grok` on that `PATH`.
- Git and a source repository only when requesting a native worktree.

Bring your own Grok Build account. Inference and connected services use that
account and its native billing; Grokpair includes no account or usage. This
payload is prebuilt and needs no dependency installation to run. Installing
the plugin does not install Grok Build, sign you in or start a collaborator.

## Install

Add the shared Tiziano AI catalog and select Grokpair in your host:

```bash
# Codex
codex plugin marketplace add Tiziano-AI/plugins
codex plugin add grokpair@tiziano-ai

# Claude Code
claude plugin marketplace add Tiziano-AI/plugins
claude plugin install grokpair@tiziano-ai --scope user
```

Follow the [installation and host setup guide](https://github.com/Tiziano-AI/grokpair#install),
including disabling Grokpair in Grok Build's own plugin configuration when it
loads your Claude Code plugins. Grokpair leaves approvals with your host's
normal policy; it ships no standing approval override.

## First contribution

Start a fresh Codex or Claude Code caller after installation, then ask:

> Use grokpair to review this proposal read-only while you check it
> independently. Give Grok the relevant sources and ask for the strongest
> supported reason to change it. Read the full answer and check the findings
> before adopting them. Do not edit files, contact anyone or publish.

The installed [operating skill](skills/grokpair/SKILL.md) covers briefing,
waiting, corrections in the same conversation and closure. Your caller stays
responsible for credentials, integration, publication and final claims.
Closing a collaborator can cancel active work; it deletes no retained result
or native session.

For complete setup, updates and removal, see the
[repository guide](https://github.com/Tiziano-AI/grokpair#readme).
[Privacy](https://github.com/Tiziano-AI/grokpair/blob/main/PRIVACY.md) explains
retained data; [security](https://github.com/Tiziano-AI/grokpair/blob/main/SECURITY.md)
explains workspace and authority boundaries. [MIT license](LICENSE) and
[third-party notices](THIRD_PARTY_NOTICES.md) ship with this payload.
