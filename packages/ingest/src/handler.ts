import type { ActivityRepo, AgentsRepo, EmailsRepo } from "@agent-identity/api";
import {
  matchesSenderDomain, sanitizeAttestedEvent, sanitizeMailText, senderDomain,
  type AuthVerdictStatus, type EmailAuthVerdicts,
} from "@agent-identity/shared";
import type { SESEventRecord, SESReceipt } from "aws-lambda";
import { parseEmail } from "./parse.js";

export interface IngestDeps {
  getRaw: (s3Key: string) => Promise<Buffer>;
  putBodyOverflow: (agentId: string, emailId: string, body: object) => Promise<string>;
  quarantineRaw: (messageId: string) => Promise<void>;
  agents: Pick<AgentsRepo, "getByLocalPart">;
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
  let parsed: Awaited<ReturnType<typeof parseEmail>> | undefined;

  for (const recipient of receipt.recipients) {
    const localPart = recipient.split("@")[0];
    const agent = await deps.agents.getByLocalPart(localPart);
    if (!agent || agent.status !== "active") continue;

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
    // Flag, don't drop: non-allowlisted mail stays readable by explicit
    // opt-in (includeUnsolicited) and for forensics.
    const unsolicited =
      !deps.senderAllowlist.some((d) => matchesSenderDomain(parsed!.from, d));
    const bodySize = Buffer.byteLength(parsed.text) + Buffer.byteLength(parsed.html ?? "");
    const base = {
      messageId: mail.messageId,
      from: parsed.from, subject: parsed.subject,
      receivedAt: mail.timestamp, links: parsed.links, rawS3Key,
      ...(auth ? { auth } : {}),
      ...(unsolicited ? { unsolicited: true } : {}),
    };
    if (bodySize > deps.maxInlineBodyBytes) {
      const bodyS3Key = await deps.putBodyOverflow(agent.agentId, mail.messageId, {
        text: parsed.text, html: parsed.html, links: parsed.links,
      });
      await deps.emails.putEmail(agent.agentId, { ...base, bodyS3Key });
    } else {
      await deps.emails.putEmail(agent.agentId, {
        ...base, text: parsed.text, html: parsed.html,
      });
    }

    // Attested ledger event for delivered, allowlisted mail only — never for
    // quarantined (returned above) or unsolicited mail. The event carries the
    // sender DOMAIN alone: no subject, no body, no full address.
    //
    // Delivery above is fail-open by design (only explicit FAIL verdicts
    // stop mail), which is an acceptable trade for a flagged mailbox — but a
    // PERMANENT attested row is manufactured provenance, so it additionally
    // demands a positive authentication verdict (DKIM or DMARC PASS). An
    // unauthenticated (all-GRAY) spoof of an allowlisted domain still
    // delivers; it never mints attested provenance.
    const senderAuthenticated = auth?.dkim === "PASS" || auth?.dmarc === "PASS";
    if (!unsolicited && senderAuthenticated && deps.activity) {
      const domain = senderDomain(parsed.from);
      if (domain) {
        try {
          await deps.activity.putEvent(sanitizeAttestedEvent({
            agentId: agent.agentId, ts: mail.timestamp, class: "attested",
            type: "email_received",
            summary: `email received from ${domain}`,
            detail: { senderDomain: domain },
          }));
        } catch (error) {
          // The mail is stored; a ledger outage must not fail delivery.
          console.error("ingest: failed to write activity event", {
            messageId: mail.messageId, error,
          });
        }
      }
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
