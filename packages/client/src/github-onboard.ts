// GitHub email onboarding for the single-account attribution model: add an
// agent's mailbox address as a verified email on the shared bot account so its
// forced-author commits link to that account. This is an operator/onboarding
// action — it uses the bot account's PAT (user scope), never exposed to agents.

export interface GithubEmail {
  email: string;
  primary?: boolean;
  verified: boolean;
  visibility?: string | null;
}

export interface GithubApi {
  whoami(): Promise<string>;
  listEmails(): Promise<GithubEmail[]>;
  addEmail(email: string): Promise<void>;
}

export function githubApi(pat: string, fetchFn: typeof globalThis.fetch = globalThis.fetch): GithubApi {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetchFn(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${pat}`,
        accept: "application/vnd.github+json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  };
  return {
    async whoami() { return (await call<{ login: string }>("GET", "/user")).login; },
    listEmails() { return call<GithubEmail[]>("GET", "/user/emails"); },
    async addEmail(email) { await call("POST", "/user/emails", { emails: [email] }); },
  };
}

export interface MailboxLike {
  listEmails(opts?: { since?: string; limit?: number }): Promise<{
    emails: { id: string; from: string; subject: string; receivedAt: string }[];
  }>;
  getEmail(id: string): Promise<{ links?: string[] }>;
}

export type OnboardStatus = "already-verified" | "pending" | "no-verification-email";

export interface OnboardResult {
  address: string;
  login: string;
  status: OnboardStatus;
  verificationLink?: string;
}

export interface OnboardDeps {
  address: string;
  api: GithubApi;
  mailbox: MailboxLike;
  timeoutSeconds?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Backward guard on the poll's `since`: only mail that arrived for THIS
// onboarding attempt should count, but the mailbox's receivedAt (server clock)
// and this process's clock can differ. This bounds staleness (the excluded
// mail is a prior verification for the SAME address on the SAME account, so
// re-using it is a freshness bug, not a cross-account risk) — so the guard is
// deliberately generous, favouring "never wrongly exclude the real mail under
// clock skew" over tightness. Five minutes covers realistic operator↔ingest
// skew while still excluding genuinely old stale mail.
const SINCE_GUARD_MS = 300_000;

// Sender authenticity: the display name is attacker-controlled, so only the
// domain of the address part counts. github.com and its subdomains are
// accepted (GitHub sends from noreply@github.com today; a mail subdomain like
// mail.github.com stays under GitHub's DNS control, so it is equally trusted).
function isGithubSender(from: string): boolean {
  const angled = /<([^<>]*)>\\s*$/.exec(from);
  const addr = (angled ? angled[1]! : from).trim();
  const at = addr.lastIndexOf("@");
  if (at < 0) return false;
  const domain = addr.slice(at + 1).toLowerCase();
  return domain === "github.com" || domain.endsWith(".github.com");
}

// Link authenticity: the operator opens this link signed in as the bot
// account, so it must (a) parse, (b) have origin exactly https://github.com —
// no lookalike hosts, no http downgrade — and (c) sit under the bot account's
// own /users/<login>/emails/ path. The path pin is the key defence: a
// same-origin verification link for a DIFFERENT account
// (https://github.com/users/<attacker>/emails/.../confirm_verification/...)
// passes the origin check but would verify the attacker's address on click —
// pinning to the resolved bot login rejects it. Raw C0/C1/DEL bytes are
// rejected outright: new URL() accepts them in a path while still reporting the
// github.com origin, but printed to a terminal they are ANSI escapes that can
// rewrite the displayed line into an attacker URL (ingest decodes &#27;
// entities into real ESC bytes). No legitimate GitHub link carries them.
function isGithubVerificationLink(link: string, login: string): boolean {
  if (!link.includes("confirm_verification")) return false;
  if (/[\\u0000-\\u001f\\u007f-\\u009f]/.test(link)) return false;
  try {
    const url = new URL(link);
    if (url.origin !== "https://github.com") return false;
    // Reject percent-encoded path separators/dots. new URL() resolves LITERAL
    // dot-segments but leaves %2f/%2e opaque, so a
    // "…/emails/..%2f..%2fusers%2fattacker%2f…" link keeps the pinned prefix as
    // literal text while GitHub, decoding server-side, could route it to
    // another account's /emails/ path. No legitimate verification link carries
    // encoded separators, so refusing them closes that traversal class.
    if (/%2[ef]/i.test(url.pathname)) return false;
    // Exact segment match on the resolved path — /users/<login>/emails/… —
    // not a prefix test: the login segment must equal the bot login exactly
    // (case-insensitive; GitHub logins are case-insensitive), so neither a
    // different account (/users/<attacker>/…) nor a prefix extension
    // (/users/<login>x/…) nor an empty login can satisfy it.
    const seg = url.pathname.split("/"); // ["", "users", "<login>", "emails", …]
    return seg[1] === "users" && seg[2]?.toLowerCase() === login.toLowerCase() && seg[3] === "emails";
  } catch {
    return false;
  }
}

/** Add the address to the bot account (if needed) and return the pending
 *  verification link from the agent's mailbox. The verification click itself is
 *  deliberately NOT automated here — it must be completed in a browser signed
 *  in as the bot account (see the onboarding-session guidance in the skill). */
export async function onboardGithubEmail(deps: OnboardDeps): Promise<OnboardResult> {
  const sleep = deps.sleep ?? sleepDefault;
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 5000;
  const timeoutMs = (deps.timeoutSeconds ?? 120) * 1000;
  // Bound the poll to mail that arrived for THIS attempt: capture the start
  // BEFORE addEmail triggers the fresh verification mail, so a stale link left
  // in the mailbox by a previous onboard of the same address can't satisfy this
  // run (see SINCE_GUARD_MS for the skew tolerance).
  const since = new Date(now() - SINCE_GUARD_MS).toISOString();

  const login = await deps.api.whoami();
  const addrLc = deps.address.toLowerCase();
  const existing = (await deps.api.listEmails()).find((e) => e.email.toLowerCase() === addrLc);
  if (existing?.verified) return { address: deps.address, login, status: "already-verified" };
  // Add when absent; re-add when present-but-unverified to nudge a fresh
  // verification email (GitHub sends one on add). A duplicate re-add may error
  // — tolerate it and fall through to poll for any existing verification mail.
  if (!existing) {
    await deps.api.addEmail(deps.address);
  } else {
    try { await deps.api.addEmail(deps.address); } catch { /* already present */ }
  }

  const deadline = now() + timeoutMs;
  for (;;) {
    const { emails } = await deps.mailbox.listEmails({ since, limit: 20 });
    const vmail = emails.find((e) => isGithubSender(e.from) && /verif/i.test(e.subject));
    if (vmail) {
      const full = await deps.mailbox.getEmail(vmail.id);
      // GitHub's verification links carry a /confirm_verification/ path segment
      // and must sit under this bot login's /users/<login>/emails/ path;
      // format-dependent, so a change here degrades to no-verification-email.
      const link = (full.links ?? []).find((l) => isGithubVerificationLink(l, login));
      // Return the WHATWG-serialized form (percent-encodes anything unusual)
      // so the string callers display is exactly the string that was validated.
      if (link) return { address: deps.address, login, status: "pending", verificationLink: new URL(link).href };
    }
    if (now() >= deadline) return { address: deps.address, login, status: "no-verification-email" };
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}
