// Attack tests: the attested email_received path is reachable by arbitrary
// OUTSIDE senders. Delivery is fail-open by design (only explicit FAIL
// verdicts quarantine), which is an acceptable trade for a flagged mailbox —
// but a permanent attested ledger row is manufactured provenance and must
// demand real authentication and clean text.
import type { ActivityEvent } from "@agent-identity/shared";
import { describe, expect, it, vi } from "vitest";
import { processRecord, type IngestDeps } from "./handler.js";

const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const RLO = cp(0x202e);
const ZWSP = cp(0x200b);

const sesRecord = (receiptOver: Record<string, unknown> = {}) => ({
  ses: {
    mail: { messageId: "m1", timestamp: "2026-07-04T10:00:00.000Z" },
    receipt: {
      recipients: ["482913@mail.example.com"],
      ...receiptOver,
    },
  },
});

function makeDeps(from: string): IngestDeps & { events: ActivityEvent[] } {
  const events: ActivityEvent[] = [];
  return {
    events,
    getRaw: vi.fn(async () => Buffer.from(
      `From: ${from}\r\nSubject: s\r\nContent-Type: text/plain\r\n\r\nhello`,
    )),
    putBodyOverflow: vi.fn(async () => "bodies/482913/X.json"),
    quarantineRaw: vi.fn(async () => {}),
    agents: { getByLocalPart: vi.fn(async (id: string) =>
      id === "482913" ? { agentId: "482913", status: "active" } : undefined,
    )} as never,
    emails: { putEmail: vi.fn(async () => "01ABC") } as never,
    activity: { putEvent: async (e: ActivityEvent) => { events.push(e); return "id"; } },
    maxInlineBodyBytes: 300_000,
    senderAllowlist: ["github.com"],
  };
}

describe("attested email_received vs outside senders", () => {
  it("does not mint an attested event for an unauthenticated (all-GRAY) spoof of an allowlisted domain", async () => {
    // A forged `From: alerts@mail.github.com` where SPF, DKIM, and DMARC all
    // come back GRAY: fail-open delivery is the documented trade, but the
    // spoof must NOT become a permanent attested "email received from
    // mail.github.com" row on the agent's record.
    const deps = makeDeps("GitHub <alerts@mail.github.com>");
    await processRecord(sesRecord({
      spfVerdict: { status: "GRAY" },
      dkimVerdict: { status: "GRAY" },
      dmarcVerdict: { status: "GRAY" },
    }) as never, deps);

    // The mailbox still gets the mail (fail-open delivery unchanged)...
    expect(deps.emails.putEmail).toHaveBeenCalled();
    // ...but no attested provenance is manufactured.
    expect(deps.events).toHaveLength(0);
  });

  it("fails closed on a bidi/zero-width lookalike domain instead of attesting it", async () => {
    // `evil<RLO><ZWSP>.github.com` suffix-matches ".github.com" with naive
    // endsWith, and DKIM PASS here is the attacker signing with their OWN
    // d= domain — SES still reports PASS. The injection characters must
    // never reach an attested summary/detail, and a domain containing them
    // is not a real mail domain: no attested event, mail flagged.
    const deps = makeDeps(`<x@evil${RLO}${ZWSP}.github.com>`);
    await processRecord(sesRecord({
      spfVerdict: { status: "GRAY" },
      dkimVerdict: { status: "PASS" },
      dmarcVerdict: { status: "GRAY" },
    }) as never, deps);

    for (const event of deps.events) {
      const json = JSON.stringify(event);
      expect(json).not.toContain(RLO);
      expect(json).not.toContain(ZWSP);
    }
    expect(deps.events).toHaveLength(0);
    // The lookalike never counts as allowlisted mail.
    expect(deps.emails.putEmail).toHaveBeenCalledWith("482913",
      expect.objectContaining({ unsolicited: true }));
  });
});
