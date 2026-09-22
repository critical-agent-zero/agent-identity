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
- **Node.js 20+** and **pnpm**.
- The **AWS CLI**, configured — `aws sts get-caller-identity` should print
  your account.

### Region constraint

SES inbound email is only available in **us-east-1**, **us-west-2**, and
**eu-west-1**. The whole stack must deploy into one of those regions. The
stack defaults to `us-east-1`; to use another supported region, set
`CDK_DEFAULT_REGION` (and your AWS CLI region) before deploying.

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

## 2. Deploy the stack

```bash
cd infra
npx cdk deploy -c domain=mail.example.com
```

Substitute your mail domain. The deploy takes a few minutes and prints four
outputs — record all of them:

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

## 3. Verify the domain in SES and add DNS records

Create the SES email identity for your domain:

```bash
aws sesv2 create-email-identity --email-identity mail.example.com
```

Then add DNS records at your DNS provider:

1. **Three DKIM CNAME records** — the command's output lists three DKIM
   tokens; for each, add `<token>._domainkey.mail.example.com` CNAME
   `<token>.dkim.amazonses.com`.
2. **The domain verification TXT record**, if the SES console (or
   `aws sesv2 get-email-identity --email-identity mail.example.com`) shows
   one for your identity.
3. **The MX record** from the stack's `MxRecord` output:
   `mail.example.com MX 10 inbound-smtp.<region>.amazonaws.com`.

Wait for verification — usually minutes, occasionally longer while DNS
propagates:

```bash
aws sesv2 get-email-identity --email-identity mail.example.com \
  --query VerifiedForSendingStatus
```

### SES sandbox

The SES sandbox does **not** affect receiving — production access only gates
outbound sending, and this stack only receives — so no production-access
request is needed.

## 4. Activate the receipt rule set

CDK creates the receipt rule set but cannot activate it; activation is a
manual step:

```bash
aws ses set-active-receipt-rule-set --rule-set-name <ReceiptRuleSetName from step 2>
```

> **Warning: this REPLACES the account's active rule set.** An AWS account
> has exactly one active receipt rule set, and `set-active-receipt-rule-set`
> swaps it wholesale. If this account already receives mail through SES,
> activating the new set silently disconnects the existing pipeline. In that
> case do **not** switch sets: copy this stack's rule (the S3 action writing
> to the mail bucket under `raw/`, then the Lambda action invoking the
> ingest function) into the already-active rule set instead — via
> `aws ses create-receipt-rule --rule-set-name <active-set-name> ...` or the
> SES console — and leave the active set as it is.

Check what is active:

```bash
aws ses describe-active-receipt-rule-set --query Metadata.Name
```

## 5. Mint a fleet key

Registration is gated by a fleet key. Mint one from the repo root, with
operator AWS credentials:

```bash
AGENT_IDENTITY_TABLE=<TableName from step 2> \
  npx tsx packages/admin/src/mailctl.ts fleet-key create --label <label>
```

Give the resulting key to your agents via the `AGENT_IDENTITY_FLEET_KEY`
environment variable. The setup wizard stores it at
`~/.config/agent-identity/fleet_key` (mode 600).

### Smoke test

On a machine that will run agents:

```bash
npm install @critical-labs/agent-identity
npx -y -p @critical-labs/agent-identity agent-identity setup
```

Point the wizard at your `ApiUrl` and fleet key, have an agent call
`ensure_identity`, send a test email to the address it returns, and read it
back with `wait_for_email`.

## Cost expectations

Everything is pay-per-request; there is no idle compute cost, only storage:

- **Lambda + DynamoDB** — each API call is one Lambda invoke plus DynamoDB
  reads/writes (on-demand billing); each inbound email is one ingest invoke
  plus writes.
- **S3** — raw MIME and extracted bodies are stored per message and expire
  automatically after 90 days (7 days for unmatched mail), so storage does
  not grow without bound.
- **API Gateway** — per-request pricing on the HTTP API.

The throttle from step 2 is the effective ceiling on the bill: even a
hostile client hammering the endpoint cannot push request costs past what
the configured rate sustains — single-digit dollars per day at the 25 req/s
default, and a typical fleet idles far below that.

## Troubleshooting

**Mail never arrives; senders get a bounce.** Usually the receipt rule set
is not active — activation (step 4) is the step people skip because CDK
cannot do it. Check `aws ses describe-active-receipt-rule-set`. Also
confirm the MX record resolves: `dig MX mail.example.com`.

**Deployed to a region without SES inbound.** If the stack landed anywhere
other than us-east-1, us-west-2, or eu-west-1, SES receiving does not exist
there: the receipt rule set cannot be activated and
`inbound-smtp.<region>.amazonaws.com` does not accept mail. Verify with
`aws configure get region` and `echo $CDK_DEFAULT_REGION`, destroy the
misplaced stack (`npx cdk destroy`), redeploy in a supported region, and
redo steps 3–5.

**Domain stuck unverified.** The DKIM CNAMEs are the usual culprit —
confirm all three with `dig CNAME <token>._domainkey.mail.example.com`,
then re-check `aws sesv2 get-email-identity`.

**Agents cannot register or authenticate.** Registration failures usually
mean `AGENT_IDENTITY_FLEET_KEY` is missing or wrong on the agent's machine.
A 403 on signed calls means the agent was revoked, or the request timestamp
is outside the ±5 minute skew tolerance — check the machine's clock.

**Agents get 429.** The stage throttle is doing its job. If legitimate
fleet traffic is being throttled, redeploy with higher
`apiThrottleRate`/`apiThrottleBurst` values (step 2).
