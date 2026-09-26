import { describe, expect, it, vi } from "vitest";
import { githubApi, onboardGithubEmail, type GithubApi, type MailboxLike } from "./github-onboard.js";

describe("githubApi", () => {
  function makeFetch(routes: Record<string, { status?: number; json?: unknown }>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const r = routes[`${init.method ?? "GET"} ${url}`];
      if (!r) throw new Error(`unexpected fetch ${init.method ?? "GET"} ${url}`);
      return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
    });
    return { fn: fn as unknown as typeof globalThis.fetch, calls };
  }

  it("whoami returns the login with bearer auth", async () => {
    const { fn, calls } = makeFetch({ "GET https://api.github.com/user": { json: { login: "critical-agent-zero" } } });
    const api = githubApi("ghp_x", fn);
    expect(await api.whoami()).toBe("critical-agent-zero");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer ghp_x");
  });

  it("listEmails returns the email records", async () => {
    const { fn } = makeFetch({
      "GET https://api.github.com/user/emails": { json: [{ email: "a@b", primary: true, verified: true }] },
    });
    const api = githubApi("ghp_x", fn);
    expect(await api.listEmails()).toEqual([{ email: "a@b", primary: true, verified: true }]);
  });

  it("addEmail POSTs the email array", async () => {
    const { fn, calls } = makeFetch({ "POST https://api.github.com/user/emails": { status: 201, json: [] } });
    const api = githubApi("ghp_x", fn);
    await api.addEmail("482913@agents.example");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ emails: ["482913@agents.example"] });
  });

  it("throws with status on a non-2xx", async () => {
    const { fn } = makeFetch({ "GET https://api.github.com/user": { status: 401, json: { message: "Bad creds" } } });
    await expect(githubApi("ghp_x", fn).whoami()).rejects.toThrow(/GitHub 401/);
  });
});

describe("onboardGithubEmail", () => {
  const ADDR = "482913@agents.example";
  const verifyEmail = { id: "e1", from: '"GitHub" <noreply@github.com>', subject: "[GitHub] Please verify your email address", receivedAt: "t" };
  const link = "https://github.com/users/critical-agent-zero/emails/1/confirm_verification/abc";

  function fakeApi(over: Partial<GithubApi> & { emails?: { email: string; verified: boolean }[] } = {}): GithubApi {
    return {
      whoami: over.whoami ?? (async () => "critical-agent-zero"),
      listEmails: over.listEmails ?? (async () => (over.emails ?? []) as never),
      addEmail: over.addEmail ?? vi.fn(async () => {}),
    };
  }
  function fakeMailbox(emails: { id: string; from: string; subject: string; receivedAt: string }[], links: string[]): MailboxLike {
    return {
      listEmails: async () => ({ emails }),
      getEmail: async () => ({ links }),
    };
  }
  const fast = { sleep: async () => {}, pollMs: 1, timeoutSeconds: 1, now: (() => { let t = 0; return () => (t += 500); })() };

  it("reports already-verified and does not add", async () => {
    const addEmail = vi.fn(async () => {});
    const api = fakeApi({ emails: [{ email: ADDR, verified: true }], addEmail });
    const r = await onboardGithubEmail({ address: ADDR, api, mailbox: fakeMailbox([], []), ...fast });
    expect(r.status).toBe("already-verified");
    expect(r.login).toBe("critical-agent-zero");
    expect(addEmail).not.toHaveBeenCalled();
  });

  it("adds the email when absent, then surfaces the verification link", async () => {
    const addEmail = vi.fn(async () => {});
    const api = fakeApi({ emails: [], addEmail });
    const r = await onboardGithubEmail({
      address: ADDR, api, mailbox: fakeMailbox([verifyEmail], [link]), ...fast,
    });
    expect(addEmail).toHaveBeenCalledWith(ADDR);
    expect(r.status).toBe("pending");
    expect(r.verificationLink).toBe(link);
  });

  it("re-adds when present-but-unverified (to nudge a resend) and surfaces the link", async () => {
    const addEmail = vi.fn(async () => {});
    const api = fakeApi({ emails: [{ email: ADDR, verified: false }], addEmail });
    const r = await onboardGithubEmail({
      address: ADDR, api, mailbox: fakeMailbox([verifyEmail], [link]), ...fast,
    });
    expect(addEmail).toHaveBeenCalledWith(ADDR);
    expect(r.status).toBe("pending");
    expect(r.verificationLink).toBe(link);
  });

  it("tolerates a duplicate re-add error when present-but-unverified", async () => {
    const addEmail = vi.fn(async () => { throw new Error("GitHub 422: already exists"); });
    const api = fakeApi({ emails: [{ email: ADDR, verified: false }], addEmail });
    const r = await onboardGithubEmail({
      address: ADDR, api, mailbox: fakeMailbox([verifyEmail], [link]), ...fast,
    });
    expect(r.status).toBe("pending");
    expect(r.verificationLink).toBe(link);
  });

  it("returns no-verification-email if none arrives within the timeout", async () => {
    const api = fakeApi({ emails: [] });
    const r = await onboardGithubEmail({ address: ADDR, api, mailbox: fakeMailbox([], []), ...fast });
    expect(r.status).toBe("no-verification-email");
  });

  it("accepts mail from a github.com subdomain sender", async () => {
    const subdomainMail = { ...verifyEmail, from: "GitHub <noreply@mail.github.com>" };
    const r = await onboardGithubEmail({
      address: ADDR, api: fakeApi(), mailbox: fakeMailbox([subdomainMail], [link]), ...fast,
    });
    expect(r.status).toBe("pending");
    expect(r.verificationLink).toBe(link);
  });

  it("ignores mail whose display name says GitHub but whose address is not github.com", async () => {
    const spoof = { ...verifyEmail, from: '"GitHub" <x@evil.example>' };
    const r = await onboardGithubEmail({
      address: ADDR, api: fakeApi(), mailbox: fakeMailbox([spoof], [link]), ...fast,
    });
    expect(r.status).toBe("no-verification-email");
    expect(r.verificationLink).toBeUndefined();
  });

  it("ignores mail from a lookalike domain that merely contains github.com", async () => {
    const spoof = { ...verifyEmail, from: "noreply@github.com.evil.example" };
    const r = await onboardGithubEmail({
      address: ADDR, api: fakeApi(), mailbox: fakeMailbox([spoof], [link]), ...fast,
    });
    expect(r.status).toBe("no-verification-email");
  });

  it("rejects a confirm_verification link on a lookalike origin", async () => {
    const evil = "https://github.com.evil.example/confirm_verification/x";
    const r = await onboardGithubEmail({
      address: ADDR, api: fakeApi(), mailbox: fakeMailbox([verifyEmail], [evil]), ...fast,
    });
    expect(r.status).toBe("no-verification-email");
    expect(r.verificationLink).toBeUndefined();
  });

  it("rejects an http:// downgrade of a github.com link", async () => {
    const insecure = "http://github.com/users/critical-agent-zero/emails/1/confirm_verification/abc";
    const r = await onboardGithubEmail({
      address: ADDR, api: fakeApi(), mailbox: fakeMailbox([verifyEmail], [insecure]), ...fast,
    });
    expect(r.status).toBe("no-verification-email");
    expect(r.verificationLink).toBeUndefined();
  });

  it("rejects a github.com link carrying ANSI-escape control bytes (terminal-rewrite spoof)", async () => {
    // ESC[2K erases the line, ESC[1G returns to column 1 — a terminal renders
    // only the trailing attacker URL while new URL().origin still reports
    // https://github.com. Decoded from &#27; entities by ingest extractLinks().
    const spoofed =
      "https://github.com/users/critical-agent-zero/emails/1/confirm_verification/x\u001b[2K\u001b[1G  https://evil.example/confirm_verification/steal";
    const r = await onboardGithubEmail({
      address: ADDR, api: fakeApi(), mailbox: fakeMailbox([verifyEmail], [spoofed]), ...fast,
    });
    expect(r.status).toBe("no-verification-email");
    expect(r.verificationLink).toBeUndefined();
  });

  it("rejects github.com links carrying other C0/C1/DEL control bytes", async () => {
    const base = "https://github.com/users/critical-agent-zero/emails/1/confirm_verification/";
    for (const ctl of ["\u0000", "\u0008", "\u007f", "\u009b"]) {
      const r = await onboardGithubEmail({
        address: ADDR, api: fakeApi(), mailbox: fakeMailbox([verifyEmail], [`${base}a${ctl}b`]), ...fast,
      });
      expect(r.status).toBe("no-verification-email");
    }
  });

  it("returns the WHATWG-serialized link so the validated string is the displayed string", async () => {
    const odd = "https://github.com/users/critical-agent-zero/emails/1/confirm_verification/a b";
    const r = await onboardGithubEmail({
      address: ADDR, api: fakeApi(), mailbox: fakeMailbox([verifyEmail], [odd]), ...fast,
    });
    expect(r.status).toBe("pending");
    expect(r.verificationLink).toBe("https://github.com/users/critical-agent-zero/emails/1/confirm_verification/a%20b");
  });

  it("skips unparseable and off-origin links but returns the legit one", async () => {
    const r = await onboardGithubEmail({
      address: ADDR, api: fakeApi(), mailbox: fakeMailbox([verifyEmail], [
        "not a url with confirm_verification",
        "https://evil.example/confirm_verification/x",
        link,
      ]), ...fast,
    });
    expect(r.status).toBe("pending");
    expect(r.verificationLink).toBe(link);
  });

  it("rejects a same-origin verification link for a DIFFERENT github account", async () => {
    // Origin is exactly https://github.com but the path targets another
    // account — clicking it would verify the attacker's address, not the bot's.
    const otherAccount = "https://github.com/users/attacker/emails/1/confirm_verification/abc";
    const r = await onboardGithubEmail({
      address: ADDR, api: fakeApi(), mailbox: fakeMailbox([verifyEmail], [otherAccount]), ...fast,
    });
    expect(r.status).toBe("no-verification-email");
    expect(r.verificationLink).toBeUndefined();
  });

  it("rejects a login-prefix-extension path (/users/<login>x/emails/...)", async () => {
    const prefixExt = "https://github.com/users/critical-agent-zerox/emails/1/confirm_verification/abc";
    const r = await onboardGithubEmail({
      address: ADDR, api: fakeApi(), mailbox: fakeMailbox([verifyEmail], [prefixExt]), ...fast,
    });
    expect(r.status).toBe("no-verification-email");
    expect(r.verificationLink).toBeUndefined();
  });

  it("rejects an encoded-slash traversal that keeps the pinned prefix literal (%2f)", async () => {
    // new URL() leaves %2f opaque, so the raw path still starts with the bot's
    // /users/<login>/emails/ — but GitHub, decoding server-side, would route it
    // to /users/attacker/emails/. Refusing %2f/%2e in the path closes this.
    const encoded =
      "https://github.com/users/critical-agent-zero/emails/..%2f..%2fusers%2fattacker%2femails%2f1%2fconfirm_verification%2fx";
    const r = await onboardGithubEmail({
      address: ADDR, api: fakeApi(), mailbox: fakeMailbox([verifyEmail], [encoded]), ...fast,
    });
    expect(r.status).toBe("no-verification-email");
    expect(r.verificationLink).toBeUndefined();
  });

  it("rejects a literal dot-segment traversal (resolved by URL to another account)", async () => {
    const traversal = "https://github.com/users/critical-agent-zero/emails/../../users/attacker/emails/1/confirm_verification/x";
    const r = await onboardGithubEmail({
      address: ADDR, api: fakeApi(), mailbox: fakeMailbox([verifyEmail], [traversal]), ...fast,
    });
    expect(r.status).toBe("no-verification-email");
    expect(r.verificationLink).toBeUndefined();
  });

  it("matches the bot login case-insensitively", async () => {
    const mixedCase = "https://github.com/users/Critical-Agent-Zero/emails/1/confirm_verification/abc";
    const r = await onboardGithubEmail({
      address: ADDR, api: fakeApi({ whoami: async () => "critical-agent-zero" }),
      mailbox: fakeMailbox([verifyEmail], [mixedCase]), ...fast,
    });
    expect(r.status).toBe("pending");
    expect(r.verificationLink).toBe(mixedCase);
  });

  it("bounds the poll with a `since` and ignores mail older than the onboarding start", async () => {
    // A real epoch so the ISO `since` string is meaningful; an incrementing
    // clock so the deadline is eventually reached.
    const base = Date.parse("2026-06-01T12:00:00.000Z");
    let tick = 0;
    const now = () => base + tick++ * 500;
    let capturedSince: string | undefined;
    const staleMail = { id: "old", from: '"GitHub" <noreply@github.com>', subject: "verify", receivedAt: "2026-06-01T11:00:00.000Z" };
    const mailbox: MailboxLike = {
      listEmails: async (opts) => {
        capturedSince = opts?.since;
        return { emails: [staleMail].filter((e) => !opts?.since || e.receivedAt >= opts.since) };
      },
      getEmail: async () => ({ links: [link] }),
    };
    const r = await onboardGithubEmail({
      address: ADDR, api: fakeApi(), mailbox, sleep: async () => {}, pollMs: 1, timeoutSeconds: 1, now,
    });
    // NB: production filters `since` as a numeric epoch (Date.parse) server-side
    // (packages/api/src/db/emails.ts); this fake does an ISO string compare,
    // which is equivalent here only because the timestamps are same-format UTC.
    expect(capturedSince).toBe("2026-06-01T11:55:00.000Z"); // start (12:00) minus the 5-min guard
    expect(r.status).toBe("no-verification-email"); // the 11:00 stale mail is excluded
  });

  it("finds a verification mail that arrived after the onboarding start", async () => {
    const base = Date.parse("2026-06-01T12:00:00.000Z");
    let tick = 0;
    const now = () => base + tick++ * 500;
    const freshMail = { id: "new", from: '"GitHub" <noreply@github.com>', subject: "verify", receivedAt: "2026-06-01T12:00:05.000Z" };
    const mailbox: MailboxLike = {
      listEmails: async (opts) => ({ emails: [freshMail].filter((e) => !opts?.since || e.receivedAt >= opts.since) }),
      getEmail: async () => ({ links: [link] }),
    };
    const r = await onboardGithubEmail({
      address: ADDR, api: fakeApi(), mailbox, sleep: async () => {}, pollMs: 1, timeoutSeconds: 5, now,
    });
    expect(r.status).toBe("pending");
    expect(r.verificationLink).toBe(link);
  });
});
