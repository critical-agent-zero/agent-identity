import { describe, expect, it } from "vitest";
import { isPinnedLink, matchesSenderDomain, sanitizeMailText, senderDomain } from "./mail.js";

// Control characters built by code point so this file itself stays free of
// raw control bytes and invisible characters.
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const ESC = cp(0x1b);
const DEL = cp(0x7f);
const NL = cp(0x0a);
const TAB = cp(0x09);
const CR = cp(0x0d);

describe("senderDomain", () => {
  it("takes the domain from the address part, never the display name", () => {
    expect(senderDomain("GitHub <noreply@github.com>")).toBe("github.com");
    expect(senderDomain("noreply@github.com <evil@attacker.example>")).toBe("attacker.example");
  });

  it("lowercases and handles bare addresses", () => {
    expect(senderDomain("Noreply@Mail.GitHub.COM")).toBe("mail.github.com");
  });

  it("returns undefined when no address is present", () => {
    expect(senderDomain("just a name")).toBeUndefined();
    expect(senderDomain("")).toBeUndefined();
  });

  it("fails closed on a multi-mailbox From header", () => {
    expect(senderDomain("Evil <attacker@evil.example>, GitHub <noreply@github.com>")).toBeUndefined();
    expect(senderDomain("attacker@evil.example, noreply@github.com")).toBeUndefined();
    expect(senderDomain("Evil <attacker@evil.example> <noreply@github.com>")).toBeUndefined();
  });

  it("allows a comma or angle bracket inside a quoted display name", () => {
    expect(senderDomain('"GitHub, Inc." <noreply@github.com>')).toBe("github.com");
    expect(senderDomain('"a <b@c.d>" <noreply@github.com>')).toBe("github.com");
  });

  it("fails closed on a domain carrying injection-class characters or whitespace", () => {
    // Bidi/zero-width lookalikes built to suffix-match an allowlisted domain.
    expect(senderDomain(`<x@evil${cp(0x202e)}${cp(0x200b)}.github.com>`)).toBeUndefined();
    expect(senderDomain(`<x@evil${ESC}.github.com>`)).toBeUndefined();
    expect(senderDomain(`<x@evil${TAB}.github.com>`)).toBeUndefined();
    expect(senderDomain("<x@evil .github.com>")).toBeUndefined();
  });
});

describe("matchesSenderDomain", () => {
  it("matches the exact domain and subdomains on label boundaries", () => {
    expect(matchesSenderDomain("GitHub <noreply@github.com>", "github.com")).toBe(true);
    expect(matchesSenderDomain("<noreply@mail.github.com>", "github.com")).toBe(true);
  });

  it("rejects lookalike suffixes and display-name spoofing", () => {
    expect(matchesSenderDomain("<noreply@evilgithub.com>", "github.com")).toBe(false);
    expect(matchesSenderDomain(`<x@evil${cp(0x202e)}${cp(0x200b)}.github.com>`, "github.com")).toBe(false);
    expect(matchesSenderDomain("noreply@github.com <x@evil.example>", "github.com")).toBe(false);
    expect(matchesSenderDomain("no address here", "github.com")).toBe(false);
  });

  it("does not trust an allowlisted mailbox appended after the attacker's", () => {
    expect(matchesSenderDomain("Evil <attacker@evil.example>, GitHub <noreply@github.com>", "github.com")).toBe(false);
    expect(matchesSenderDomain("attacker@evil.example, noreply@github.com", "github.com")).toBe(false);
  });
});

describe("isPinnedLink", () => {
  it("accepts a link whose parsed origin equals the pinned origin", () => {
    expect(isPinnedLink("https://github.com/verify?t=abc", "https://github.com")).toBe(true);
  });

  it("rejects lookalike hosts, downgrades, and unparseable links", () => {
    expect(isPinnedLink("https://github.com.evil.example/verify", "https://github.com")).toBe(false);
    expect(isPinnedLink("http://github.com/verify", "https://github.com")).toBe(false);
    expect(isPinnedLink("not a url", "https://github.com")).toBe(false);
  });

  it("rejects links containing raw C0/C1 control bytes", () => {
    // OSC 8 hyperlink escape: rewrites the displayed link in a terminal.
    expect(isPinnedLink("https://github.com/" + ESC + "]8;;x", "https://github.com")).toBe(false);
    expect(isPinnedLink("https://github.com/" + cp(0x90) + "p", "https://github.com")).toBe(false);
  });
});

describe("sanitizeMailText", () => {
  it("strips C0 controls and DEL, keeping newline and tab", () => {
    expect(sanitizeMailText("a" + ESC + "b" + cp(0x00) + "c" + CR + "d" + NL + "e" + TAB + "f" + DEL + "g"))
      .toBe("abcd" + NL + "e" + TAB + "fg");
  });

  it("strips C1, zero-width, and bidi control characters", () => {
    expect(sanitizeMailText("a" + cp(0x9b) + "b" + cp(0x200b) + "c" + cp(0x200f) + "d" + cp(0x2060) + "e" + cp(0xfeff) + "f"))
      .toBe("abcdef");
    expect(sanitizeMailText("x" + cp(0x202e) + "y" + cp(0x202a) + "z" + cp(0x2066) + "w" + cp(0x2069) + "v"))
      .toBe("xyzwv");
  });

  it("strips soft hyphen, CGJ, Mongolian vowel separator, variation selectors, and tag characters", () => {
    // Soft hyphen is the live attack: it renders invisibly inside a mailbox
    // localpart, so `4<SHY>82913@…` displays as the intact address while
    // defeating any literal-match redaction. The rest are the same class.
    expect(sanitizeMailText(
      "4" + cp(0x00ad) + "8" + cp(0x034f) + "2" + cp(0x180e) + "9" +
      cp(0xfe0f) + "1" + cp(0xe0041) + "3" + cp(0xe0101) + "@d",
    )).toBe("482913@d");
  });

  it("leaves ordinary unicode text alone", () => {
    const plain = "hello world " + cp(0xe9, 0x2014, 0x65e5) + NL + TAB + "ok";
    expect(sanitizeMailText(plain)).toBe(plain);
  });
});
