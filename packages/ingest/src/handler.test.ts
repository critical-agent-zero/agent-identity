import { describe, expect, it, vi, afterEach } from "vitest";
import { processRecord, processEvent, type IngestDeps } from "./handler.js";

const sesRecord = (over: Record<string, unknown> = {}, messageId = "m1") => ({
  ses: {
    mail: { messageId, timestamp: "2026-07-04T10:00:00.000Z" },
    receipt: {
      recipients: ["482913@mail.example.com"],
      spamVerdict: { status: "PASS" },
      virusVerdict: { status: "PASS" },
      ...over,
    },
  },
});

function makeDeps(): IngestDeps {
  return {
    getRaw: vi.fn(async () => Buffer.from(
      "From: a@b.c\r\nSubject: s\r\nContent-Type: text/plain\r\n\r\nhello https://x.example/1",
    )),
    putBodyOverflow: vi.fn(async () => "bodies/482913/X.json"),
    quarantineRaw: vi.fn(async () => {}),
    agents: { getByLocalPart: vi.fn(async (id: string) =>
      id === "482913" ? { agentId: "482913", status: "active" } : undefined,
    )} as never,
    emails: { putEmail: vi.fn(async () => "01ABC") } as never,
    maxInlineBodyBytes: 300_000,
    senderAllowlist: ["b.c"],
  };
}

describe("processEvent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("continues past a failing record and processes remaining records", async () => {
    // Record 2 (messageId "m2") will throw; records 1 and 3 must still be stored.
    const putEmail = vi.fn(async () => "ok");
    const deps: IngestDeps = {
      getRaw: vi.fn(async (key: string) => {
        if (key === "raw/m2") throw new Error("malformed MIME");
        return Buffer.from(
          "From: a@b.c\r\nSubject: s\r\nContent-Type: text/plain\r\n\r\nhello https://x.example/1",
        );
      }),
      putBodyOverflow: vi.fn(async () => "bodies/482913/X.json"),
      quarantineRaw: vi.fn(async () => {}),
      agents: { getByLocalPart: vi.fn(async (id: string) =>
        id === "482913" ? { agentId: "482913", status: "active" } : undefined,
      )} as never,
      emails: { putEmail } as never,
      maxInlineBodyBytes: 300_000,
      senderAllowlist: ["b.c"],
    };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const event = {
      Records: [
        sesRecord({}, "m1"),
        sesRecord({}, "m2"),
        sesRecord({}, "m3"),
      ],
    } as never;

    // Must not throw even though record 2 fails
    await expect(processEvent(event, deps)).resolves.toBeUndefined();

    // Records 1 and 3 must have been stored
    expect(putEmail).toHaveBeenCalledTimes(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const storedIds = (putEmail.mock.calls as any[][]).map((c) => (c[1] as { rawS3Key: string }).rawS3Key);
    expect(storedIds).toContain("raw/m1");
    expect(storedIds).toContain("raw/m3");

    // console.error must have been called with the failing messageId
    expect(errorSpy).toHaveBeenCalledWith(
      "ingest: failed to process record",
      expect.objectContaining({ messageId: "m2" }),
    );
  });
});

describe("processRecord", () => {
  it("stores parsed email for a known recipient", async () => {
    const deps = makeDeps();
    await processRecord(sesRecord() as never, deps);
    expect(deps.emails.putEmail).toHaveBeenCalledWith("482913", expect.objectContaining({
      messageId: "m1",
      from: expect.stringContaining("a@b.c"),
      subject: "s",
      receivedAt: "2026-07-04T10:00:00.000Z",
      links: ["https://x.example/1"],
      rawS3Key: "raw/m1",
    }));
  });

  it("drops spam", async () => {
    const deps = makeDeps();
    await processRecord(sesRecord({ spamVerdict: { status: "FAIL" } }) as never, deps);
    expect(deps.emails.putEmail).not.toHaveBeenCalled();
  });

  it("drops unknown recipients", async () => {
    const deps = makeDeps();
    const rec = sesRecord({ recipients: ["999999@mail.example.com"] });
    await processRecord(rec as never, deps);
    expect(deps.emails.putEmail).not.toHaveBeenCalled();
  });

  it("lets mail through when verdict objects are absent (scanning disabled)", async () => {
    const deps = makeDeps();
    const record = {
      ses: {
        mail: { messageId: "m1", timestamp: "2026-07-04T10:00:00.000Z" },
        receipt: {
          recipients: ["482913@mail.example.com"],
          // no spamVerdict / virusVerdict keys at all
        },
      },
    };
    await expect(processRecord(record as never, deps)).resolves.toBeUndefined();
    expect(deps.emails.putEmail).toHaveBeenCalled();
  });

  it("offloads oversized bodies to S3", async () => {
    const deps = { ...makeDeps(), maxInlineBodyBytes: 4 };
    await processRecord(sesRecord() as never, deps);
    expect(deps.putBodyOverflow).toHaveBeenCalled();
    const stored = (deps.emails.putEmail as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(stored.bodyS3Key).toBe("bodies/482913/X.json");
    expect(stored.text).toBeUndefined();
  });
});

describe("processRecord auth verdicts", () => {
  it("records SES verdicts on the stored email when all pass", async () => {
    const deps = makeDeps();
    await processRecord(sesRecord({
      spfVerdict: { status: "PASS" },
      dkimVerdict: { status: "PASS" },
      dmarcVerdict: { status: "PASS" },
    }) as never, deps);
    expect(deps.emails.putEmail).toHaveBeenCalledWith("482913", expect.objectContaining({
      auth: { spf: "PASS", dkim: "PASS", dmarc: "PASS", spam: "PASS", virus: "PASS" },
    }));
    expect(deps.quarantineRaw).not.toHaveBeenCalled();
  });

  it("quarantines on DMARC FAIL instead of delivering", async () => {
    const deps = makeDeps();
    await processRecord(sesRecord({
      spfVerdict: { status: "PASS" },
      dkimVerdict: { status: "PASS" },
      dmarcVerdict: { status: "FAIL" },
    }) as never, deps);
    expect(deps.emails.putEmail).not.toHaveBeenCalled();
    expect(deps.quarantineRaw).toHaveBeenCalledWith("m1");
  });

  it("quarantines when both SPF and DKIM FAIL", async () => {
    const deps = makeDeps();
    await processRecord(sesRecord({
      spfVerdict: { status: "FAIL" },
      dkimVerdict: { status: "FAIL" },
      dmarcVerdict: { status: "GRAY" },
    }) as never, deps);
    expect(deps.emails.putEmail).not.toHaveBeenCalled();
    expect(deps.quarantineRaw).toHaveBeenCalledWith("m1");
  });

  it("delivers an SPF-only failure with the verdict recorded", async () => {
    const deps = makeDeps();
    await processRecord(sesRecord({
      spfVerdict: { status: "FAIL" },
      dkimVerdict: { status: "PASS" },
      dmarcVerdict: { status: "GRAY" },
    }) as never, deps);
    expect(deps.quarantineRaw).not.toHaveBeenCalled();
    expect(deps.emails.putEmail).toHaveBeenCalledWith("482913", expect.objectContaining({
      auth: expect.objectContaining({ spf: "FAIL", dkim: "PASS", dmarc: "GRAY" }),
    }));
  });

  it("tolerates missing verdicts: delivers with no auth field", async () => {
    const deps = makeDeps();
    const record = {
      ses: {
        mail: { messageId: "m1", timestamp: "2026-07-04T10:00:00.000Z" },
        receipt: { recipients: ["482913@mail.example.com"] },
      },
    };
    await processRecord(record as never, deps);
    expect(deps.quarantineRaw).not.toHaveBeenCalled();
    const stored = (deps.emails.putEmail as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(stored.auth).toBeUndefined();
  });
});

describe("processRecord sender allowlist", () => {
  const rawFrom = (from: string) => vi.fn(async () => Buffer.from(
    `From: ${from}\r\nSubject: s\r\nContent-Type: text/plain\r\n\r\nhello`,
  ));

  it("stores allowlisted mail without the unsolicited flag", async () => {
    const deps = { ...makeDeps(), getRaw: rawFrom("GitHub <noreply@github.com>"), senderAllowlist: ["github.com", "gitlab.com"] };
    await processRecord(sesRecord() as never, deps);
    const stored = (deps.emails.putEmail as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(stored.unsolicited).toBeUndefined();
  });

  it("matches subdomains on label boundaries", async () => {
    const deps = { ...makeDeps(), getRaw: rawFrom("<noreply@mail.github.com>"), senderAllowlist: ["github.com"] };
    await processRecord(sesRecord() as never, deps);
    const stored = (deps.emails.putEmail as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(stored.unsolicited).toBeUndefined();
  });

  it("flags lookalike domains unsolicited but still stores them", async () => {
    const deps = { ...makeDeps(), getRaw: rawFrom("<noreply@evilgithub.com>"), senderAllowlist: ["github.com"] };
    await processRecord(sesRecord() as never, deps);
    const stored = (deps.emails.putEmail as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(stored.unsolicited).toBe(true);
  });

  it("ignores an allowlisted domain in the display name", async () => {
    const deps = { ...makeDeps(), getRaw: rawFrom('"noreply@github.com" <x@evil.example>'), senderAllowlist: ["github.com"] };
    await processRecord(sesRecord() as never, deps);
    const stored = (deps.emails.putEmail as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(stored.unsolicited).toBe(true);
  });
});

describe("processRecord text sanitization", () => {
  it("strips control and invisible characters from stored subject and text", async () => {
    const esc = String.fromCodePoint(0x1b);
    const zwsp = String.fromCodePoint(0x200b);
    const deps = {
      ...makeDeps(),
      getRaw: vi.fn(async () => Buffer.from(
        `From: a@b.c\r\nSubject: s${esc}[31mub\r\nContent-Type: text/plain\r\n\r\nhi${zwsp}there ${esc}]8;;x`,
      )),
    };
    await processRecord(sesRecord() as never, deps);
    const stored = (deps.emails.putEmail as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(stored.subject).toBe("s[31mub");
    expect(stored.text).toContain("hithere ]8;;x");
  });

  it("sanitizes the overflow body written to S3", async () => {
    const esc = String.fromCodePoint(0x1b);
    const deps = {
      ...makeDeps(),
      maxInlineBodyBytes: 4,
      getRaw: vi.fn(async () => Buffer.from(
        `From: a@b.c\r\nSubject: s\r\nContent-Type: text/plain\r\n\r\nhi${esc}[31m there`,
      )),
    };
    await processRecord(sesRecord() as never, deps);
    const body = (deps.putBodyOverflow as ReturnType<typeof vi.fn>).mock.calls[0][2] as { text: string };
    expect(body.text).toContain("hi[31m there");
  });
});
