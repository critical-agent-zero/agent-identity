// Mail trust helpers shared by ingest (sender allowlist), the MCP server
// (verification-link extraction), and any other reader of stored mail.

// Character classes are built from code points so this source file itself
// carries no raw control bytes or invisible characters.
const range = (from: number, to: number) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`;

// Quoted display names may legitimately contain commas, "@", or "<", so
// quoted sections are ignored when counting mailboxes.
const QUOTED_RE = /"(?:[^"\\]|\\.)*"/g;

// The display name of a From header is attacker-controlled; only the address
// part counts. Angle-bracketed address wins over the bare form. RFC 5322
// allows several mailboxes in From and the parsed header preserves them all;
// an attacker can append an allowlisted mailbox after their own authenticated
// address, so any multi-mailbox From fails closed to undefined.
function singleAddressPart(from: string): string | undefined {
  const unquoted = from.replace(QUOTED_RE, "");
  const withAddress = unquoted.split(",").filter((part) => part.includes("@"));
  if (withAddress.length > 1 || (unquoted.match(/</g) ?? []).length > 1) return undefined;
  const angled = /<([^<>]*)>\s*$/.exec(from);
  const addr = (angled ? angled[1]! : from).trim();
  return addr.lastIndexOf("@") < 0 ? undefined : addr;
}

export function senderDomain(from: string): string | undefined {
  const addr = singleAddressPart(from);
  if (addr === undefined) return undefined;
  const domain = addr.slice(addr.lastIndexOf("@") + 1).toLowerCase();
  if (!domain) return undefined;
  // A "domain" containing the stripped character class (bidi overrides,
  // zero-width, C0/C1 controls) or any whitespace is not a real mail domain
  // — it is a lookalike like `evil<RLO><ZWSP>.github.com` built to
  // suffix-match an allowlisted domain. Fail closed: such mail can never
  // count as allowlisted nor reach an attested email_received event.
  if (sanitizeMailText(domain) !== domain || /\s/.test(domain)) return undefined;
  return domain;
}

// The full lowercased address-part (localpart@domain), for exact-address
// allowlist matching. Fails closed on the same multi-mailbox From as
// senderDomain, and on any address whose text carries the injection-class
// characters or whitespace — a `4<SHY>82913@…` lookalike that renders as an
// allowlisted address must never match it.
export function senderAddress(from: string): string | undefined {
  const addr = singleAddressPart(from);
  if (addr === undefined) return undefined;
  const lower = addr.toLowerCase();
  if (!lower.slice(lower.lastIndexOf("@") + 1)) return undefined;
  if (sanitizeMailText(lower) !== lower || /\s/.test(lower)) return undefined;
  return lower;
}

// Exact domain or subdomain, matched on a label boundary: mail.github.com
// matches github.com; evilgithub.com does not.
export function matchesSenderDomain(from: string, domain: string): boolean {
  const actual = senderDomain(from);
  if (!actual) return false;
  const allowed = domain.toLowerCase();
  return actual === allowed || actual.endsWith(`.${allowed}`);
}

// Raw C0/C1/DEL bytes are rejected outright: new URL() accepts them in a path
// while still reporting the pinned origin, but printed to a terminal they are
// ANSI escapes that can rewrite the displayed line into an attacker URL.
const CONTROL_RE = new RegExp(`[${range(0x00, 0x1f)}${range(0x7f, 0x9f)}]`);

// Link authenticity: the link must parse and its WHATWG origin must equal the
// pinned origin exactly — no lookalike hosts, no http downgrade.
export function isPinnedLink(link: string, origin: string): boolean {
  if (CONTROL_RE.test(link)) return false;
  try {
    return new URL(link).origin === origin;
  } catch {
    return false;
  }
}

// Storage-layer defense against the ANSI-injection class: C0 controls (except
// newline U+000A and tab U+0009), DEL+C1, zero-width, and bidi-override
// characters are stripped before mail text is persisted. The set also covers
// every INVISIBLE-WHEN-RENDERED character that can be interposed inside a
// mailbox localpart to defeat address redaction while the operator still
// reads the intact address: soft hyphen (HTML generators insert it to wrap
// long tokens), combining grapheme joiner, Mongolian vowel separator,
// variation selectors (BMP and plane-14), and plane-14 tag characters.
const STRIP_RE = new RegExp(
  `[${range(0x00, 0x08)}${range(0x0b, 0x1f)}${range(0x7f, 0x9f)}` + // C0 minus \n\t, DEL, C1
  `${String.fromCodePoint(0x00ad)}${String.fromCodePoint(0x034f)}${String.fromCodePoint(0x180e)}` + // soft hyphen, CGJ, MVS
  `${range(0x200b, 0x200f)}${String.fromCodePoint(0x2060)}${String.fromCodePoint(0xfeff)}` + // zero-width
  `${range(0x202a, 0x202e)}${range(0x2066, 0x2069)}` + // bidi controls
  `${range(0xfe00, 0xfe0f)}${range(0xe0000, 0xe007f)}${range(0xe0100, 0xe01ef)}]`, // variation selectors, tags
  "gu",
);

export function sanitizeMailText(text: string): string {
  return text.replace(STRIP_RE, "");
}
