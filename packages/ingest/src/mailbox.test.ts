// Named operator mailbox gate (issue #114). This mailbox feeds an always-live
// orchestration agent that ACTS on alerts, so the delivery gate is the
// security boundary: mail is DELIVERED only when the sender matches the
// mailbox allowlist AND authentication positively passed (DKIM or DMARC).
// Everything else is DROPPED to quarantine (never the mailbox) with an
// attested email_rejected event carrying the sender domain and a reason
// enum alone.
import type { ActivityEvent } from "@agent-identity/shared";
import { describe, expect, it, vi } from "vitest";
import { processRecord, type IngestDeps } from "./handler.js";

const cp = (...codes: number[]) => String.fromCodePoint(...codes);

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

function makeDeps(from: string, opts: {
  subject?: string; body?: string; catchAll?: (typeof OPS) | undefined;
} = {}): Ctx {
  const events: ActivityEvent[] = [];
  const subject = opts.subject ?? "s";
  const body = opts.body ?? "hello";
  const catchAllBox = "catchAll" in opts ? opts.catchAll : OPS;
  return {
    events,
    getRaw: vi.fn(async () => Buffer.from(
      `From: ${from}\r\nSubject: ${subject}\r\nContent-Type: text/plain\r\n\r\n${body}`,
    )),
    putBodyOverflow: vi.fn(async () => "bodies/ops/X.json"),
    quarantineRaw: vi.fn(async () => {}),
    agents: {
      getByLocalPart: vi.fn(async (id: string) =>
        id === "ops" ? OPS : id === "482913" ? NUMERIC : undefined),
      getCatchAllMailbox: vi.fn(async () => catchAllBox),
    } as never,
    emails: { putEmail: vi.fn(async () => "01ABC") } as never,
    activity: { putEvent: async (e: ActivityEvent) => { events.push(e); return "id"; } },
    maxInlineBodyBytes: 300_000,
    senderAllowlist: ["github.com"],
  };
}

const stored = (deps: IngestDeps) =>
  (deps.emails.putEmail as ReturnType<typeof vi.fn>).mock.calls;

describe("mailbox delivery gate: allowlist + authentication", () => {
  it("delivers when a *@domain sender is allowlisted and DKIM passes", async () => {
    const deps = makeDeps("GitHub <noreply@github.com>");
    await processRecord(record({ dkimVerdict: { status: "PASS" } }) as never, deps);
    expect(stored(deps)).toHaveLength(1);
    expect(stored(deps)[0][0]).toBe("ops");
    expect(deps.quarantineRaw).not.toHaveBeenCalled();
    expect(deps.events.map((e) => e.type)).toEqual(["email_received"]);
  });

  it("delivers when DMARC passes (DKIM absent)", async () => {
    const deps = makeDeps("GitHub <noreply@github.com>");
    await processRecord(record({ dmarcVerdict: { status: "PASS" } }) as never, deps);
    expect(stored(deps)).toHaveLength(1);
    expect(deps.quarantineRaw).not.toHaveBeenCalled();
  });

  it("delivers on an exact-address allowlist match + DKIM pass", async () => {
    const deps = makeDeps("Status <alerts@status.example>");
    await processRecord(record({ dkimVerdict: { status: "PASS" } }) as never, deps);
    expect(stored(deps)).toHaveLength(1);
    expect(stored(deps)[0][0]).toBe("ops");
  });

  it("delivers a subdomain of a *@domain pattern on a label boundary", async () => {
    const deps = makeDeps("<noreply@mail.github.com>");
    await processRecord(record({ dkimVerdict: { status: "PASS" } }) as never, deps);
    expect(stored(deps)).toHaveLength(1);
  });
});

describe("mailbox delivery gate: quarantine + email_rejected", () => {
  it("quarantines a label-boundary lookalike (evil-github.com) as not_allowlisted", async () => {
    const deps = makeDeps("<noreply@evil-github.com>");
    await processRecord(record({ dkimVerdict: { status: "PASS" } }) as never, deps);
    expect(stored(deps)).toHaveLength(0);
    expect(deps.quarantineRaw).toHaveBeenCalledWith("m1");
    expect(deps.events).toHaveLength(1);
    expect(deps.events[0]).toMatchObject({
      agentId: "ops", class: "attested", type: "email_rejected",
      detail: { reason: "not_allowlisted", senderDomain: "evil-github.com" },
    });
  });

  it("quarantines a non-allowlisted sender as not_allowlisted", async () => {
    const deps = makeDeps("Someone <x@random.example>");
    await processRecord(record({ dkimVerdict: { status: "PASS" } }) as never, deps);
    expect(stored(deps)).toHaveLength(0);
    expect(deps.quarantineRaw).toHaveBeenCalledWith("m1");
    expect(deps.events[0].detail).toEqual({ reason: "not_allowlisted", senderDomain: "random.example" });
  });

  it("quarantines an allowlisted sender whose auth is all-GRAY as auth_failed", async () => {
    const deps = makeDeps("GitHub <noreply@github.com>");
    await processRecord(record({
      spfVerdict: { status: "GRAY" }, dkimVerdict: { status: "GRAY" }, dmarcVerdict: { status: "GRAY" },
    }) as never, deps);
    expect(stored(deps)).toHaveLength(0);
    expect(deps.quarantineRaw).toHaveBeenCalledWith("m1");
    expect(deps.events[0]).toMatchObject({
      type: "email_rejected", detail: { reason: "auth_failed", senderDomain: "github.com" },
    });
  });

  it("quarantines an allowlisted sender with NO verdicts (scanning off) as auth_failed — fail closed", async () => {
    const deps = makeDeps("GitHub <noreply@github.com>");
    const rec = {
      ses: {
        mail: { messageId: "m1", timestamp: "2026-07-04T10:00:00.000Z" },
        receipt: { recipients: ["ops@mail.example.com"] },
      },
    };
    await processRecord(rec as never, deps);
    expect(stored(deps)).toHaveLength(0);
    expect(deps.quarantineRaw).toHaveBeenCalledWith("m1");
    expect(deps.events[0].detail).toMatchObject({ reason: "auth_failed" });
  });

  it("never delivers a spoofed display-name allowlisted sender (real sender evil), even with DKIM pass", async () => {
    const deps = makeDeps('"alerts@status.example" <x@evil.example>');
    await processRecord(record({ dkimVerdict: { status: "PASS" } }) as never, deps);
    expect(stored(deps)).toHaveLength(0);
    expect(deps.quarantineRaw).toHaveBeenCalledWith("m1");
    expect(deps.events[0].detail).toMatchObject({ reason: "not_allowlisted" });
  });

  it("does not deliver a hard DMARC FAIL to a mailbox (quarantined by the global gate)", async () => {
    const deps = makeDeps("GitHub <noreply@github.com>");
    await processRecord(record({ dmarcVerdict: { status: "FAIL" } }) as never, deps);
    expect(stored(deps)).toHaveLength(0);
    expect(deps.quarantineRaw).toHaveBeenCalledWith("m1");
  });
});

describe("email_rejected redaction", () => {
  it("carries ONLY the sender domain and reason — no subject, body, or address", async () => {
    const deps = makeDeps("Someone <secret-user@random.example>", {
      subject: "SECRETSUBJECT", body: "SECRETBODYCONTENT",
    });
    await processRecord(record({ dkimVerdict: { status: "PASS" } }) as never, deps);
    const event = deps.events[0];
    const json = JSON.stringify(event);
    expect(json).not.toContain("SECRETSUBJECT");
    expect(json).not.toContain("SECRETBODYCONTENT");
    expect(json).not.toContain("secret-user");
    expect(json).not.toContain("secret-user@random.example");
    expect(event).not.toHaveProperty("subject");
    expect(event.detail).toEqual({ reason: "not_allowlisted", senderDomain: "random.example" });
  });

  it("omits senderDomain entirely on a lookalike From that cannot be safely resolved", async () => {
    // A bidi/zero-width lookalike domain resolves to undefined; the reject
    // event still fires (not_allowlisted) but carries only the reason.
    const deps = makeDeps(`<x@evil${cp(0x202e)}${cp(0x200b)}.github.com>`);
    await processRecord(record({ dkimVerdict: { status: "PASS" } }) as never, deps);
    expect(stored(deps)).toHaveLength(0);
    const event = deps.events[0];
    expect(event.type).toBe("email_rejected");
    expect(event.detail).toEqual({ reason: "not_allowlisted" });
    const json = JSON.stringify(event);
    expect(json).not.toContain(cp(0x202e));
    expect(json).not.toContain(cp(0x200b));
  });
});

describe("catch-all routing", () => {
  it("routes an unknown local-part to the catch-all mailbox, still gated (delivers when allowlisted+auth)", async () => {
    const deps = makeDeps("GitHub <noreply@github.com>");
    await processRecord(record({ dkimVerdict: { status: "PASS" } }, ["random@mail.example.com"]) as never, deps);
    expect(stored(deps)).toHaveLength(1);
    expect(stored(deps)[0][0]).toBe("ops");
  });

  it("gates catch-all mail too: non-allowlisted unknown local-part is quarantined", async () => {
    const deps = makeDeps("Someone <x@random.example>");
    await processRecord(record({ dkimVerdict: { status: "PASS" } }, ["random@mail.example.com"]) as never, deps);
    expect(stored(deps)).toHaveLength(0);
    expect(deps.quarantineRaw).toHaveBeenCalledWith("m1");
    expect(deps.events[0].detail).toMatchObject({ reason: "not_allowlisted" });
  });

  it("drops an unknown local-part when NO catch-all mailbox exists (no quarantine, no delivery)", async () => {
    const deps = makeDeps("GitHub <noreply@github.com>", { catchAll: undefined });
    await processRecord(record({ dkimVerdict: { status: "PASS" } }, ["random@mail.example.com"]) as never, deps);
    expect(stored(deps)).toHaveLength(0);
    expect(deps.quarantineRaw).not.toHaveBeenCalled();
    expect(deps.events).toHaveLength(0);
  });
});

describe("numeric-agent delivery is unchanged by the mailbox path", () => {
  it("delivers to a numeric agent using the existing sender-allowlist behavior", async () => {
    const deps = makeDeps("GitHub <noreply@github.com>");
    await processRecord(record({ dkimVerdict: { status: "PASS" } }, ["482913@mail.example.com"]) as never, deps);
    expect(stored(deps)).toHaveLength(1);
    expect(stored(deps)[0][0]).toBe("482913");
    // Numeric path: delivered (allowlisted github.com) with an email_received event.
    expect(deps.events.map((e) => e.type)).toEqual(["email_received"]);
    expect(deps.quarantineRaw).not.toHaveBeenCalled();
  });

  it("flags a non-allowlisted numeric-agent sender unsolicited but still stores it (fail-open, unchanged)", async () => {
    const deps = makeDeps("Someone <x@random.example>");
    await processRecord(record({ dkimVerdict: { status: "PASS" } }, ["482913@mail.example.com"]) as never, deps);
    expect(stored(deps)).toHaveLength(1);
    expect(stored(deps)[0][1]).toMatchObject({ unsolicited: true });
    expect(deps.quarantineRaw).not.toHaveBeenCalled();
  });
});
