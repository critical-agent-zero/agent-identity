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
