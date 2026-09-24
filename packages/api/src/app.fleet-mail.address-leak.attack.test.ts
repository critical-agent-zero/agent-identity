// ATTACK SUITE — the fleet mail viewer's invariant is "the agent's mailbox
// address never travels". These tests attack the invariant with the encodings
// and interpositions real mail actually uses: HTML character references,
// invisible Unicode inside the localpart, percent- and base64-encoded link
// params, and OTHER fleet addresses that put the shared mail domain on the
// wire. Every oracle below decodes exactly like a mail client or one line of
// attacker JS would — if the oracle recovers the address (or the domain), the
// bytes left the API and the invariant is broken.
import { describe, expect, it, vi } from "vitest";
import { createApp, type Deps } from "./app.js";
import type { NoncesRepo } from "./db/nonces.js";

const AGENT_ID = "482913";
const DOMAIN = "agents.example.com";
const ADDR = `${AGENT_ID}@${DOMAIN}`;

// --- attacker-side decode oracles ------------------------------------------
// One entity-decode pass, as every HTML renderer performs.
const decodeEntities = (s: string): string => s
  .replace(/&#(\d+);?/g, (_, d: string) => String.fromCodePoint(Number(d)))
  .replace(/&#[xX]([0-9a-fA-F]+);?/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&commat;/gi, "@")
  .replace(/&period;/gi, ".")
  .replace(/&amp;/gi, "&");

// One percent-decode pass, as a URL consumer performs.
const decodePercent = (s: string): string =>
  s.replace(/%([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

// Invisible characters built from code points so this source file itself
// carries none of them (repo convention, see mail.test.ts).
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const SHY = cp(0x00ad); // soft hyphen
const ZWSP = cp(0x200b); // zero width space

// Strip the invisible-character class an operator cannot see in a dashboard.
const INVISIBLE_RE = new RegExp(
  `[${cp(0x00ad)}${cp(0x034f)}${cp(0x180e)}${cp(0x200b)}-${cp(0x200f)}${cp(0x2060)}${cp(0xfeff)}]`,
  "g",
);
const stripInvisible = (s: string): string => s.replace(INVISIBLE_RE, "");

// Try to read the address back out of every base64-looking run in the
// response, at every phase offset and in both alphabets.
const base64Decodings = (s: string): string[] => {
  const out: string[] = [];
  for (const run of s.match(/[A-Za-z0-9+/=_-]{12,}/g) ?? []) {
    const norm = run.replace(/-/g, "+").replace(/_/g, "/");
    for (let k = 0; k < 4; k++) {
      try {
        out.push(Buffer.from(norm.slice(k).replace(/=+$/, ""), "base64").toString("latin1"));
      } catch { /* not base64 — nothing recovered */ }
    }
  }
  return out;
};

// The single invariant every response must satisfy: no rendering of the
// mailbox address — and no rendering of the shared mail domain, which
// reconstructs every mailbox address given the public agentId roster.
function expectNoAddressLeak(serialized: string): void {
  const shadows = [
    serialized,
    decodeEntities(serialized),
    decodeEntities(decodeEntities(serialized)),
    decodePercent(serialized),
    decodePercent(decodePercent(serialized)),
    decodeEntities(decodePercent(serialized)),
  ].map(stripInvisible);
  for (const shadow of shadows) {
    expect(shadow).not.toContain(`${AGENT_ID}@`);
    expect(shadow).not.toContain(`${AGENT_ID}%40`);
    expect(shadow).not.toContain(DOMAIN);
  }
  for (const decoded of base64Decodings(serialized)) {
    expect(decoded).not.toContain(ADDR);
    expect(decoded).not.toContain(DOMAIN);
  }
}

// --- fixtures ---------------------------------------------------------------
const BASE = {
  id: "01J2", from: "GitHub <noreply@github.com>", subject: "verify",
  receivedAt: "2026-09-23T12:00:01.000Z", text: "", links: [] as string[],
};

function makeDeps(email: Record<string, unknown>): Deps {
  return {
    agents: {
      verifyFleetKey: vi.fn(async () => true),
      verifyAdminKey: vi.fn(async () => false),
      verifyViewerKey: vi.fn(async (k: string) => k === "vk"),
    } as never,
    emails: {
      listEmails: vi.fn(async () => ({ emails: [{ ...BASE, ...email }] })),
      getEmail: vi.fn(async () => ({ ...BASE, ...email })),
    } as never,
    activity: {} as never,
    nonces: { recordOnce: async () => true } as never as NoncesRepo,
    readBody: vi.fn(async () => ({ text: "", links: [] })),
    fleetKeyRequired: true,
    publicRepos: [],
    mailDomain: DOMAIN,
    autoCapabilities: [],
  };
}

const vk = { headers: { "x-viewer-key": "vk" } };

async function bodyView(email: Record<string, unknown>): Promise<string> {
  const app = createApp(makeDeps(email));
  const res = await app.request(`/fleet/emails/${AGENT_ID}/01J2`, vk);
  expect(res.status).toBe(200);
  return res.text();
}

// --- ATTACK 1 (blocker): HTML-entity-encoded address in the html field ------
// Ingest stores mailparser's html verbatim; entity-encoding of "@" is routine
// in real mailers (anti-scraping, autoescape). One trivial decode — which
// every HTML renderer performs — yields the full address.
describe("ATTACK 1 — entity-encoded address in html bypasses redaction", () => {
  it("decimal reference for @ (&#64;)", async () => {
    const s = await bodyView({ html: `<p>To: ${AGENT_ID}&#64;${DOMAIN}</p>` });
    expectNoAddressLeak(s);
    expect(s).toContain("[redacted-address]");
  });

  it("hex reference for @ (&#x40;)", async () => {
    const s = await bodyView({ html: `<p>To: ${AGENT_ID}&#x40;${DOMAIN}</p>` });
    expectNoAddressLeak(s);
  });

  it("named reference for @ (&commat;)", async () => {
    const s = await bodyView({ html: `<p>To: ${AGENT_ID}&commat;${DOMAIN}</p>` });
    expectNoAddressLeak(s);
  });

  it("entity-encoded digit INSIDE the localpart (&#52;82913@…)", async () => {
    const s = await bodyView({ html: `<p>To: &#52;82913@${DOMAIN}</p>` });
    expectNoAddressLeak(s);
  });

  it("double-encoded @ (&amp;#64;) still cannot survive two renderer passes", async () => {
    const s = await bodyView({ html: `<p>To: ${AGENT_ID}&amp;#64;${DOMAIN}</p>` });
    expectNoAddressLeak(s);
  });
});

// --- ATTACK 2: invisible characters interposed inside the localpart ---------
describe("ATTACK 2 — invisible characters inside the address defeat the regex", () => {
  it("post-#98 record: SOFT HYPHEN (U+00AD) survives today's ingest sanitization", async () => {
    // sanitizeMailText's historical strip set did not include U+00AD, so this
    // is what a record ingested TODAY looks like; the dashboard renders the
    // soft hyphen invisibly — the operator-visible text IS the address.
    const s = await bodyView({ text: `To: 4${SHY}82913@${DOMAIN}\nplease verify.` });
    expectNoAddressLeak(s);
    expect(s).toContain("[redacted-address]");
  });

  it("pre-#98 record: ZERO WIDTH SPACE stored before ingest stripped it", async () => {
    // The route knowingly serves legacy records (pre-verdict grandfathering),
    // so the read path must re-sanitize — ingest-time stripping cannot help
    // data that is already stored.
    const s = await bodyView({ text: `To: 48${ZWSP}2913@${DOMAIN}\nplease verify.` });
    expectNoAddressLeak(s);
  });

  it("soft hyphen in a link and in html too", async () => {
    const s = await bodyView({
      html: `<a href="mailto:4${SHY}82913@${DOMAIN}">confirm</a>`,
      links: [`mailto:4${SHY}82913@${DOMAIN}`],
    });
    expectNoAddressLeak(s);
  });
});

// --- ATTACK 3: alternative encodings in links ------------------------------
describe("ATTACK 3 — percent- and base64-encoded address in links", () => {
  it("fully percent-encoded localpart travels through links[] and html", async () => {
    const link = `https://verify.example/confirm?email=%34%38%32%39%31%33%40${DOMAIN}`;
    const s = await bodyView({ links: [link], html: `<a href="${link}">confirm</a>` });
    expectNoAddressLeak(s);
  });

  it("mixed percent-encoding of a single digit (48291%33@…)", async () => {
    const s = await bodyView({
      links: [`https://verify.example/confirm?email=48291%33@${DOMAIN}`],
    });
    expectNoAddressLeak(s);
  });

  it("base64-encoded full address — the standard unsubscribe/confirm link shape", async () => {
    const b64 = Buffer.from(ADDR).toString("base64"); // NDgyOTEzQGFnZW50cy5leGFtcGxlLmNvbQ==
    const s = await bodyView({
      links: [`https://verify.example/confirm?u=${b64}`],
      text: `or paste this token: ${b64}`,
    });
    expectNoAddressLeak(s);
  });

  it("base64url at a shifted phase offset", async () => {
    const b64url = Buffer.from(`u:${ADDR}`).toString("base64url");
    const s = await bodyView({
      links: [`https://verify.example/confirm?u=${b64url}`],
    });
    expectNoAddressLeak(s);
  });
});

// --- ATTACK 4: another agent's address leaks the shared mail domain ---------
describe("ATTACK 4 — ANOTHER fleet agent's address puts the domain on the wire", () => {
  const OTHER_FROM = `Agent B <555555@${DOMAIN}>`;

  it("body view: from-field address of a different agent is redacted with its domain", async () => {
    const s = await bodyView({ from: OTHER_FROM, text: `555555@${DOMAIN} wrote:\nhi` });
    // The viewer knows every agentId from /fleet/agents; the domain alone
    // reconstructs every mailbox address, including this agent's.
    expectNoAddressLeak(s);
    expect(s).not.toContain("555555@");
  });

  it("list view: summaries redact other-agent addresses too", async () => {
    const app = createApp(makeDeps({ from: OTHER_FROM, subject: `re: 999999@${DOMAIN}` }));
    const res = await app.request(`/fleet/emails/${AGENT_ID}`, vk);
    expect(res.status).toBe(200);
    const s = await res.text();
    expectNoAddressLeak(s);
    expect(s).not.toContain("555555@");
    expect(s).not.toContain("999999@");
  });

  it("third-party addresses stay readable — redaction is domain-scoped, not blanket", async () => {
    const s = await bodyView({ from: OTHER_FROM, text: "contact noreply@github.com" });
    expect(s).toContain("noreply@github.com");
  });
});
