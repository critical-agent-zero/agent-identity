# Self-hosting agent-identity

This is the complete guide to deploying your own agent-identity backend on
AWS. It is written step by step so an AI agent can drive a human through it:
each step says what to run, what it produces, and how to check it worked.
Budget a few hours end to end, much of it waiting on DNS.

## Prerequisites

- An **AWS account** with credentials that can create IAM roles, Lambda
  functions, DynamoDB tables, S3 buckets, API Gateway APIs, and SES
  resources (admin credentials are simplest).
- A **domain you control DNS for**. Agent mail arrives at `<id>@<domain>`,
  so you must be able to add MX, CNAME, and TXT records. A subdomain such as
  `mail.example.com` works well and keeps the MX record off your root
  domain.
- **Node.js 20+** and **pnpm 9+** (the lockfile is pnpm lockfile v9; pnpm 8
  fails at `pnpm install`).
- The **AWS CLI**, configured — `aws sts get-caller-identity` should print
  your account.

### Credential custody

The AWS credentials used in this guide **are** operator power over the
deployment: fleet, admin, and viewer keys are minted as plain DynamoDB
writes, so any process that can read your AWS credentials plus the table
name can mint itself an admin key, tag capabilities, and revoke identities.
Run every step in an operator-only shell, on a machine (or OS user) that
does not run agent sessions, and never leave AWS credentials readable on
machines that do. Ongoing administration needs only DynamoDB read/write on
the one table — after setup, scope down or remove account-admin credentials
from wherever they landed.

### Region constraint

SES inbound email is only available in **us-east-1**, **us-west-2**, and
**eu-west-1**. The whole stack must deploy into one of those regions.

Pick the region now and export it — every command in this guide uses it:

```bash
export AWS_REGION=us-east-1   # or us-west-2 / eu-west-1
```

`AWS_REGION` is the variable that actually pins the deploy region. Do
**not** rely on `CDK_DEFAULT_REGION`: the CDK CLI overwrites it inside the
app from its own resolution (`AWS_REGION` → profile → instance metadata),
so exporting it has no effect. With `AWS_REGION` unset, the stack deploys
into your AWS CLI profile's default region — which may be a region with no
SES inbound. If you return in a new shell (for example after waiting on
DNS), re-export `AWS_REGION` before continuing.

## 1. Install and bootstrap

From the repo root:

```bash
pnpm install
```

If this AWS account + region pair has never hosted a CDK deployment,
bootstrap it once:

```bash
cd infra
npx cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/$AWS_REGION
```

Success looks like `✅  Environment aws://<account>/<region> bootstrapped`
(or `(no changes needed)` if it was already bootstrapped).

## 2. Deploy the stack

```bash
cd infra
npx cdk deploy -c domain=mail.example.com
```

Substitute your mail domain. To keep the domain out of shell history and
`ps`, you can pass it as an environment variable instead:
`MAIL_DOMAIN=mail.example.com npx cdk deploy` — the app accepts either.

The deploy first shows an IAM-changes diff and stops at an approval prompt
(`Do you wish to deploy these changes (y/n)?`) — answer `y`; it is a prompt,
not a hang. It then takes a few minutes and ends with four outputs and the
stack ARN — record all of them:

| Output | What it is |
|---|---|
| `ApiUrl` | The HTTPS endpoint agents talk to (`https://<api-id>.execute-api.<region>.amazonaws.com`) |
| `MxRecord` | The MX record to add to DNS in step 3 |
| `ReceiptRuleSetName` | The SES receipt rule set to activate in step 4 |
| `TableName` | The DynamoDB table name, needed for `mailctl` admin commands |

### API throttling

The API is rate-limited by default — 25 requests/second steady state, 50
burst, across all routes — so a discovered endpoint cannot run up your
Lambda/DynamoDB bill. Every request costs a Lambda invoke plus a DynamoDB
write, which is why throttling is on by default and tunable rather than
removable. Raise it if your fleet needs more headroom:

```bash
npx cdk deploy -c domain=mail.example.com -c apiThrottleRate=100 -c apiThrottleBurst=200
```

### Deploy-time context flags

All configuration is passed as `-c` context flags. They are **not
remembered between deploys**: pass every non-default flag on every
`cdk deploy`, or the value silently reverts to its default.

| Flag | Default | What it does |
|---|---|---|
| `domain` | required (or `MAIL_DOMAIN` env) | The mail domain |
| `apiThrottleRate` / `apiThrottleBurst` | 25 / 50 | Stage throttle (above) |
| `senderAllowlist` | `github.com,gitlab.com` | Sender domains delivered unflagged (comma-separated; subdomains match implicitly). Mail from any other domain is stored with `unsolicited: true` — flagged, not dropped — hidden from default reads unless requested with `GET /emails?includeUnsolicited=true`, and never produces an activity-ledger event. Any fleet expecting mail from other senders must extend this list. |
| `publicRepos` | empty (fail closed) | Repos the unauthenticated public fleet view may mention — see [Public fleet view](#public-fleet-view-no-credential) before setting |
| `githubForkOwner` | empty (GitHub commits denied) | Bot account owning agent forks — see [Forge proxy](#forge-proxy-github--gitlab) |

The retention window (90 days) is a stack prop, not a context flag —
changing it means editing `retentionDays` in `infra/bin/app.ts`.

## 3. Verify the domain in SES and add DNS records

SES email identities are region-scoped: this identity must be created in
the stack's region, which is why the commands below carry `--region` — run
them in the shell where `AWS_REGION` is exported.

Create the SES email identity for your domain:

```bash
aws sesv2 create-email-identity --email-identity mail.example.com --region "$AWS_REGION"
```

Then add DNS records at your DNS provider:

1. **Three DKIM CNAME records** — the command's output lists three DKIM
   tokens; for each, add `<token>._domainkey.mail.example.com` CNAME
   `<token>.dkim.amazonses.com`.
2. **The domain verification TXT record**, if the SES console (or
   `aws sesv2 get-email-identity --email-identity mail.example.com --region "$AWS_REGION"`)
   shows one for your identity.
3. **The MX record** from the stack's `MxRecord` output:
   `mail.example.com MX 10 inbound-smtp.<region>.amazonaws.com`.

Wait for verification — usually minutes, occasionally longer while DNS
propagates. Repeat this until it prints `true`:

```bash
aws sesv2 get-email-identity --email-identity mail.example.com \
  --query VerifiedForSendingStatus --region "$AWS_REGION"
```

### SES sandbox

The SES sandbox does **not** affect receiving — production access only gates
outbound sending, and this stack only receives — so no production-access
request is needed.

## 4. Activate the receipt rule set

> **Warning — read before running the command below.** An AWS account has
> exactly one active receipt rule set per region, and
> `set-active-receipt-rule-set` swaps it wholesale. If this account already
> receives mail through SES, activating the new set silently disconnects
> the existing pipeline. In that case do **not** switch sets: copy this
> stack's rule (the S3 action writing to the mail bucket under `raw/`, then
> the Lambda action invoking the ingest function) into the already-active
> rule set instead — via
> `aws ses create-receipt-rule --rule-set-name <active-set-name> ...` or the
> SES console — and leave the active set as it is. Also note: the CI deploy
> workflow ([below](#deploying-from-ci-github-actions)) runs
> `set-active-receipt-rule-set` unconditionally on every push to `main` —
> on an account with an existing SES pipeline, disable or edit that step
> too, or the next CI deploy re-deactivates your pipeline.

CDK creates the receipt rule set but cannot activate it; on an account with
no existing SES receiving, activate it manually:

```bash
aws ses set-active-receipt-rule-set \
  --rule-set-name <ReceiptRuleSetName from step 2> --region "$AWS_REGION"
```

The command prints nothing on success. Confirm the right set is active — it
should print the `ReceiptRuleSetName` from step 2:

```bash
aws ses describe-active-receipt-rule-set --query Metadata.Name --region "$AWS_REGION"
```

## 5. Mint operator keys

All key minting and admin commands run from the repo root, with operator
AWS credentials and `AWS_REGION` exported (`mailctl` talks directly to the
DynamoDB table and resolves its region from the environment). Each key is
shown once at mint time; store it then.

### Fleet key (agents register with it)

Registration is gated by a fleet key by default:

```bash
AGENT_IDENTITY_TABLE=<TableName from step 2> \
  npx tsx packages/admin/src/mailctl.ts fleet-key create --label <label>
```

Success: it prints `Fleet key (shown once, store it now):` followed by the
key. Give it to your agents via the `AGENT_IDENTITY_FLEET_KEY` environment
variable. The setup wizard stores it at
`~/.config/agent-identity/fleet_key` (mode 600).

### Admin key (operator-only; guard it)

The admin key gates the capability-admin HTTP routes
(`POST`/`DELETE /admin/agents/:id/capabilities`) and is what
`agent-identity github enable|disable` authenticates with:

```bash
AGENT_IDENTITY_TABLE=<TableName from step 2> \
  npx tsx packages/admin/src/mailctl.ts admin-key create --label <label>
```

Custody rules — it grants capability admin over every identity:

- Put it in `AGENT_IDENTITY_ADMIN_KEY` or
  `~/.config/agent-identity/admin_key` (0600). **Never export it into an
  agent session's environment.**
- 0600 does not protect the key file from agent sessions running as the
  same OS user — they can read it. On machines that run agents, prefer the
  env var in an operator-only shell, or a separate operator OS user.

### Viewer key (read-only dashboard access)

```bash
AGENT_IDENTITY_TABLE=<TableName from step 2> \
  npx tsx packages/admin/src/mailctl.ts viewer-key create --label <label>
```

The viewer key is read-only by construction: `/fleet/*` GET routes accept
it, and presented anywhere else it fails signature auth. It is safe to hand
to a dashboard user; see [Fleet dashboard](#fleet-dashboard-viewer-key).

### Fleet administration commands

The same `mailctl` CLI (invoked as above, with `AGENT_IDENTITY_TABLE` set)
is the operator's kill switch and capability lever:

| Command | What it does |
|---|---|
| `mailctl agent list` | List all identities with status and capabilities |
| `mailctl agent revoke <agentId>` | Refuse the agent's future signatures (they get 403; the numeric ID is never reused) |
| `mailctl agent tag <agentId> <capability>` | Grant a capability — e.g. `github`, a prerequisite for the forge proxy |
| `mailctl agent untag <agentId> <capability>` | Remove a capability |

## 6. Smoke test

On a machine that will run agents, from the root of the repo those agents
will work in — the wizard writes `.mcp.json` and installs the Claude Code
skill into the **current directory**, so running it in `$HOME` onboards the
wrong directory:

```bash
npx -y -p @critical-labs/agent-identity agent-identity setup
```

At the first prompt choose **`[1] connect to an existing deployment`**. On
a fresh machine (no config, no fleet key) the default is
`[2] deploy a new one`, so pressing enter blindly drops you into a second
full deployment checklist right after finishing the first. (Exporting
`AGENT_IDENTITY_FLEET_KEY` before running setup flips the default to
`[1]`.) Paste the `ApiUrl` from step 2 and the fleet key from step 5.

Then have an agent call `ensure_identity` — it returns an `agentId` and an
address like `482913@mail.example.com` — send a test email to that address,
and read it back with `wait_for_email`.

**The test email must come from an allowlisted sender domain.** Ingest
flags mail from any domain not on the sender allowlist (default
`github.com,gitlab.com`) as unsolicited and hides it from default reads,
and the MCP tools have no opt-in for flagged mail — so a test sent from a
personal address arrives, is stored, and `wait_for_email` still returns
`{timedOut: true}` on a perfectly healthy stack. Either redeploy first with
your test sender's domain on the allowlist:

```bash
npx cdk deploy -c domain=mail.example.com -c senderAllowlist=gmail.com,github.com,gitlab.com
```

or verify delivery out-of-band with a signed
`GET /emails?includeUnsolicited=true`.

Success: `wait_for_email` returns the message's `from` and `subject` — not
`{timedOut: true}`.

## 7. Operate it

### Fleet dashboard (viewer key)

```bash
npx -y -p @critical-labs/agent-identity agent-identity fleet
```

Success: it prints `fleet dashboard: http://127.0.0.1:4820/` (change with
`--port`). Open that URL and connect with your `ApiUrl` and a viewer key
from step 5. Server-side, every `/fleet/*` route demands the
`x-viewer-key` header; the stack's CORS configuration exists for exactly
this browser surface — cross-origin GETs only, writes stay
browser-hostile.

### Public fleet view (no credential)

The deployed API answers `GET /fleet/public/agents` and
`GET /fleet/public/activity` with **no credential at all**, rate-bounded
only by the stage throttle. What they show is controlled by
`-c publicRepos` (comma-separated `owner/repo` or `owner/*` patterns,
matched case-insensitively). The default is empty, which fails closed: the
public view shows no forge events.

Before setting it, know the hazard: patterns are **name** matches, not a
visibility check — `owner/*` also covers every **private** repo that owner
has now or gains later. The second gate is the attestation-time
`detail.visibility === "public"` stamp (the repo's actual visibility, read
from the forge): only stamped-public events are ever shown, and events
attested before stamping existed are never shown publicly.

### Forge proxy (GitHub / GitLab)

The stack always deploys the forge proxy (`/forge/*` routes, with SSM
access to `/agent-identity/forge/*`), but it does nothing until configured:

1. **Fork owner** — redeploy with `-c githubForkOwner=<bot-login>`. The
   default is empty, which **denies all GitHub commits** until set.
2. **GitHub PAT** — a classic PAT with `repo` scope, owned by the bot
   account that owns the forks. It should be able to fork sources and push
   to the bot's own forks, never to source repos:
   ```bash
   aws ssm put-parameter --name /agent-identity/forge/github/pat \
     --type SecureString --value <PAT> --region "$AWS_REGION"
   ```
3. **GitLab** (if used) — a group Owner token and the top-level group id:
   ```bash
   aws ssm put-parameter --name /agent-identity/forge/gitlab/admin-token \
     --type SecureString --value <group-owner-token> --region "$AWS_REGION"
   aws ssm put-parameter --name /agent-identity/forge/gitlab/group \
     --type String --value <top-level-group-id> --region "$AWS_REGION"
   ```
4. **Per-agent grant** — the proxy only acts for identities holding the
   capability: `mailctl agent tag <agentId> github`, or
   `agent-identity github enable <agentId>` (authenticates with the admin
   key from step 5).

See [docs/forge-access.md](../docs/forge-access.md) for the model and
credential-holding rationale.

### Registration gating

`POST /register` requires the fleet key because the Api Lambda's
`FLEET_KEY_REQUIRED` env var is unset — the check is skipped only when that
var is the literal string `false`. The stack never sets it, so a fresh
deploy is always gated. Two reasons to know this: if you want an
open-registration instance, set `FLEET_KEY_REQUIRED=false` on the Api
Lambda; and if you inherit a deployment, audit that env var before trusting
that registration is closed.

## Deploying from CI (GitHub Actions)

The repo ships `.github/workflows/deploy.yml`: it tests, then runs an
OIDC-authenticated `cdk deploy` on every push to `main` (or on demand via
`workflow_dispatch`) — no long-lived AWS keys in GitHub. One-time setup:

1. Bootstrap the CDK toolkit in the target account + region (step 1).
2. Create the OIDC provider and deploy role using the template from **your
   own checkout**, naming **your** repository:

   ```bash
   aws cloudformation deploy --template-file infra/github-oidc.yml \
     --stack-name agent-identity-github-oidc --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides GitHubOrg=<your-org> GitHubRepo=<your-repo>
   ```

   The template's parameter defaults name the upstream repo
   (`critical-labs/agent-identity`). Deploy it without the overrides and
   the role trusts **upstream's** repository — upstream maintainers could
   then deploy into your AWS account; the role delegates to the account's
   `cdk-*` roles, which is admin-equivalent. Add `CreateOidcProvider=false`
   to the overrides if the account already has a GitHub OIDC provider.
3. In the repo: create an environment named `production`; set the secret
   `MAIL_DOMAIN` (it must be a **secret**, not a variable — the runner
   prints each step's env header before any `::add-mask::` a script could
   emit, and variables are never auto-masked); set the variables
   `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN` (the `DeployRoleArn` stack output),
   and `FORGE_GITHUB_FORK_OWNER`.

Two behaviors to know: the workflow runs
`aws ses set-active-receipt-rule-set` **unconditionally on every deploy**
(the step 4 warning applies — edit that step out on accounts with an
existing SES pipeline), and it suppresses stack outputs from the public
logs — read them with
`aws cloudformation describe-stacks --stack-name AgentIdentity --query 'Stacks[0].Outputs'`.
The [root README's CI/CD section](../README.md#cicd-github-actions) has the
full walkthrough.

## Cost expectations

Everything is pay-per-request; there is no idle compute cost, only storage:

- **Lambda + DynamoDB** — each API call is one Lambda invoke plus DynamoDB
  reads/writes (on-demand billing); each inbound email is one ingest invoke
  plus writes.
- **S3** — raw MIME and extracted bodies are stored per message and expire
  automatically after 90 days (7 days for unmatched mail), so storage does
  not grow without bound.
- **DynamoDB storage is bounded too** — email records and activity-ledger
  events carry a TTL attribute (`expiresAt`) on the same 90-day retention
  schedule. (The activity ledger — `POST /activity`, `GET /fleet/activity`,
  `GET /agents/me/activity` — is part of the same table and retention.)
- **API Gateway** — per-request pricing on the HTTP API.

The stage throttle from step 2 caps **API-originated** request costs: a
hostile client hammering the endpoint cannot push Lambda/DynamoDB costs
past what the configured rate sustains — single-digit dollars per day at
the 25 req/s default, and a typical fleet idles far below that. The
**inbound mail path is not throttled** by this stack: anyone on the
internet who knows the mail domain can send to it, and every message —
including hostile mail quarantined to `unmatched/` — costs an S3 write, an
ingest invoke, and DynamoDB writes. Set an AWS billing alarm as the actual
ceiling on the bill.

## Troubleshooting

**Mail never arrives; senders get a bounce.** Usually the receipt rule set
is not active — activation (step 4) is the step people skip because CDK
cannot do it. Check
`aws ses describe-active-receipt-rule-set --region "$AWS_REGION"`. Also
confirm the MX record resolves: `dig MX mail.example.com`.

**Mail arrives (visible in the S3 bucket) but `wait_for_email` times out.**
The sender's domain is not on the sender allowlist (default
`github.com,gitlab.com`), so the message was stored flagged
`unsolicited: true` and is hidden from default reads — and the MCP tools
have no opt-in for flagged mail. Redeploy with the sender's domain in
`-c senderAllowlist=...` (step 6), or read it with a signed
`GET /emails?includeUnsolicited=true`.

**SES says "Rule set does not exist"; `mailctl` throws
ResourceNotFoundException on a table that plainly exists.** The command ran
against a different region than the stack. Re-export
`AWS_REGION=<stack region>` (or add `--region` to the aws command) and
retry. Watch for the quiet variant: `create-email-identity` in the wrong
region *succeeds* and verifies, while the stack's region has no verified
identity and mail bounces.

**Deployed to a region without SES inbound.** If the stack landed anywhere
other than us-east-1, us-west-2, or eu-west-1, SES receiving does not exist
there: the receipt rule set cannot be activated and
`inbound-smtp.<region>.amazonaws.com` does not accept mail. The deploy
region came from `AWS_REGION`, or from your AWS CLI profile when it was
unset — check `echo $AWS_REGION` and `aws configure get region`
(`CDK_DEFAULT_REGION` has no effect; see the region constraint above).
Recovery: destroy the misplaced stack (from `infra/`:
`AWS_REGION=<wrong-region> npx cdk destroy`), then redo steps **1–5** in a
supported region — including step 1's bootstrap, which is per
account + region. Note the DynamoDB table and mail bucket are deliberately
retained on destroy (`RemovalPolicy.RETAIN`): they survive in the wrong
region, contain nothing of value at this point, and should be deleted
manually so they don't confuse later audits.

**Domain stuck unverified.** The DKIM CNAMEs are the usual culprit —
confirm all three with `dig CNAME <token>._domainkey.mail.example.com`,
then re-check `aws sesv2 get-email-identity`.

**Agents cannot register or authenticate.** Registration failures usually
mean `AGENT_IDENTITY_FLEET_KEY` is missing or wrong on the agent's machine.
A 403 on signed calls means the agent was revoked
(`mailctl agent list` shows status; revocation is `mailctl agent revoke`),
or the request timestamp is outside the ±5 minute skew tolerance — check
the machine's clock.

**Agents get 429.** The stage throttle is doing its job. If legitimate
fleet traffic is being throttled, redeploy with higher
`apiThrottleRate`/`apiThrottleBurst` values (step 2).
