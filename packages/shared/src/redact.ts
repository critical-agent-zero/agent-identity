// Mailbox-address redaction for the operator (viewer-tier) mail surface.
// The invariant the API enforces with this helper: the agent's mailbox
// address NEVER travels to a viewer — not in bodies, subjects, links, HTML,
// or sender echoes, and not in any trivially-decodable rendering either.
// Verification mail routinely echoes the recipient in the To-line, in
// confirmation-link query params, and in mailto: URIs; real mailers also
// entity-encode "@" (anti-scraping, autoescape), percent-encode localparts in
// links, base64 the whole address into unsubscribe tokens, and wrap long
// tokens with soft hyphens. All of those are one mechanical decode away from
// the address, so redaction matches DECODED SHADOWS of the text — entity- and
// percent-decoded, invisible characters stripped — and maps every match back
// onto the original bytes.
import { sanitizeMailText } from "./mail.js";

const REPLACEMENT = "[redacted-address]";

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------
// Decoded shadows. Each shadow character remembers the ORIGINAL span it was
// decoded from, so a match found in shadow space is redacted from the
// original text — surrounding bytes are preserved verbatim, and nothing
// decoded is ever emitted.
interface Shadow {
  text: string;
  /** Original-span start for each UTF-16 unit of `text`. Non-decreasing. */
  start: number[];
  /** Original-span end for each UTF-16 unit of `text`. Non-decreasing. */
  end: number[];
}

function identityShadow(text: string): Shadow {
  const start = new Array<number>(text.length);
  const end = new Array<number>(text.length);
  for (let i = 0; i < text.length; i++) {
    start[i] = i;
    end[i] = i + 1;
  }
  return { text, start, end };
}

// Invisible characters (the sanitizer's strip class) are removed from the
// shadow so redaction matches THROUGH an interposed soft hyphen or zero-width
// character. The replacement span still covers their original bytes, because
// a shadow match maps back to the contiguous original range it straddles.
function stripInvisibles(sh: Shadow): Shadow {
  let text = "";
  const start: number[] = [];
  const end: number[] = [];
  for (let i = 0; i < sh.text.length; ) {
    const units = sh.text.codePointAt(i)! > 0xffff ? 2 : 1;
    const ch = sh.text.slice(i, i + units);
    if (sanitizeMailText(ch) !== "") {
      for (let j = i; j < i + units; j++) {
        text += sh.text[j]!;
        start.push(sh.start[j]!);
        end.push(sh.end[j]!);
      }
    }
    i += units;
  }
  return text.length === sh.text.length ? sh : { text, start, end };
}

// One decode pass over HTML character references (numeric with optional
// semicolon, as renderers accept; named from a focused table) and
// percent-encoded bytes. Passes iterate, so stacked encodings like
// `&amp;#64;` or `%2540` unwind to the address within the pass bound.
const TOKEN_RE = /&#([0-9]+);?|&#[xX]([0-9a-fA-F]+);?|&([A-Za-z]+);|%([0-9a-fA-F]{2})/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  commat: "@", period: ".", comma: ",", colon: ":", semi: ";",
  sol: "/", num: "#", percnt: "%", plus: "+", equals: "=",
  lowbar: "_", excl: "!", quest: "?", ast: "*", midast: "*",
  tab: "\t", newline: "\n",
};

const MAX_DECODE_PASSES = 5;

function decodeToken(m: RegExpExecArray): string | undefined {
  if (m[1] !== undefined || m[2] !== undefined) {
    const v = m[1] !== undefined ? Number(m[1]) : parseInt(m[2]!, 16);
    if (!Number.isFinite(v) || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) return undefined;
    return String.fromCodePoint(v);
  }
  if (m[3] !== undefined) return NAMED_ENTITIES[m[3].toLowerCase()];
  return String.fromCharCode(parseInt(m[4]!, 16));
}

function decodePass(sh: Shadow): Shadow | undefined {
  TOKEN_RE.lastIndex = 0;
  if (!TOKEN_RE.test(sh.text)) return undefined;
  let text = "";
  const start: number[] = [];
  const end: number[] = [];
  let pos = 0;
  let changed = false;
  const copy = (from: number, to: number): void => {
    for (let i = from; i < to; i++) {
      text += sh.text[i]!;
      start.push(sh.start[i]!);
      end.push(sh.end[i]!);
    }
  };
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(sh.text); m; m = TOKEN_RE.exec(sh.text)) {
    copy(pos, m.index);
    const tokenEnd = m.index + m[0].length;
    const decoded = decodeToken(m);
    if (decoded === undefined) {
      copy(m.index, tokenEnd); // undecodable reference stays literal
    } else {
      changed = true;
      const s0 = sh.start[m.index]!;
      const e0 = sh.end[tokenEnd - 1]!;
      for (let j = 0; j < decoded.length; j++) {
        text += decoded[j]!;
        start.push(s0);
        end.push(e0);
      }
    }
    pos = tokenEnd;
  }
  copy(pos, sh.text.length);
  return changed ? { text, start, end } : undefined;
}

function buildShadow(text: string): Shadow {
  let sh = stripInvisibles(identityShadow(text));
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    const next = decodePass(sh);
    if (!next) break;
    sh = stripInvisibles(next);
  }
  return sh;
}

// ---------------------------------------------------------------------------
// Patterns, matched in shadow space.
function addressPatterns(agentId: string, domain?: string): RegExp[] {
  const out: RegExp[] = [];
  if (agentId) {
    // The agent's own localpart under ANY domain (verification mail echoes
    // it; the domain in storage may differ in case), plus the residual
    // percent-encoded-@ hybrid and the bare `agentId@` quoted form.
    out.push(new RegExp(`${escapeRegExp(agentId)}(?:@|%40)[A-Za-z0-9._-]*`, "gi"));
  }
  if (domain) {
    // ANY address at the fleet's mail domain (or a subdomain), and the bare
    // domain itself. The viewer already knows every agentId from the roster,
    // so the domain alone reconstructs every mailbox address — another
    // agent's address in a From-line must not put it on the wire.
    out.push(new RegExp(
      `(?:[A-Za-z0-9._%+-]+(?:@|%40))?(?:[A-Za-z0-9-]+\\.)*${escapeRegExp(domain)}`,
      "gi",
    ));
  }
  return out;
}

function matchRanges(sh: Shadow, patterns: RegExp[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const re of patterns) {
    for (let m = re.exec(sh.text); m; m = re.exec(sh.text)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      ranges.push([sh.start[m.index]!, sh.end[m.index + m[0].length - 1]!]);
    }
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Base64 renderings of the EXACT address (the standard shape of unsubscribe
// and confirmation-link tokens). A base64 substring is position-dependent, so
// the needles are the encoded characters that depend only on the address
// bytes, computed at all three phase offsets and in both alphabets; a hit
// redacts the whole surrounding base64 run.
const B64_RUN_CH = /[A-Za-z0-9+/=_-]/;
const MIN_NEEDLE = 12;

function base64Needles(address: string): string[] {
  const needles = new Set<string>();
  const bytes = Buffer.from(address, "utf8");
  for (let k = 0; k < 3; k++) {
    const b64 = Buffer.concat([Buffer.alloc(k), bytes]).toString("base64");
    const startBit = k * 8;
    const endBit = (k + bytes.length) * 8;
    let stable = "";
    for (let i = 0; i * 6 < endBit; i++) {
      if (i * 6 >= startBit && (i + 1) * 6 <= endBit) stable += b64[i]!;
    }
    if (stable.length >= MIN_NEEDLE) {
      needles.add(stable);
      needles.add(stable.replace(/\+/g, "-").replace(/\//g, "_"));
    }
  }
  return [...needles];
}

function base64Ranges(sh: Shadow, address: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const t = sh.text;
  for (const needle of base64Needles(address)) {
    for (let idx = t.indexOf(needle); idx !== -1; idx = t.indexOf(needle, idx + 1)) {
      let a = idx;
      let b = idx + needle.length;
      while (a > 0 && B64_RUN_CH.test(t[a - 1]!)) a--;
      while (b < t.length && B64_RUN_CH.test(t[b]!)) b++;
      ranges.push([sh.start[a]!, sh.end[b - 1]!]);
    }
  }
  return ranges;
}

// ---------------------------------------------------------------------------
function splice(text: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return text;
  ranges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  let out = "";
  let pos = 0;
  for (const [s, e] of merged) {
    out += text.slice(pos, s) + REPLACEMENT;
    pos = e;
  }
  return out + text.slice(pos);
}

/** Replace every rendering of the agent's mailbox address with
 *  "[redacted-address]".
 *
 *  Matched forms, all case-insensitive, in the text AND in its decoded
 *  shadows (HTML character references — decimal, hex, named — and
 *  percent-encoding, unwound through stacked passes, with invisible
 *  characters such as soft hyphen and zero-width space stripped):
 *   - `agentId@<domain-ish run>` — the full address under ANY domain
 *   - `agentId%40<domain-ish run>` — the percent-encoded form inside links
 *   - the bare `agentId@` localpart form left inside mailto:/quoted strings
 *
 *  `domain`, when given, additionally redacts ANY address at that domain or
 *  its subdomains and every bare mention of the domain itself (the viewer
 *  knows all agentIds, so the domain reconstructs every mailbox address),
 *  plus base64/base64url renderings of the exact `agentId@domain` at all
 *  three phase offsets. It never narrows the generic form and is never
 *  emitted.
 *
 *  Deliberately fail-closed: a longer localpart that merely embeds the
 *  agent's address (e.g. `x482913@d`) is still redacted from the embedded
 *  `agentId@` on — leaving it intact would put the address bytes on the
 *  wire. Over-redaction is acceptable; leakage is not.
 */
export function redactAddress(text: string, agentId: string, domain?: string): string {
  if (!agentId && !domain) return text;
  const sh = buildShadow(text);
  const ranges = matchRanges(sh, addressPatterns(agentId, domain));
  if (agentId && domain) {
    const address = `${agentId}@${domain}`;
    ranges.push(...base64Ranges(sh, address));
    const lower = address.toLowerCase();
    if (lower !== address) ranges.push(...base64Ranges(sh, lower));
  }
  return splice(text, ranges);
}
