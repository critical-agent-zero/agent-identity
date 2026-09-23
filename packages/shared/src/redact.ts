// Mailbox-address redaction for the operator (viewer-tier) mail surface.
// The invariant the API enforces with this helper: the agent's mailbox
// address NEVER travels to a viewer — not in bodies, subjects, links, HTML,
// or sender echoes. Verification mail routinely echoes the recipient in the
// To-line, in confirmation-link query params, and in mailto: URIs, so the
// helper matches the address form generically rather than a stored value.

const REPLACEMENT = "[redacted-address]";

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replace every occurrence of the agent's mailbox address with
 *  "[redacted-address]".
 *
 *  Matched forms, all case-insensitive:
 *   - `agentId@<domain-ish run>` — the full address under ANY domain
 *     (verification mail echoes it; the domain in storage may differ in case)
 *   - `agentId%40<domain-ish run>` — the percent-encoded form inside links
 *   - the bare `agentId@` localpart form left inside mailto:/quoted strings
 *
 *  Deliberately fail-closed: a longer localpart that merely embeds the
 *  agent's address (e.g. `x482913@d`) is still redacted from the embedded
 *  `agentId@` on — leaving it intact would put the address bytes on the
 *  wire. Over-redaction is acceptable; leakage is not.
 *
 *  `domain`, when known, adds an exact-address pattern; it never narrows the
 *  generic one and is never emitted.
 */
export function redactAddress(text: string, agentId: string, domain?: string): string {
  if (!agentId) return text;
  const id = escapeRegExp(agentId);
  let out = text.replace(new RegExp(`${id}(?:@|%40)[A-Za-z0-9._-]*`, "gi"), REPLACEMENT);
  if (domain) {
    out = out.replace(new RegExp(escapeRegExp(`${agentId}@${domain}`), "gi"), REPLACEMENT);
  }
  return out;
}
