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
});
