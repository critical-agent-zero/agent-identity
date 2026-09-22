// Mail trust helpers shared by ingest (sender allowlist), the MCP server
// (verification-link extraction), and any other reader of stored mail.

// Character classes are built from code points so this source file itself
// carries no raw control bytes or invisible characters.
const range = (from: number, to: number) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`;

// The display name of a From header is attacker-controlled; only the domain
// of the address part counts. Angle-bracketed address wins over the bare form.
export function senderDomain(from: string): string | undefined {
  const angled = /<([^<>]*)>\s*$/.exec(from);
  const addr = (angled ? angled[1]! : from).trim();
  const at = addr.lastIndexOf("@");
  if (at < 0) return undefined;
  const domain = addr.slice(at + 1).toLowerCase();
  return domain || undefined;
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
// characters are stripped before mail text is persisted.
const STRIP_RE = new RegExp(
  `[${range(0x00, 0x08)}${range(0x0b, 0x1f)}${range(0x7f, 0x9f)}` + // C0 minus \n\t, DEL, C1
  `${range(0x200b, 0x200f)}${String.fromCodePoint(0x2060)}${String.fromCodePoint(0xfeff)}` + // zero-width
  `${range(0x202a, 0x202e)}${range(0x2066, 0x2069)}]`, // bidi controls
  "g",
);

export function sanitizeMailText(text: string): string {
  return text.replace(STRIP_RE, "");
}
