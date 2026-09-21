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

/** Add the address to the bot account (if needed) and return the pending
 *  verification link from the agent's mailbox. The verification click itself is
 *  deliberately NOT automated here — it must be completed in a browser signed
 *  in as the bot account (see the onboarding-session guidance in the skill). */
export async function onboardGithubEmail(deps: OnboardDeps): Promise<OnboardResult> {
  const sleep = deps.sleep ?? sleepDefault;
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 5000;
  const timeoutMs = (deps.timeoutSeconds ?? 120) * 1000;

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
    const { emails } = await deps.mailbox.listEmails({ limit: 20 });
    const vmail = emails.find((e) => e.from.toLowerCase().includes("github") && /verif/i.test(e.subject));
    if (vmail) {
      const full = await deps.mailbox.getEmail(vmail.id);
      // GitHub's verification links carry a /confirm_verification/ path segment;
      // format-dependent, so a change here degrades to no-verification-email.
      const link = (full.links ?? []).find((l) => l.includes("confirm_verification"));
      if (link) return { address: deps.address, login, status: "pending", verificationLink: link };
    }
    if (now() >= deadline) return { address: deps.address, login, status: "no-verification-email" };
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}
