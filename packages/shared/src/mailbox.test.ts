import { describe, expect, it } from "vitest";
import { isValidMailboxSlug, matchesMailboxAllowlist } from "./mailbox.js";

const cp = (...codes: number[]) => String.fromCodePoint(...codes);

describe("isValidMailboxSlug", () => {
  it("accepts a lowercase slug starting with a letter", () => {
    expect(isValidMailboxSlug("ops")).toBe(true);
    expect(isValidMailboxSlug("ops-alerts")).toBe(true);
    expect(isValidMailboxSlug("a1")).toBe(true);
    // 31 chars (leading letter + 30) is the max.
    expect(isValidMailboxSlug("a" + "b".repeat(30))).toBe(true);
  });

  it("rejects slugs that break the pattern", () => {
    expect(isValidMailboxSlug("a")).toBe(false);            // too short (min 2)
    expect(isValidMailboxSlug("Ops")).toBe(false);          // uppercase
    expect(isValidMailboxSlug("1ops")).toBe(false);         // leading digit
    expect(isValidMailboxSlug("-ops")).toBe(false);         // leading hyphen
    expect(isValidMailboxSlug("ops_alerts")).toBe(false);   // underscore
    expect(isValidMailboxSlug("ops.alerts")).toBe(false);   // dot
    expect(isValidMailboxSlug("a" + "b".repeat(31))).toBe(false); // 32 chars
    expect(isValidMailboxSlug("")).toBe(false);
  });

  it("rejects a 6-digit numeric so it can never collide with a pool agentId", () => {
    expect(isValidMailboxSlug("482913")).toBe(false);
  });
});

describe("matchesMailboxAllowlist", () => {
  it("matches an exact address (address-part only, never the display name)", () => {
    expect(matchesMailboxAllowlist("Alerts <alerts@status.example>", ["alerts@status.example"]))
      .toBe(true);
    expect(matchesMailboxAllowlist("alerts@status.example", ["alerts@status.example"]))
      .toBe(true);
    // Case-insensitive on both sides.
    expect(matchesMailboxAllowlist("Alerts@Status.Example", ["alerts@status.example"]))
      .toBe(true);
  });

  it("does not match a different exact address", () => {
    expect(matchesMailboxAllowlist("other@status.example", ["alerts@status.example"]))
      .toBe(false);
  });

  it("matches a *@domain pattern including subdomains on label boundaries", () => {
    expect(matchesMailboxAllowlist("GitHub <noreply@github.com>", ["*@github.com"])).toBe(true);
    expect(matchesMailboxAllowlist("<noreply@mail.github.com>", ["*@github.com"])).toBe(true);
  });

  it("rejects a label-boundary lookalike of a *@domain pattern", () => {
    expect(matchesMailboxAllowlist("<noreply@evil-github.com>", ["*@github.com"])).toBe(false);
    expect(matchesMailboxAllowlist("<noreply@evilgithub.com>", ["*@github.com"])).toBe(false);
    expect(matchesMailboxAllowlist("<noreply@github.com.evil.example>", ["*@github.com"])).toBe(false);
  });

  it("never trusts a spoofed display name or an appended second mailbox", () => {
    // The allowlisted address sits in the display name; the real sender is evil.
    expect(matchesMailboxAllowlist('"alerts@status.example" <x@evil.example>', ["alerts@status.example"]))
      .toBe(false);
    // Multi-mailbox From fails closed for both address and *@domain entries.
    expect(matchesMailboxAllowlist("x@evil.example, alerts@status.example", ["alerts@status.example"]))
      .toBe(false);
    expect(matchesMailboxAllowlist("x@evil.example, noreply@github.com", ["*@github.com"]))
      .toBe(false);
  });

  it("fails closed on an injection-class lookalike address", () => {
    expect(matchesMailboxAllowlist(`<x@evil${cp(0x202e)}${cp(0x200b)}.github.com>`, ["*@github.com"]))
      .toBe(false);
    expect(matchesMailboxAllowlist(`<alerts${cp(0x00ad)}@status.example>`, ["alerts@status.example"]))
      .toBe(false);
  });

  it("ignores blank and malformed entries and an empty allowlist", () => {
    expect(matchesMailboxAllowlist("alerts@status.example", [])).toBe(false);
    expect(matchesMailboxAllowlist("alerts@status.example", ["", "  "])).toBe(false);
    expect(matchesMailboxAllowlist("alerts@status.example", ["notanaddress"])).toBe(false);
  });
});
