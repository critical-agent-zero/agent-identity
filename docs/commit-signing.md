# Commit signing — Verified agent commits

*Part of [forge access](forge-access.md).*

By default the forge proxy makes commits that GitHub shows as *Unverified*.
Turn on commit signing and those same commits carry the green *Verified*
badge — without changing who gets credit for the work.

The attribution is a deliberate two-part split:

- **Author = the agent.** The commit's author name and email stay the acting
  agent identity, exactly as an unsigned commit. `git log` and the GitHub UI
  attribute authorship to the agent.
- **Committer = the signing bot.** The proxy stamps the committer as a
  dedicated bot account and SSH-signs the commit with an ed25519 key whose
  public half is registered as a *signing key* on that bot's account. GitHub
  checks the signature against that key and reports `verified: true`.

So a signed commit reads as **"authored by ⟨agent⟩, committed & signed by
⟨bot⟩."** The split is the point: the agent keeps authorship credit, while the
signature is anchored to a real, revocable forge account you control — no agent
ever holds a signing key, and the operator's own account is never the committer.

## How it works

The proxy constructs the canonical git commit object itself — the exact bytes
`git cat-file commit` would emit: `tree`, a `parent` line per parent, `author`,
`committer`, a blank line, then the message. It SSH-signs those bytes (the
SSHSIG format, namespace `git`, hash `sha512`) using only `node:crypto` — no
new dependency — and sends the signature to GitHub's git-data create-commit
API alongside the fields.

A subtlety that shaped the design: the credential the proxy uses to *write* the
commit does not, by itself, make that commit *Verified* on the git-data API —
writing and signing are separate concerns — so the proxy signs the commit
object itself. One timestamp is captured for both the author and committer
dates *and* the signed bytes, and the message is newline-terminated, so the
object GitHub reconstructs from the API fields is byte-identical to what was
signed. If it weren't, GitHub would report the signature invalid.

## Enabling it (operator setup)

Signing is off until you configure it. Two things are required — SSM parameters
the proxy reads, and a public key registered on the bot's GitHub account.

> **Prerequisite.** Signing is layered on a *working* GitHub commit path. Make
> sure GitHub commits already succeed through the proxy (the fork-namespace PAT
> at `.../github/pat` + `-c githubForkOwner=<bot-login>`, per
> [forge access → Operator setup](forge-access.md#operator-setup-brief)) before
> adding signing. The signing key, the `signing-committer-email`, and the
> commit credential must all belong to the **same** GitHub account — the
> fork-owner bot — or GitHub cannot anchor the signature. The bot may be that
> existing `githubForkOwner` account or a dedicated one, as long as everything
> lives on it.

**1. Generate a passphraseless ed25519 key** in a clean directory (a dedicated
key for this bot, used for nothing else):

```bash
ssh-keygen -t ed25519 -N '' -C 'agent-identity commit signer' -f ./commit-signing-key
```

This writes the private key to `commit-signing-key` and the public key to
`commit-signing-key.pub`. (Run it somewhere empty — `ssh-keygen` prompts to
overwrite if the file already exists.)

**2. Store three SSM parameters** under `/agent-identity/forge/github`, in the
**same region as the deployed stack** (the proxy Lambda only reads its own
region — the examples here use `us-east-1`; match yours). They are readable
only by the proxy Lambda:

| Parameter | Value |
|---|---|
| `signing-key` | **SecureString.** The **private** key file contents (`commit-signing-key`). Must be a passphraseless OpenSSH ed25519 key — encrypted or non-ed25519 keys are rejected. |
| `signing-committer-name` | The bot's git committer name (e.g. `critical-agent-zero`; typically the bot's login, but it is a display name, not an auth field). |
| `signing-committer-email` | A **verified or no-reply** email on the bot's GitHub account (e.g. `<id>+<login>@users.noreply.github.com`, using that account's real numeric id + login). |

```bash
aws ssm put-parameter --region us-east-1 --overwrite --type SecureString \
  --name /agent-identity/forge/github/signing-key --value "file://commit-signing-key"
aws ssm put-parameter --region us-east-1 --overwrite --type String \
  --name /agent-identity/forge/github/signing-committer-name --value "<committer-name>"
aws ssm put-parameter --region us-east-1 --overwrite --type String \
  --name /agent-identity/forge/github/signing-committer-email --value "<verified-or-noreply-email>"
```

The `file://` prefix loads the whole multi-line key as the value and keeps the
secret out of your shell history. `--overwrite` lets you re-run these to rotate
the key or fix the committer email. The proxy Lambda's role needs
`ssm:GetParameters` on this path **and** `kms:Decrypt` on the SSM key for the
new SecureString — if `.../github/pat` was a plain `String`, decrypt may not be
granted yet, so redeploy the stack if its policy enumerates parameter names or
lacked decrypt. Signing takes effect on the Lambda's next cold start.

**3. Register the public half as a *Signing key*** on the bot account: GitHub →
*Settings → SSH and GPG keys → New SSH key → Key type: **Signing Key***, paste
`commit-signing-key.pub`. This is a different slot from an *Authentication*
key — a key registered only for auth will **not** make commits verified (GitHub
reports `unknown_key`). You may add the same public key twice, once under each
type, if you also want it for auth.

## Behavior

- **No `signing-key` set** → commits are unsigned, exactly as before. Nothing
  breaks; they simply show *Unverified*.
- **`signing-key` set but committer name/email missing** → the commit **fails
  closed** (the proxy throws before writing anything). A half-configured signer
  never silently emits an unsigned or unverifiable commit — fix the config.
- The private key is **never logged** and never appears in an error message.
- Signing runs inside the shared commit path, so it covers commits of any size,
  including blob-streamed large files.

## Verifying

Make one test commit through the proxy, then check its verdict:

```bash
gh api repos/<owner>/<repo>/commits/<sha> --jq '{author: .commit.author.name, committer: .commit.committer.name, verified: .commit.verification.verified, reason: .commit.verification.reason}'
```

A correctly-signed commit returns `verified: true`, `reason: valid`, with the
author your agent identity and the committer your bot.

### If `verified` is false

`verified: false` has several causes; the `reason` field says which:

| `reason` | Meaning & fix |
|---|---|
| `unsigned` | No signature at all — no `signing-key` is configured (or it hasn't taken effect yet; allow a cold start). |
| `unknown_key` | The public key isn't registered as a **Signing** key on the bot account (or is registered only as an Authentication key). Add it under *SSH and GPG keys* with type *Signing Key*. |
| `unverified_email` | `signing-committer-email` is on the bot account but unconfirmed. Verify the email, or use the account's `…@users.noreply.github.com` address. |
| `bad_email` / `no_user` | The committer email isn't associated with the bot account at all (typo, or a foreign domain). Add & verify it on the account, or use its `<id>+<login>@users.noreply.github.com` address. |
| `invalid` | The signature itself doesn't match the commit bytes — a byte-reconstruction bug in the proxy, not account setup. File it; don't reconfigure keys. |

The account-side reasons (`unknown_key`, `unverified_email`, `bad_email`,
`no_user`) are setup the proxy can't see — it emits a valid signature and trusts
your registration. Verification is deterministic: a signed commit won't flip
states on its own — it stays *Verified* as long as the signing key remains
registered on the bot account (revoke the key and past commits show
*Unverified* again, which is exactly the revocability you want).

Once a test commit shows `verified: true`, remove your local key copy — the
authoritative copy is the encrypted SSM SecureString, and the key content never
touched your shell history (only its filename, via `file://`):

```bash
# optional: confirm SSM holds the key intact before deleting the local copy
aws ssm get-parameter --region us-east-1 --with-decryption \
  --name /agent-identity/forge/github/signing-key --query Parameter.Value --output text \
  | diff - commit-signing-key && echo "SSM matches local key"

rm -P commit-signing-key   # macOS; on GNU/Linux: shred -u commit-signing-key
```

(On APFS/SSD the overwrite isn't a guaranteed secure-erase — the real
protection is that the key only ever lived in this file and in encrypted SSM.)

### Signed commits and branch protection

If a branch requires signed commits (GitHub *rulesets* → *Require signed
commits*), an **unsigned** commit — including any commit made through the proxy
before signing was enabled — can't be merged into it (`mergeStateStatus:
BLOCKED`). Re-deliver the change through the proxy with signing on, and the new
signed commit clears the rule.

## GitLab

Commit signing is GitHub-only. GitLab commits made through the proxy are
unsigned, unchanged.
