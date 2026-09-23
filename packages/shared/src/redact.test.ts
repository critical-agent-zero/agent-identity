import { describe, expect, it } from "vitest";
import { redactAddress } from "./redact.js";

// Verification-mail-shaped fixtures: providers echo the recipient address in
// the To-line, in query params of confirmation links, and in mailto: URIs.
const ID = "482913";
const ADDR = "482913@agents.example.com";
const R = "[redacted-address]";

describe("redactAddress", () => {
  it("redacts the address echoed in a To-line", () => {
    const text = `Hi,\nTo: ${ADDR}\nplease verify your address.`;
    const out = redactAddress(text, ID);
    expect(out).not.toContain("482913@");
    expect(out).toContain(`To: ${R}`);
  });

  it("redacts the address inside links as a query param, plain and percent-encoded", () => {
    const plain = `https://github.com/verify?email=${ADDR}&token=t`;
    expect(redactAddress(plain, ID)).toBe(`https://github.com/verify?email=${R}&token=t`);
    const encoded = "https://github.com/verify?email=482913%40agents.example.com&token=t";
    const out = redactAddress(encoded, ID);
    expect(out).not.toContain("482913%40");
    expect(out).not.toContain("482913@");
  });

  it("redacts mailto: forms", () => {
    expect(redactAddress(`Reply to mailto:${ADDR} today`, ID))
      .toBe(`Reply to mailto:${R} today`);
  });

  it("redacts mixed-case renderings of the same mailbox", () => {
    const out = redactAddress("sent to 482913@Agents.Example.COM.", ID);
    expect(out.toLowerCase()).not.toContain("482913@");
    expect(out).toContain(R);
  });

  it("redacts the bare agentId@ localpart form inside quoted strings", () => {
    const html = `<a href="mailto:482913@agents.example.com">"482913@"</a>`;
    const out = redactAddress(html, ID);
    expect(out).not.toContain("482913@");
  });

  it("redacts every occurrence, not just the first", () => {
    const out = redactAddress(`${ADDR} and again ${ADDR}`, ID);
    expect(out).toBe(`${R} and again ${R}`);
    expect(out).not.toContain("482913@");
  });

  it("accepts an optional domain without weakening the generic form", () => {
    const out = redactAddress(`a ${ADDR} b 482913@elsewhere.example c`, ID, "agents.example.com");
    expect(out).not.toContain("482913@");
    expect(out).toBe(`a ${R} b ${R} c`);
  });

  it("over-redacts a longer localpart that embeds the agent address (fail closed)", () => {
    // "x482913@d" is someone else's address, but leaving it intact would put
    // the byte sequence "482913@" on the wire. Security beats precision.
    expect(redactAddress("from x482913@d.example", ID)).not.toContain("482913@");
  });

  it("leaves unrelated addresses and text untouched", () => {
    const text = "from noreply@github.com — your build passed (id 482913)";
    expect(redactAddress(text, ID)).toBe(text);
  });

  it("treats the agentId as a literal, not a regex", () => {
    expect(redactAddress("a.b@x a1b@x", "a.b")).toBe("[redacted-address] a1b@x");
  });

  it("is a no-op on an empty agentId", () => {
    expect(redactAddress("text 482913@d", "")).toBe("text 482913@d");
  });
});

// Invisible characters built from code points so this source file itself
// carries none of them.
const cp = (...codes: number[]) => String.fromCodePoint(...codes);

describe("redactAddress — encoded renderings (fail-closed shadows)", () => {
  it("redacts HTML-entity-encoded @ — decimal, hex, and named forms", () => {
    for (const at of ["&#64;", "&#064;", "&#x40;", "&#X40;", "&commat;"]) {
      const out = redactAddress(`To: 482913${at}agents.example.com`, ID);
      expect(out, at).not.toContain("482913@");
      expect(out, at).not.toContain(at);
      expect(out, at).toContain(R);
    }
  });

  it("redacts an entity-encoded digit INSIDE the localpart", () => {
    const out = redactAddress("To: &#52;82913@agents.example.com", ID);
    expect(out).not.toContain("82913@");
    expect(out).toContain(R);
  });

  it("redacts the double-encoded &amp;#64; form (two renderer passes)", () => {
    const out = redactAddress("To: 482913&amp;#64;agents.example.com", ID);
    expect(out).not.toContain("482913&");
    expect(out).toContain(R);
  });

  it("redacts entity-encoded dots in the domain half", () => {
    const out = redactAddress("482913@agents&period;example&period;com", ID);
    expect(out).not.toContain("482913@");
  });

  it("redacts a fully percent-encoded localpart, and a single percent-encoded digit", () => {
    const full = redactAddress(
      "https://verify.example/confirm?email=%34%38%32%39%31%33%40agents.example.com", ID);
    expect(full).not.toContain("%34%38");
    expect(full).not.toContain("agents.example.com");
    expect(full).toContain(R);
    const mixed = redactAddress("?email=48291%33@agents.example.com", ID);
    expect(mixed).not.toContain("48291%33@");
    expect(mixed).toContain(R);
  });

  it("redacts the double-percent-encoded form (%2540)", () => {
    const out = redactAddress("?email=482913%2540agents.example.com", ID);
    expect(out).not.toContain("482913%2540");
    expect(out).toContain(R);
  });

  it("matches through interposed invisible characters and redacts their whole span", () => {
    for (const invisible of [cp(0x00ad), cp(0x200b), cp(0x034f)]) {
      const out = redactAddress(`To: 4${invisible}829${invisible}13@agents.example.com`, ID);
      expect(out, `U+${invisible.codePointAt(0)!.toString(16)}`).not.toContain("13@");
      expect(out).toContain(R);
    }
  });

  it("redacts an entity-encoded zero-width space interposed in the localpart", () => {
    const out = redactAddress("To: 48&#8203;2913@agents.example.com", ID);
    expect(out).not.toContain("2913@");
    expect(out).toContain(R);
  });

  it("redacts base64 and base64url renderings of the exact address at every phase offset", () => {
    for (const [label, run] of [
      ["offset 0", Buffer.from(ADDR).toString("base64")],
      ["offset 1", Buffer.from(`x${ADDR}`).toString("base64")],
      ["offset 2", Buffer.from(`xy${ADDR}`).toString("base64")],
      ["base64url", Buffer.from(`u:${ADDR}`).toString("base64url")],
    ] as const) {
      const out = redactAddress(`?u=${run}`, ID, "agents.example.com");
      expect(out, label).not.toContain(run);
      expect(out, label).toContain(R);
    }
  });

  it("leaves base64 of unrelated text alone", () => {
    const run = Buffer.from("an ordinary confirmation token payload").toString("base64");
    expect(redactAddress(`?u=${run}`, ID, "agents.example.com")).toContain(run);
  });
});

describe("redactAddress — fleet-domain generic redaction (domain given)", () => {
  const D = "agents.example.com";

  it("redacts ANOTHER localpart at the fleet domain — the domain reconstructs every mailbox", () => {
    const out = redactAddress(`Agent B <555555@${D}> wrote:`, ID, D);
    expect(out).not.toContain("555555@");
    expect(out).not.toContain(D);
    expect(out).toContain(R);
  });

  it("redacts subdomain and percent-encoded-@ forms at the fleet domain", () => {
    const out = redactAddress(`a 777@mail.${D} b 888%40${D} c`, ID, D);
    expect(out).not.toContain(D);
    expect(out).toBe(`a ${R} b ${R} c`);
  });

  it("redacts a bare mention of the fleet domain itself", () => {
    expect(redactAddress(`our server is ${D} today`, ID, D)).toBe(`our server is ${R} today`);
  });

  it("leaves other domains and their addresses readable", () => {
    const text = `from noreply@github.com via smtp.example.net`;
    expect(redactAddress(text, ID, D)).toBe(text);
  });
});
