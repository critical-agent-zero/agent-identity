import type { ActivityRepo, AgentRecord, AgentsRepo, EmailsRepo, NewEmail } from "@agent-identity/api";
import {
  matchesMailboxAllowlist, matchesSenderDomain, sanitizeAttestedEvent, sanitizeMailText,
  senderDomain,
  type AuthVerdictStatus, type EmailAuthVerdicts, type MailboxRejectReason,
} from "@agent-identity/shared";
import type { SESEventRecord, SESReceipt } from "aws-lambda";
import { parseEmail } from "./parse.js";

export interface IngestDeps {
  getRaw: (s3Key: string) => Promise<Buffer>;
  putBodyOverflow: (agentId: string, emailId: string, body: object) => Promise<string>;
  quarantineRaw: (messageId: string) => Promise<void>;
  // getByLocalPart resolves an exact local-part; getCatchAllMailbox (optional
  // so a self-hoster mid-upgrade keeps working) resolves the domain catch-all
  // mailbox for unknown local-parts.
  agents: Pick<AgentsRepo, "getByLocalPart"> & Partial<Pick<AgentsRepo, "getCatchAllMailbox">>;
  emails: Pick<EmailsRepo, "putEmail">;
  /** Attested activity ledger. Optional so a self-hoster's ingest keeps
   *  working mid-upgrade before the ledger exists. */
  activity?: Pick<ActivityRepo, "putEvent">;
  maxInlineBodyBytes: number;
  /** Sender domains whose mail delivers unflagged; anything else is stored
   *  with unsolicited: true and hidden from default reads. */
  senderAllowlist: string[];
}

// Missing verdicts (scanning disabled by a self-hoster) yield undefined, never a guess.
function captureAuth(receipt: SESReceipt): EmailAuthVerdicts | undefined {
  const auth: EmailAuthVerdicts = {};
  if (receipt.spfVerdict?.status) auth.spf = receipt.spfVerdict.status as AuthVerdictStatus;
  if (receipt.dkimVerdict?.status) auth.dkim = receipt.dkimVerdict.status as AuthVerdictStatus;
  if (receipt.dmarcVerdict?.status) auth.dmarc = receipt.dmarcVerdict.status as AuthVerdictStatus;
  if (receipt.spamVerdict?.status) auth.spam = receipt.spamVerdict.status as AuthVerdictStatus;
  if (receipt.virusVerdict?.status) auth.virus = receipt.virusVerdict.status as AuthVerdictStatus;
  return Object.keys(auth).length ? auth : undefined;
}

type ParsedEmail = Awaited<ReturnType<typeof parseEmail>>;

interface DeliveryContext {
  messageId: string;
  timestamp: string;
  rawS3Key: string;
  auth?: EmailAuthVerdicts;
}

// Persist a parsed email, offloading an oversized body to S3. Shared by the
// numeric-agent and mailbox delivery paths so the sanitize-at-write and
// overflow behavior stays identical for both.
async function storeEmail(
  deps: IngestDeps, agentId: string, parsed: ParsedEmail, base: NewEmail,
): Promise<void> {
  const bodySize = Buffer.byteLength(parsed.text) + Buffer.byteLength(parsed.html ?? "");
  if (bodySize > deps.maxInlineBodyBytes) {
    const bodyS3Key = await deps.putBodyOverflow(agentId, base.messageId, {
      text: parsed.text, html: parsed.html, links: parsed.links,
    });
    await deps.emails.putEmail(agentId, { ...base, bodyS3Key });
  } else {
    await deps.emails.putEmail(agentId, { ...base, text: parsed.text, html: parsed.html });
  }
}

async function writeAttested(
  deps: IngestDeps, event: Parameters<typeof sanitizeAttestedEvent>[0], messageId: string,
): Promise<void> {
  if (!deps.activity) return;
  try {
    await deps.activity.putEvent(sanitizeAttestedEvent(event));
  } catch (error) {
    // The mail's fate (stored or quarantined) is already sealed; a ledger
    // outage must never change the delivery decision.
    console.error("ingest: failed to write activity event", { messageId, error });
  }
}

// Existing #83-#86 numeric-agent behavior, untouched: fail-open delivery with
// an unsolicited FLAG for non-allowlisted senders, and an attested
// email_received event only for authenticated, allowlisted mail.
async function deliverToAgent(
  deps: IngestDeps, agent: AgentRecord, parsed: ParsedEmail, ctx: DeliveryContext,
): Promise<void> {
  const unsolicited = !deps.senderAllowlist.some((d) => matchesSenderDomain(parsed.from, d));
  await storeEmail(deps, agent.agentId, parsed, {
    messageId: ctx.messageId,
    from: parsed.from, subject: parsed.subject,
    receivedAt: ctx.timestamp, links: parsed.links, rawS3Key: ctx.rawS3Key,
    ...(ctx.auth ? { auth: ctx.auth } : {}),
    ...(unsolicited ? { unsolicited: true } : {}),
  });
  const senderAuthenticated = ctx.auth?.dkim === "PASS" || ctx.auth?.dmarc === "PASS";
  if (!unsolicited && senderAuthenticated) {
    const domain = senderDomain(parsed.from);
    if (domain) {
      await writeAttested(deps, {
        agentId: agent.agentId, ts: ctx.timestamp, class: "attested",
        type: "email_received", summary: `email received from ${domain}`,
        detail: { senderDomain: domain },
      }, ctx.messageId);
    }
  }
}

// Named operator mailbox gate (issue #114) — the security boundary. An
// always-live orchestration agent ACTS on this mail, so delivery is
// FAIL-CLOSED: store the message only when BOTH the sender matches the
// mailbox allowlist (hardened address / *@domain matching, never the display
// name) AND authentication positively passed (DKIM or DMARC PASS — SPF alone
// is a spoofable envelope and is insufficient). Anything else is DROPPED to
// quarantine (never the mailbox) with an attested email_rejected event that
// carries the sender domain and a reason enum alone — never subject, body, or
// full address.
async function deliverToMailbox(
  deps: IngestDeps, mailbox: AgentRecord, parsed: ParsedEmail, ctx: DeliveryContext,
): Promise<void> {
  const allowlisted = matchesMailboxAllowlist(parsed.from, mailbox.allowlist ?? []);
  const authenticated = ctx.auth?.dkim === "PASS" || ctx.auth?.dmarc === "PASS";
  if (!allowlisted || !authenticated) {
    await deps.quarantineRaw(ctx.messageId);
    const reason: MailboxRejectReason = !allowlisted ? "not_allowlisted" : "auth_failed";
    const domain = senderDomain(parsed.from);
    await writeAttested(deps, {
      agentId: mailbox.agentId, ts: ctx.timestamp, class: "attested",
      type: "email_rejected",
      summary: domain ? `email rejected (${reason}) from ${domain}` : `email rejected (${reason})`,
      detail: { reason, ...(domain ? { senderDomain: domain } : {}) },
    }, ctx.messageId);
    return;
  }

  await storeEmail(deps, mailbox.agentId, parsed, {
    messageId: ctx.messageId,
    from: parsed.from, subject: parsed.subject,
    receivedAt: ctx.timestamp, links: parsed.links, rawS3Key: ctx.rawS3Key,
    ...(ctx.auth ? { auth: ctx.auth } : {}),
  });
  // Delivered mailbox mail is allowlisted AND authenticated by construction,
  // so the attested provenance requirement is already met.
  const domain = senderDomain(parsed.from);
  if (domain) {
    await writeAttested(deps, {
      agentId: mailbox.agentId, ts: ctx.timestamp, class: "attested",
      type: "email_received", summary: `email received from ${domain}`,
      detail: { senderDomain: domain },
    }, ctx.messageId);
  }
}

export async function processRecord(record: SESEventRecord, deps: IngestDeps): Promise<void> {
  const { mail, receipt } = record.ses;
  // Fail-open by design: only a positive FAIL verdict drops mail. Missing verdicts
  // (scanning disabled by a self-hoster) and GRAY/PROCESSING_FAILED are let through.
  if (receipt.spamVerdict?.status === "FAIL" || receipt.virusVerdict?.status === "FAIL") return;

  // Authentication hard-fail: quarantine to unmatched/ (7-day lifecycle), never
  // the mailbox — agents read mailboxes programmatically (prompt-injection vector).
  const auth = captureAuth(receipt);
  if (auth?.dmarc === "FAIL" || (auth?.spf === "FAIL" && auth?.dkim === "FAIL")) {
    await deps.quarantineRaw(mail.messageId);
    return;
  }

  const rawS3Key = `raw/${mail.messageId}`;
  const ctx: DeliveryContext = { messageId: mail.messageId, timestamp: mail.timestamp, rawS3Key, auth };
  let parsed: ParsedEmail | undefined;
  const ensureParsed = async (): Promise<ParsedEmail> => {
    if (!parsed) {
      const p = await parseEmail(await deps.getRaw(rawS3Key));
      // Storage-layer sanitization: subject, text, html, and links all reach
      // agents verbatim via get_email, so the ANSI-injection character class
      // is stripped from each before persisting (inline and overflow alike).
      parsed = {
        ...p,
        subject: sanitizeMailText(p.subject),
        text: sanitizeMailText(p.text),
        html: p.html === undefined ? undefined : sanitizeMailText(p.html),
        links: p.links.map((l) => sanitizeMailText(l)),
      };
    }
    return parsed;
  };

  for (const recipient of receipt.recipients) {
    const localPart = recipient.split("@")[0];
    // Exact local-part match wins. Otherwise an unknown local-part routes to
    // the domain catch-all mailbox when one opted in; with none, it is dropped
    // (existing behavior — unknown recipients are never quarantined).
    let target = await deps.agents.getByLocalPart(localPart);
    if (!target || target.status !== "active") {
      const catchAll = deps.agents.getCatchAllMailbox
        ? await deps.agents.getCatchAllMailbox()
        : undefined;
      if (!catchAll || catchAll.status !== "active") continue;
      target = catchAll;
    }

    const p = await ensureParsed();
    if (target.mailbox) {
      await deliverToMailbox(deps, target, p, ctx);
    } else {
      await deliverToAgent(deps, target, p, ctx);
    }
  }
}

// ---- Lambda wiring ----
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { CopyObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  ActivityRepo as ActivityRepoImpl,
  AgentsRepo as AgentsRepoImpl,
  EmailsRepo as EmailsRepoImpl,
} from "@agent-identity/api";
import type { SESEvent } from "aws-lambda";

export function makeLambdaDeps(): IngestDeps {
  const table = process.env.TABLE_NAME!;
  const bucket = process.env.BUCKET_NAME!;
  const domain = process.env.MAIL_DOMAIN!;
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const s3 = new S3Client({});
  return {
    getRaw: async (key) => {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await res.Body!.transformToByteArray());
    },
    putBodyOverflow: async (agentId, emailId, body) => {
      const key = `bodies/${agentId}/${emailId}.json`;
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: JSON.stringify(body),
        ContentType: "application/json",
      }));
      return key;
    },
    quarantineRaw: async (messageId) => {
      // Copy, don't move: raw/ keeps the retention-lifecycle original for forensics.
      await s3.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: `unmatched/${messageId}`,
        CopySource: `${bucket}/raw/${encodeURIComponent(messageId)}`,
      }));
    },
    agents: new AgentsRepoImpl(ddb, table, domain),
    emails: new EmailsRepoImpl(ddb, table, Number(process.env.RETENTION_DAYS ?? "90")),
    activity: new ActivityRepoImpl(ddb, table, Number(process.env.RETENTION_DAYS ?? "90")),
    maxInlineBodyBytes: 300_000,
    // Default mirrors the stack's senderAllowlist context default, so a
    // self-hoster running without the env var still gets the forge domains.
    senderAllowlist: (process.env.MAIL_SENDER_ALLOWLIST ?? "github.com,gitlab.com")
      .split(",").map((s) => s.trim()).filter(Boolean),
  };
}

export async function processEvent(event: SESEvent, deps: IngestDeps): Promise<void> {
  for (const record of event.Records) {
    const messageId = record.ses.mail.messageId;
    try {
      await processRecord(record, deps);
    } catch (error) {
      // Do not rethrow: rethrowing triggers an SES whole-event retry that would
      // duplicate already-stored mail. The raw message remains at raw/<messageId>
      // in S3 for manual recovery, so we prefer continuing over retry.
      console.error("ingest: failed to process record", { messageId, error });
    }
  }
}

export async function handler(event: SESEvent): Promise<void> {
  await processEvent(event, makeLambdaDeps());
}
