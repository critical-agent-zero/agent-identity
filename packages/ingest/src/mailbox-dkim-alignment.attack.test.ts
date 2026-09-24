// Attack suite for issue #114: DKIM PASS is NOT sender authentication.
//
// AWS SES `dkimVerdict: PASS` only means the message carried at least one
// VALID DKIM signature on whatever domain the signer chose in the signature's
// d= tag. It does NOT bind that signature to the RFC 5322 From header. The
// only receipt verdict that enforces From-domain alignment is DMARC.
//
// Exploit: an attacker publishes DKIM for evil.example and signs with
// d=evil.example, then sets From: an allowlisted vendor domain that publishes
// no enforcing DMARC record. SES reports dkimVerdict=PASS (the attacker's own
// signature is valid), while dmarcVerdict is GRAY or absent (never FAIL, so the
// global hard-fail never trips). The gate must NOT treat bare DKIM PASS as
// authentication of the allowlisted From — that would deliver a forged alert
// into the mailbox the orchestration agent reads and acts on.
import type { ActivityEvent } from "@agent-identity/shared";
import { describe, expect, it, vi } from "vitest";
import { processRecord, type IngestDeps } from "./handler.js";

const OPS = {
  agentId: "ops", address: "ops@mail.example.com", status: "active",
  mailbox: true, catchAll: true,
  allowlist: ["alerts@status.example", "*@github.com"],
};

const NUMERIC = { agentId: "482913", status: "active" };

const record = (over: Record<string, unknown> = {}, recipients = ["ops@mail.example.com"]) => ({
  ses: {
    mail: { messageId: "m1", timestamp: "2026-07-04T10:00:00.000Z" },
    receipt: {
      recipients,
      spamVerdict: { status: "PASS" },
      virusVerdict: { status: "PASS" },
      ...over,
    },
  },
});

interface Ctx extends IngestDeps { events: ActivityEvent[] }

function makeDeps(from: string): Ctx {
  const events: ActivityEvent[] = [];
  return {
    events,
    getRaw: vi.fn(async () => Buffer.from(
      `From: ${from}\r\nSubject: s\r\nContent-Type: text/plain\r\n\r\nsite DOWN, run failover`,
    )),
    putBodyOverflow: vi.fn(async () => "bodies/ops/X.json"),
    quarantineRaw: vi.fn(async () => {}),
    agents: {
      getByLocalPart: vi.fn(async (id: string) =>
        id === "ops" ? OPS : id === "482913" ? NUMERIC : undefined),
      getCatchAllMailbox: vi.fn(async () => OPS),
    } as never,
    emails: { putEmail: vi.fn(async () => "01ABC") } as never,
    activity: { putEvent: async (e: ActivityEvent) => { events.push(e); return "id"; } },
    maxInlineBodyBytes: 300_000,
    senderAllowlist: ["github.com"],
  };
}

const stored = (deps: IngestDeps) =>
  (deps.emails.putEmail as ReturnType<typeof vi.fn>).mock.calls;

describe("mailbox gate: bare DKIM PASS is not From-domain alignment (issue #114 blocker)", () => {
  it("does NOT deliver an allowlisted exact-address From on dkim PASS + dmarc GRAY", async () => {
    // From: alerts@status.example (exact allowlist match), but only the
    // attacker's own d=evil.example signature is valid; status.example has no
    // enforcing DMARC record so dmarc is GRAY, never FAIL.
    const deps = makeDeps("Status <alerts@status.example>");
    await processRecord(record({
      spfVerdict: { status: "PASS" },
      dkimVerdict: { status: "PASS" },
      dmarcVerdict: { status: "GRAY" },
    }) as never, deps);
    expect(stored(deps)).toHaveLength(0);
    expect(deps.quarantineRaw).toHaveBeenCalledWith("m1");
    expect(deps.events[0]).toMatchObject({
      type: "email_rejected", detail: { reason: "auth_failed" },
    });
  });

  it("does NOT deliver an allowlisted *@domain From on dkim PASS + dmarc absent", async () => {
    // From: an allowlisted *@github.com sender; dmarc verdict entirely absent.
    const deps = makeDeps("GitHub <noreply@github.com>");
    await processRecord(record({
      spfVerdict: { status: "PASS" },
      dkimVerdict: { status: "PASS" },
    }) as never, deps);
    expect(stored(deps)).toHaveLength(0);
    expect(deps.quarantineRaw).toHaveBeenCalledWith("m1");
    expect(deps.events[0]).toMatchObject({
      type: "email_rejected", detail: { reason: "auth_failed" },
    });
  });

  it("DMARC-PASS control: an allowlisted From with dmarc PASS still delivers", async () => {
    const deps = makeDeps("GitHub <noreply@github.com>");
    await processRecord(record({ dmarcVerdict: { status: "PASS" } }) as never, deps);
    expect(stored(deps)).toHaveLength(1);
    expect(stored(deps)[0][0]).toBe("ops");
    expect(deps.quarantineRaw).not.toHaveBeenCalled();
    expect(deps.events.map((e) => e.type)).toEqual(["email_received"]);
  });
});

describe("numeric-agent attested provenance requires From-domain alignment (issue #114 important)", () => {
  it("does NOT mint an attested email_received on dkim PASS + dmarc GRAY (still stored, fail-open)", async () => {
    // Attacker DKIM-signs with their own domain while From is an allowlisted
    // trusted domain. Numeric delivery is fail-open (mail is stored), but the
    // attested provenance claim must NOT be written from bare DKIM.
    const deps = makeDeps("GitHub <noreply@github.com>");
    await processRecord(record({
      spfVerdict: { status: "PASS" },
      dkimVerdict: { status: "PASS" },
      dmarcVerdict: { status: "GRAY" },
    }, ["482913@mail.example.com"]) as never, deps);
    // Fail-open: the mail is still stored for the numeric agent.
    expect(stored(deps)).toHaveLength(1);
    expect(stored(deps)[0][0]).toBe("482913");
    // But NO attested email_received provenance is minted from bare DKIM.
    expect(deps.events).toHaveLength(0);
  });

  it("DMARC-PASS control: attested email_received is minted for a numeric agent on dmarc PASS", async () => {
    const deps = makeDeps("GitHub <noreply@github.com>");
    await processRecord(record({ dmarcVerdict: { status: "PASS" } },
      ["482913@mail.example.com"]) as never, deps);
    expect(stored(deps)).toHaveLength(1);
    expect(deps.events.map((e) => e.type)).toEqual(["email_received"]);
  });
});
