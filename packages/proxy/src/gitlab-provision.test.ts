import { describe, expect, it, vi } from "vitest";
import { GitlabProvisioner } from "./gitlab-provision.js";

const actor = { name: "482913", email: "482913@agents.example" };
const G = "https://gitlab.com/api/v4/groups/42";

function makeFetch(routes: Record<string, { status?: number; json?: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const key = `${init.method ?? "GET"} ${url}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected fetch: ${key}`);
    return new Response(JSON.stringify(route.json ?? {}), { status: route.status ?? 200 });
  });
  return { fn: fn as unknown as typeof globalThis.fetch, calls };
}

function makeDeps(fetchFn: typeof globalThis.fetch) {
  const put = vi.fn(async () => {});
  const provisioner = new GitlabProvisioner({
    config: { adminToken: async () => "owner-tok", groupId: async () => "42" },
    sink: { put },
    fetch: fetchFn,
    now: () => Date.parse("2026-08-24T00:00:00Z"),
  });
  return { provisioner, put };
}

describe("GitlabProvisioner", () => {
  it("creates account, adds membership, mints PAT, stores it", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${G}/service_accounts`]: { json: [] },
      [`POST ${G}/service_accounts`]: {
        json: { id: 777, username: "agent-482913", email: "482913@agents.example" },
      },
      [`POST ${G}/members`]: { json: {} },
      [`POST ${G}/service_accounts/777/personal_access_tokens`]: { json: { token: "glpat-new" } },
    });
    const { provisioner, put } = makeDeps(fn);
    const result = await provisioner.provision(actor);
    expect(result).toEqual({ username: "agent-482913", email: "482913@agents.example" });
    expect(put).toHaveBeenCalledWith("gitlab", "482913", "glpat-new");
    const create = calls.find((c) => c.url === `${G}/service_accounts` && c.init.method === "POST")!;
    expect(JSON.parse(create.init.body as string)).toEqual({
      name: "agent 482913", username: "agent-482913", email: "482913@agents.example",
    });
    const member = calls.find((c) => c.url === `${G}/members`)!;
    expect(JSON.parse(member.init.body as string)).toEqual({ user_id: 777, access_level: 30 });
    const pat = calls.find((c) => c.url.endsWith("/personal_access_tokens"))!;
    expect(JSON.parse(pat.init.body as string)).toEqual({
      name: "agent-identity-proxy", scopes: ["api"], expires_at: "2027-08-24",
    });
    const h = new Headers(create.init.headers);
    expect(h.get("PRIVATE-TOKEN")).toBe("owner-tok");
  });

  it("is idempotent: reuses an existing account and tolerates existing membership", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${G}/service_accounts`]: {
        json: [{ id: 777, username: "agent-482913", email: "482913@agents.example" }],
      },
      [`POST ${G}/members`]: { status: 409, json: { message: "Member already exists" } },
      [`POST ${G}/service_accounts/777/personal_access_tokens`]: { json: { token: "glpat-2" } },
    });
    const { provisioner, put } = makeDeps(fn);
    const result = await provisioner.provision(actor);
    expect(result.username).toBe("agent-482913");
    expect(put).toHaveBeenCalledWith("gitlab", "482913", "glpat-2");
    expect(calls.some((c) => c.url === `${G}/service_accounts` && c.init.method === "POST")).toBe(false);
  });

  it("surfaces owner-token rejection as upstream_auth", async () => {
    const { fn } = makeFetch({
      [`GET ${G}/service_accounts`]: { status: 401, json: { message: "401" } },
    });
    const { provisioner } = makeDeps(fn);
    await expect(provisioner.provision(actor)).rejects.toMatchObject({ kind: "upstream_auth" });
  });
});
