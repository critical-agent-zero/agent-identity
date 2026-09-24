// Viewer-tier mail reading (#107): the operator reads email bodies from the
// dashboard, but the agent's mailbox address NEVER travels. These tests
// assert on JSON.stringify of whole response bodies — absence of the address
// must hold for the serialized bytes, not just for individual fields.
import { canonicalString, generateKeypair, sign } from "@agent-identity/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp, type Deps } from "./app.js";
import { InvalidCursorError } from "./db/emails.js";
import type { NoncesRepo } from "./db/nonces.js";

const kp = generateKeypair();

function signed(method: string, path: string, body = "") {
  const timestamp = new Date().toISOString();
  return {
    method,
    body: body || undefined,
    headers: {
      "x-agent-key": kp.publicKeySpkiBase64,
      "x-agent-timestamp": timestamp,
      "x-agent-signature": sign(canonicalString(method, path, timestamp, body), kp.privateKeyPem),
      ...(body ? { "content-type": "application/json" } : {}),
    },
  };
}

const agent = {
  agentId: "482913", address: "482913@agents.example.com", status: "active" as const,
  publicKey: kp.publicKeySpkiBase64, createdAt: "t",
};

// The address appears in EVERY stored field a verification mail can echo it
// into: the From header, the subject, the body text, the HTML, and links
// (plain query param, mailto:, percent-encoded).
const ADDR = "482913@agents.example.com";
const SUMMARIES = [
  {
    id: "01J2", from: `Echo <${ADDR}>`, subject: `verify ${ADDR}`,
    receivedAt: "2026-09-23T12:00:01.000Z",
    auth: { spf: "FAIL", dkim: "PASS", dmarc: "FAIL" }, unsolicited: true,
  },
  {
    id: "01J1", from: "GitHub <noreply@github.com>", subject: "hello",
    receivedAt: "2026-09-23T12:00:00.000Z",
  },
];
const FULL = {
  id: "01J2", from: `Echo <${ADDR}>`, subject: `verify ${ADDR}`,
  receivedAt: "2026-09-23T12:00:01.000Z",
  text: `Hi,\nTo: ${ADDR}\nconfirm at https://github.com/verify?email=${ADDR}&t=1`,
  html: `<p>To: 482913@Agents.Example.COM</p><a href="mailto:${ADDR}">"482913@"</a>`,
  links: [
    `https://github.com/verify?email=${ADDR}&t=1`,
    "https://github.com/verify?email=482913%40agents.example.com&t=2",
    `mailto:${ADDR}`,
  ],
  auth: { spf: "FAIL", dkim: "PASS", dmarc: "FAIL" },
  unsolicited: true,
};

function makeDeps(overrides: Record<string, unknown> = {}): Deps {
  return {
    agents: {
      getByFingerprint: vi.fn(async () => agent),
      verifyFleetKey: vi.fn(async () => true),
      verifyAdminKey: vi.fn(async (k: string) => k === "adm-good"),
      verifyViewerKey: vi.fn(async (k: string) => k === "vk"),
    } as never,
    emails: {
      listEmails: vi.fn(async () => ({ emails: SUMMARIES, cursor: "next" })),
      getEmail: vi.fn(async (_agentId: string, id: string) =>
        id === "01J2" ? { ...FULL } : undefined),
      ...overrides,
    } as never,
    activity: {
      putEvent: vi.fn(async () => "id"),
      listEvents: vi.fn(async () => ({ events: [] })),
      setStatus: vi.fn(async () => {}),
      getStatus: vi.fn(async () => undefined),
      listFleetEvents: vi.fn(async () => ({ events: [] })),
      fleetRoster: vi.fn(async () => []),
      ...overrides,
    } as never,
    nonces: { recordOnce: async () => true } as never as NoncesRepo,
    readBody: vi.fn(async () => ({ text: "", links: [] })),
    fleetKeyRequired: true,
    publicRepos: [],
    mailDomain: "agents.example.com",
    autoCapabilities: [],
  };
}

const vk = { headers: { "x-viewer-key": "vk" } };

describe("GET /fleet/emails/:agentId (operator summaries)", () => {
  it("serves summaries via the emails repo with the forensic view: flagged mail included", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const res = await app.request("/fleet/emails/482913?limit=5&cursor=abc", vk);
    expect(res.status).toBe(200);
    expect(deps.emails.listEmails).toHaveBeenCalledWith("482913", {
      limit: 5, cursor: "abc",
      includeUnsolicited: true, includeUnauthenticated: true,
    });
    const body = await res.json();
    expect(body.cursor).toBe("next");
    expect(body.emails).toHaveLength(2);
    // flags stay visible — this is the operator's forensic view
    expect(body.emails[0]).toEqual(expect.objectContaining({
      id: "01J2", receivedAt: "2026-09-23T12:00:01.000Z",
      unsolicited: true, auth: { spf: "FAIL", dkim: "PASS", dmarc: "FAIL" },
    }));
    expect(body.emails[1]).toEqual(expect.objectContaining({ id: "01J1", subject: "hello" }));
  });

  it("never serializes the mailbox address, even echoed in from/subject", async () => {
    const app = createApp(makeDeps());
    const s = await (await app.request("/fleet/emails/482913", vk)).text();
    expect(s).not.toContain("482913@");
    expect(s).toContain("[redacted-address]");
    expect(s).toContain("noreply@github.com"); // other parties stay readable
  });

  it("400s a malformed cursor", async () => {
    const deps = makeDeps({
      listEmails: vi.fn(async () => { throw new InvalidCursorError("malformed cursor"); }) as never,
    });
    const app = createApp(deps);
    expect((await app.request("/fleet/emails/482913?cursor=nope", vk)).status).toBe(400);
  });
});

describe("GET /fleet/emails/:agentId/:emailId (operator body view)", () => {
  it("serves the full body with flags, redacting the address from every field", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/fleet/emails/482913/01J2", vk);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("01J2");
    expect(body.receivedAt).toBe("2026-09-23T12:00:01.000Z");
    expect(body.auth).toEqual({ spf: "FAIL", dkim: "PASS", dmarc: "FAIL" });
    expect(body.unsolicited).toBe(true);
    expect(body.text).toContain("To: [redacted-address]");
    expect(body.html).toContain("[redacted-address]");
    expect(body.links).toHaveLength(3);
    for (const l of body.links) expect(l).toContain("[redacted-address]");
    const s = JSON.stringify(body);
    expect(s).not.toContain("482913@");
    expect(s).not.toContain("482913%40");
  });

  it("redacts the overflow body read through bodyS3Key too", async () => {
    const deps = makeDeps({
      getEmail: vi.fn(async () => ({
        id: "01J2", from: "a@b", subject: "s", receivedAt: "t",
        text: "", links: [], bodyS3Key: "bodies/482913/01J2.json",
      })) as never,
    });
    (deps.readBody as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: `overflow To: ${ADDR}`, html: `<b>${ADDR}</b>`,
      links: [`mailto:${ADDR}`],
    });
    const app = createApp(deps);
    const res = await app.request("/fleet/emails/482913/01J2", vk);
    expect(deps.readBody).toHaveBeenCalledWith("bodies/482913/01J2.json");
    const s = await res.text();
    expect(s).not.toContain("482913@");
    expect(s).toContain("overflow To: [redacted-address]");
  });

  it("never emits a stored address field, and uses it only to resolve the domain", async () => {
    const deps = makeDeps({
      getEmail: vi.fn(async () => ({
        ...FULL, address: ADDR, // a storage shape that carries the mailbox address
      })) as never,
    });
    const app = createApp(deps);
    const s = await (await app.request("/fleet/emails/482913/01J2", vk)).text();
    expect(s).not.toContain("482913@");
    expect(s).not.toContain('"address"');
    expect(s).not.toContain("agents.example.com"); // the domain never travels either
  });

  it("404s unknown email and unknown agent with byte-identical bodies (no existence oracle)", async () => {
    const deps = makeDeps({ getEmail: vi.fn(async () => undefined) as never });
    const app = createApp(deps);
    const unknownEmail = await app.request("/fleet/emails/482913/01NOPE", vk);
    const unknownAgent = await app.request("/fleet/emails/999999/01J2", vk);
    expect(unknownEmail.status).toBe(404);
    expect(unknownAgent.status).toBe(404);
    expect(await unknownAgent.text()).toBe(await unknownEmail.text());
  });
});

describe("fleet mail auth matrix", () => {
  it("no key is 401; wrong viewer key is 403", async () => {
    const app = createApp(makeDeps());
    for (const path of ["/fleet/emails/482913", "/fleet/emails/482913/01J2"]) {
      expect((await app.request(path)).status).toBe(401);
      expect((await app.request(path, { headers: { "x-viewer-key": "wrong" } })).status).toBe(403);
    }
  });

  it("the fleet key and a valid agent signature are rejected", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    for (const path of ["/fleet/emails/482913", "/fleet/emails/482913/01J2"]) {
      expect((await app.request(path, { headers: { "x-fleet-key": "fk" } })).status).toBe(401);
      // the fleet key VALUE pasted into the viewer-key header fails its own partition
      expect((await app.request(path, { headers: { "x-viewer-key": "fk" } })).status).toBe(403);
      expect((await app.request(path, signed("GET", path))).status).toBe(401);
    }
    expect(deps.emails.listEmails).not.toHaveBeenCalled();
    expect(deps.emails.getEmail).not.toHaveBeenCalled();
  });

  it("no unauthenticated mail surface exists: /fleet/public/emails/* of any shape is 401/404", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const shapes = [
      "/fleet/public/emails",
      "/fleet/public/emails/482913",
      "/fleet/public/emails/482913/01J2",
      "/fleet/public/emails/482913/01J2/raw",
    ];
    for (const path of shapes) {
      expect([401, 404], path).toContain((await app.request(path)).status);
      // even a valid viewer key finds no mail route under the public prefix
      expect([401, 404], path).toContain((await app.request(path, vk)).status);
    }
    expect(deps.emails.listEmails).not.toHaveBeenCalled();
    expect(deps.emails.getEmail).not.toHaveBeenCalled();
  });
});
