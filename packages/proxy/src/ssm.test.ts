import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SsmCredentialStore } from "./ssm.js";

/** fake ssm: routes GetParameter by Name; missing names reject like the SDK. */
function makeSsm(params: Record<string, string>) {
  const send = vi.fn(async (cmd: { input: { Name?: string } }) => {
    const name = cmd.input.Name!;
    if (name in params) return { Parameter: { Value: params[name] } };
    const err = new Error("ParameterNotFound");
    err.name = "ParameterNotFound";
    throw err;
  });
  return send;
}

describe("SsmCredentialStore.resolve", () => {
  it("prefers the per-identity parameter", async () => {
    const send = makeSsm({
      "/agent-identity/forge/gitlab/pat/482913": "identity-tok",
      "/agent-identity/forge/gitlab/pat": "shared-tok",
    });
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never);
    expect(await store.resolve("gitlab", "482913")).toBe("identity-tok");
  });

  it("falls back to the shared parameter", async () => {
    const send = makeSsm({ "/agent-identity/forge/github/pat": "shared-tok" });
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never);
    expect(await store.resolve("github", "482913")).toBe("shared-tok");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("throws not_provisioned when neither exists", async () => {
    const send = makeSsm({});
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never);
    await expect(store.resolve("gitlab", "482913"))
      .rejects.toMatchObject({ kind: "not_provisioned" });
  });

  it("caches within the TTL and refetches after it", async () => {
    const send = makeSsm({ "/agent-identity/forge/github/pat/482913": "tok" });
    let now = 1_000;
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never, () => now);
    await store.resolve("github", "482913");
    now += 60_000;
    await store.resolve("github", "482913");
    expect(send).toHaveBeenCalledTimes(1);
    now += 300_001;
    await store.resolve("github", "482913");
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("SsmCredentialStore.put and getParam", () => {
  it("puts a per-identity SecureString with overwrite", async () => {
    const send = vi.fn(async (_cmd: unknown) => ({}));
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never);
    await store.put("gitlab", "482913", "newtok");
    const cmd = send.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(cmd.input).toEqual({
      Name: "/agent-identity/forge/gitlab/pat/482913",
      Value: "newtok", Type: "SecureString", Overwrite: true,
    });
  });

  it("getParam reads an arbitrary decrypted parameter", async () => {
    const send = makeSsm({ "/agent-identity/forge/gitlab/admin-token": "admintok" });
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never);
    expect(await store.getParam("/agent-identity/forge/gitlab/admin-token")).toBe("admintok");
  });

  it("has() reports whether a per-identity credential exists", async () => {
    const send = makeSsm({ "/agent-identity/forge/gitlab/pat/482913": "tok" });
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never);
    expect(await store.has("gitlab", "482913")).toBe(true);
    expect(await store.has("gitlab", "999999")).toBe(false);
  });
});

describe("SsmCredentialStore.resolveCommitToken (GitHub App signing, issue #120)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const appParams = {
    "/agent-identity/forge/github/app-id": "123456",
    "/agent-identity/forge/github/installation-id": "789",
    "/agent-identity/forge/github/app-private-key": pem,
  };

  // A fetch fake for the installation-token exchange. Returns {token,
  // expires_at} and records the Bearer JWT it was called with.
  function tokenExchange(token: string, expiresAt: string) {
    const seen: { url: string; jwt: string }[] = [];
    const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
      const jwt = new Headers(init.headers).get("authorization")!.replace(/^Bearer /, "");
      seen.push({ url, jwt });
      return new Response(JSON.stringify({ token, expires_at: expiresAt }), { status: 200 });
    });
    return { fn: fn as unknown as typeof globalThis.fetch, spy: fn, seen };
  }

  const future = () => new Date(Date.now() + 3_600_000).toISOString();

  it("falls back to the PAT when NO app params are configured (unsigned, as before)", async () => {
    const send = makeSsm({ "/agent-identity/forge/github/pat": "pat-tok" });
    const ex = tokenExchange("inst-tok", future());
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never, Date.now, ex.fn);
    expect(await store.resolveCommitToken("github", "482913")).toBe("pat-tok");
    expect(ex.spy).not.toHaveBeenCalled();
  });

  it("mints an installation token when the app IS configured", async () => {
    const send = makeSsm(appParams);
    const ex = tokenExchange("inst-tok", future());
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never, Date.now, ex.fn);
    expect(await store.resolveCommitToken("github", "482913")).toBe("inst-tok");
    expect(ex.seen[0]!.url).toBe(
      "https://api.github.com/app/installations/789/access_tokens");
  });

  it("builds a well-formed RS256 App JWT verifiable with the app's public key", async () => {
    const send = makeSsm(appParams);
    const ex = tokenExchange("inst-tok", future());
    const nowMs = 1_700_000_000_000;
    const store = new SsmCredentialStore(
      "/agent-identity/forge", { send } as never, () => nowMs, ex.fn);
    await store.resolveCommitToken("github", "482913");

    const [h64, p64, s64] = ex.seen[0]!.jwt.split(".");
    const header = JSON.parse(Buffer.from(h64!, "base64url").toString());
    const payload = JSON.parse(Buffer.from(p64!, "base64url").toString());
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    const nowSec = Math.floor(nowMs / 1000);
    expect(payload.iss).toBe("123456");
    expect(payload.iat).toBe(nowSec - 60);
    expect(payload.exp).toBe(nowSec + 540);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600); // <=10min, GitHub's cap

    const ok = cryptoVerify(
      "RSA-SHA256", Buffer.from(`${h64}.${p64}`),
      publicKey, Buffer.from(s64!, "base64url"));
    expect(ok).toBe(true);
  });

  it("caches the token within its TTL and refreshes ~1min before expiry", async () => {
    const send = makeSsm(appParams);
    let now = 1_000_000;
    // expires 1h out; store must refresh at expiry-60s.
    const ex = tokenExchange("inst-tok", new Date(now + 3_600_000).toISOString());
    const store = new SsmCredentialStore(
      "/agent-identity/forge", { send } as never, () => now, ex.fn);
    await store.resolveCommitToken("github", "482913");
    now += 3_600_000 - 120_000; // still >60s before expiry
    await store.resolveCommitToken("github", "482913");
    expect(ex.spy).toHaveBeenCalledTimes(1); // cached, no re-exchange
    now += 90_000; // now inside the 60s pre-expiry skew window
    await store.resolveCommitToken("github", "482913");
    expect(ex.spy).toHaveBeenCalledTimes(2); // refreshed
  });

  it("FAILS CLOSED when the app is only partially configured (no silent unsigned fallback)", async () => {
    const send = makeSsm({
      "/agent-identity/forge/github/app-id": "123456",
      // installation-id + private key MISSING
      "/agent-identity/forge/github/pat": "pat-tok",
    });
    const ex = tokenExchange("inst-tok", future());
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never, Date.now, ex.fn);
    await expect(store.resolveCommitToken("github", "482913"))
      .rejects.toMatchObject({ kind: "upstream_auth" });
    expect(ex.spy).not.toHaveBeenCalled();
  });

  it("non-github services always use the PAT path", async () => {
    const send = makeSsm({ "/agent-identity/forge/gitlab/pat/482913": "gl-tok" });
    const ex = tokenExchange("inst-tok", future());
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never, Date.now, ex.fn);
    expect(await store.resolveCommitToken("gitlab", "482913")).toBe("gl-tok");
    expect(ex.spy).not.toHaveBeenCalled();
  });

  it("never leaks the private key, JWT, or token in a thrown error message", async () => {
    // Exchange rejects → the store must throw without echoing any secret.
    const send = makeSsm(appParams);
    const fn = vi.fn(async () =>
      new Response(JSON.stringify({ message: "bad" }), { status: 401 }));
    const store = new SsmCredentialStore(
      "/agent-identity/forge", { send } as never, Date.now, fn as never);
    let thrown: unknown;
    try {
      await store.resolveCommitToken("github", "482913");
    } catch (e) {
      thrown = e;
    }
    const msg = String((thrown as Error).message) + String((thrown as Error).stack ?? "");
    expect(msg).not.toContain("BEGIN PRIVATE KEY");
    expect(msg).not.toContain(pem.slice(40, 120));
    // no JWT segment (three base64url parts) leaked
    expect(msg).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);
  });
});
