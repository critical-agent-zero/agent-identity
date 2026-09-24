// Named operator mailboxes (issue #114): a receive-only identity whose
// local-part is an operator-chosen slug, guarded by a strict sender allowlist
// and an authentication requirement. Because an always-live orchestration
// agent ACTS on this mail, the delivery gate is the security boundary — every
// helper here fails closed.
import { matchesSenderDomain, senderAddress } from "./mail.js";

// A mailbox slug: starts with a letter, then 1-30 more of [a-z0-9-] (total
// 2-31). The leading-letter rule alone already excludes a 6-digit numeric
// pool agentId, but the numeric collision is rejected explicitly too so the
// intent survives any future loosening of the pattern.
export const MAILBOX_SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;

export function isValidMailboxSlug(name: string): boolean {
  if (!MAILBOX_SLUG_RE.test(name)) return false;
  // Never a 6-digit numeric: it would collide with a pool agentId.
  if (/^\d{6}$/.test(name)) return false;
  return true;
}

// Why a delivered mailbox message was dropped to quarantine instead. Carried
// (with the sender domain alone) on the attested email_rejected event — never
// the subject, body, or full address.
export type MailboxRejectReason = "not_allowlisted" | "auth_failed";

/** A mailbox allowlist entry is either an exact address (`alerts@github.com`)
 *  or a `*@domain` pattern. Domain patterns match on a label boundary via the
 *  hardened senderDomain (so `*@github.com` covers `mail.github.com` but never
 *  `evil-github.com`); exact addresses match the hardened full address-part
 *  (so a spoofed display name or an appended second mailbox never counts).
 *  Both fail closed on a multi-mailbox / lookalike From. */
export function matchesMailboxAllowlist(from: string, allowlist: string[]): boolean {
  for (const raw of allowlist) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith("*@")) {
      const domain = entry.slice(2);
      if (domain && matchesSenderDomain(from, domain)) return true;
    } else if (entry.includes("@")) {
      const addr = senderAddress(from);
      if (addr !== undefined && addr === entry) return true;
    }
  }
  return false;
}
