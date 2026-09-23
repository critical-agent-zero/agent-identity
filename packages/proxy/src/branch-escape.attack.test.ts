import type { AgentRecord } from "@agent-identity/api";
import { canonicalString, generateKeypair, sign } from "@agent-identity/shared";
import { describe, expect, it, vi } from "vitest";
import { createProxyApp, type ProxyDeps } from "./app.js";
import type { CredentialStore } from "./forge.js";
import { GithubForge } from "./github.js";
import { forkNamespacePolicy } from "./policy.js";

// PR #94 review: forkNamespacePolicy pins only op.owner, and the GitHub
// adapter interpolates repo and branch into URL PATHS unencoded — real fetch
// normalizes ".." via the WHATWG URL parser, so a crafted repo or branch can
// re-target writes (including the auto-created ref) into the SOURCE repo
// while the policy still sees the allowed fork owner.

const kp = generateKeypair();

function signed(method: string, path: string, body = "") {
  const timestamp = new Date().toISOString();
  return {
    method,
    body: body || undefined,
    headers: {
      "x-agent-key": kp.publicKeySpkiBase64,
      "x-agent-timestamp": timestamp,
      "x-agent-signature": sign(canonicalString(method, path, timestamp, body), kp.privateKeyPem),
      ...(body ? { "content-type": "application/json" } : {}),
    },
  };
}

const agent: AgentRecord = {
  agentId: "482913", address: "482913@agents.example", publicKey: kp.publicKeySpkiBase64,
  status: "active", createdAt: "t", capabilities: ["github"],
};

const credentials: CredentialStore = { resolve: async () => "tok123" };
const actor = { name: "482913", email: "482913@agents.example" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** GitHub simulator that behaves like real fetch: the WHATWG URL parser
 *  normalizes dot segments BEFORE the request leaves the process, so calls
 *  are recorded and routed by their normalized URL — exactly the URL GitHub
 *  would receive. Any non-GET is a write. */
function githubNet() {
  const calls: string[] = [];
  const writes: string[] = [];
  const fn = vi.fn(async (rawUrl: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const url = new URL(rawUrl);
    calls.push(`${method} ${url.toString()}`);
    if (method !== "GET") writes.push(`${method} ${url.toString()}`);
    const path = url.pathname;
    if (method === "GET" && path.includes("/git/ref/heads/")) {
      // the attacker-chosen branch is missing (auto-create fires); default heads exist
      return path.endsWith("/main")
        ? json({ object: { sha: "srchead" } })
        : json({ message: "Not Found" }, 404);
    }
    if (method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(path)) return json({ default_branch: "main" });
    if (method === "GET" && path.includes("/git/commits/")) return json({ tree: { sha: "t0" } });
    if (method === "POST" && path.endsWith("/git/refs")) return json({ ref: "r" }, 201);
    if (method === "POST" && path.endsWith("/git/trees")) return json({ sha: "t1" });
    if (method === "POST" && path.endsWith("/git/commits"))
      return json({ sha: "c1", html_url: "https://github.com/x/c1" });
    if (method === "PATCH") return json({});
    return json({ message: "Not Found" }, 404);
  });
  return { fn: fn as unknown as typeof globalThis.fetch, calls, writes };
}

// Real adapter + real policy, wired exactly as lambda.ts wires them.
function makeApp(fetchFn: typeof globalThis.fetch) {
  const deps: ProxyDeps = {
    agents: { getByFingerprint: vi.fn(async () => agent) } as never,
    nonces: { recordOnce: async () => true } as never,
    forges: { github: new GithubForge({ credentials, fetch: fetchFn }) },
    policy: forkNamespacePolicy({ githubForkOwner: "fork-acct" }),
    audit: vi.fn(),
  };
  return createProxyApp(deps);
}

const commit = (body: Record<string, unknown>) => JSON.stringify({
  message: "m", files: [{ path: "f", content: "x" }], ...body,
});

describe("fork-namespace pin vs path traversal (PR #94 review)", () => {
  it("400s a commit whose repo dot-segments out of the fork namespace, with no upstream request", async () => {
    const net = githubNet();
    const app = makeApp(net.fn);
    const path = "/forge/github/commit";
    // owner passes the policy; the repo rewrites the effective target to the
    // source repo, where the auto-create would POST /git/refs
    const body = commit({
      owner: "fork-acct",
      repo: "proxy-target/../../critical-labs/agent-identity",
      branch: "attacker-branch",
    });
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
    expect(net.fn).not.toHaveBeenCalled();
    expect(net.writes).toEqual([]);
  });

  it("400s a commit whose branch dot-segments onto the source repo's main, with no upstream request", async () => {
    const net = githubNet();
    const app = makeApp(net.fn);
    const path = "/forge/github/commit";
    // the unencoded branch normalizes GET/PATCH ref URLs into the source repo
    const body = commit({
      owner: "fork-acct",
      repo: "proxy-target",
      branch: "../../../../../critical-labs/agent-identity/git/refs/heads/main",
    });
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
    expect(net.fn).not.toHaveBeenCalled();
    expect(net.writes).toEqual([]);
  });
});

describe("GithubForge path pinning (defense in depth below app validation)", () => {
  const spec = { branch: "b", message: "m", files: [{ path: "f", content: "x" }] };

  it("rejects a multi-segment repo before any request", async () => {
    const net = githubNet();
    const forge = new GithubForge({ credentials, fetch: net.fn });
    await expect(forge.createCommit(
      { owner: "fork-acct", name: "proxy-target/../../critical-labs/agent-identity" }, spec, actor,
    )).rejects.toMatchObject({ kind: "invalid" });
    expect(net.fn).not.toHaveBeenCalled();
  });

  it("rejects a multi-segment owner before any request", async () => {
    const net = githubNet();
    const forge = new GithubForge({ credentials, fetch: net.fn });
    await expect(forge.getRepo(
      { owner: "fork-acct/../critical-labs", name: "agent-identity" }, actor,
    )).rejects.toMatchObject({ kind: "invalid" });
    expect(net.fn).not.toHaveBeenCalled();
  });

  it("keeps every request inside the target repo when the branch carries dot segments", async () => {
    const net = githubNet();
    const forge = new GithubForge({ credentials, fetch: net.fn });
    await forge.createCommit(
      { owner: "fork-acct", name: "proxy-target" },
      { ...spec, branch: "../../../../../critical-labs/agent-identity/git/refs/heads/main" },
      actor,
    ).catch(() => undefined); // acceptance is not the point — containment is
    expect(net.calls.length).toBeGreaterThan(0);
    expect(net.calls.every((c) =>
      /^[A-Z]+ https:\/\/api\.github\.com\/repos\/fork-acct\/proxy-target(\/|$)/.test(c))).toBe(true);
  });
});
