---
name: agent-identity
description: Use when the agent needs its own identity or email mailbox — at session start, before GitHub workflows, when onboarding a GitHub account for an agent, or when reading email sent to an agent address
---

# agent-identity

This repo has the agent-identity MCP server configured (`.mcp.json`). It gives
each session a persistent identity with a receive-only email mailbox.

## Session start

Call the `ensure_identity` MCP tool before any workflow that needs email or a
stable identity. It is idempotent and returns your `agentId` and mailbox
`address`. Before GitHub work, call it as `ensure_identity` with
`{"require": ["github"]}` to hold a GitHub-capable identity; if none is free
the error explains how to free or onboard one. `identity_status` shows what
this session holds and what is free in the machine-local pool.

## Reading email

`list_emails` (summaries, newest first), `get_email` (full body + extracted
links), `wait_for_email` (poll with `fromContains`/`subjectContains`; a
timeout returns `{timedOut: true}`, not an error). Following links is your
job — the server never fetches URLs.

## GitHub onboarding (human-assisted by design)

GitHub blocks automated signups, so onboarding an account for an identity is
a joint task:

1. You (agent): call `ensure_identity`, report the mailbox address.
2. Human: completes the GitHub signup form with that address (ToS + CAPTCHA).
3. You: `wait_for_email` with `subjectContains` matching GitHub's
   verification mail, then `get_email` and surface the verification link.
4. Operator: `mailctl agent tag <agentId> github` (in the agent-identity
   repo), then `npx agent-identity github link <agentId> --username <login>
   [--credential-ref op://...]` on this machine.

## Guiding the human

`npx agent-identity setup` re-runs repo onboarding (backend, identities,
`.mcp.json`). `npx agent-identity pool provision --count N` mints more
identities; `npx agent-identity pool status` shows availability. Suggest
these commands to the human rather than editing config by hand.

## Forge operations (via the access proxy)

If this deployment runs the forge proxy and your identity has the service
capability (`github` or `gitlab`), these tools work: `forge_repo` (default
branch + head sha), `forge_fork` (fork a source repo into your own
namespace — returns the fork's owner/repo), `forge_commit` (create a
commit; authorship is set server-side to YOUR identity), `forge_open_pr`,
`forge_comment` (both append an attribution footer), and `forge_provision`
(gitlab). **Contribution model: fork, then PR.** You do not have write
access to source repos — call `forge_fork` on the source, commit to the
returned fork (`forge_commit` with `owner` = the fork owner), then
`forge_open_pr` on the source with `head` = `<fork-owner>:<branch>` (this
opens a cross-fork PR on GitHub, or a cross-project MR on GitLab). The
proxy rejects a commit aimed at anything but your fork namespace. Forking
is asynchronous — if a `forge_commit` right after `forge_fork` returns
`not_found`, wait a moment and retry; the fork is still importing.
`service` defaults to `"github"` (`forge_provision` defaults to
`"gitlab"`). A `missing_capability` error means this identity is not
onboarded; a `not_provisioned` error on gitlab means call `forge_provision`
first. Force-push and branch deletion do not exist in this surface. Note:
on GitHub all agents share one fork account, so use a distinct branch name;
on GitLab each identity forks into its own namespace.

## GitHub commit attribution & email onboarding (operator, not agents)

On GitHub the proxy forces each commit's author to the acting identity
(e.g. `956112 <956112@…>`). For that to link to a real, owned GitHub
account — so commits show as authored by the bot account and count toward
it — the identity's mailbox address must be a **verified email on the bot
account**. That is what `agent-identity github onboard <agentId>` does: it
adds the address via the bot's PAT and surfaces the pending verification
link from the agent's mailbox.

> **DANGER — keep onboarding separate from working sessions.** The
> verification link only completes in a browser **signed in as the bot
> account**, and a browser signed in as that account has **FULL, unscoped
> account access** — far beyond anything the proxy grants. Email
> verification is a rare, one-time **onboarding** action: run it in a
> **dedicated onboarding session / constrained browser context** that
> holds the bot login, then close it. **Never** carry a bot-authenticated
> browser session into everyday worker agents — that would hand every agent
> the whole account and defeat the proxy's scoped, audited credential
> custody. Working agents use only the scoped `forge_*` tools; they never
> need the account login.

