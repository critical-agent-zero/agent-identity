import { canonicalString, generateKeypair, sign } from "@agent-identity/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp, type Deps } from "./app.js";
import { InvalidCursorError } from "./db/emails.js";
import type { NoncesRepo } from "./db/nonces.js";

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

const agent = { agentId: "482913", address: "482913@d", status: "active" as const, publicKey: kp.publicKeySpkiBase64, createdAt: "t" };

const permissiveNonces: NoncesRepo = { recordOnce: async () => true } as never;

function makeDeps(overrides: Record<string, unknown> = {}): Deps {
  return {
    agents: {
      getByFingerprint: vi.fn(async () => agent),
      register: vi.fn(async () => ({ agentId: "482913", address: "482913@d" })),
      verifyFleetKey: vi.fn(async () => true),
      verifyAdminKey: vi.fn(async (k: string) => k === "adm-good"),
      addCapability: vi.fn(async () => ["github"]),
      removeCapability: vi.fn(async () => []),
      ...overrides,
    } as never,
    emails: {
      listEmails: vi.fn(async () => ({ emails: [] })),
      getEmail: vi.fn(async () => undefined),
      ...overrides,
    } as never,
    nonces: permissiveNonces,
    readBody: vi.fn(async () => ({ text: "overflow", html: undefined, links: [] })),
    fleetKeyRequired: true,
  };
}

describe("app", () => {
  it("POST /register verifies fleet key and registers", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const req = signed("POST", "/register");
    const res = await app.request("/register", {
      ...req, headers: { ...req.headers, "x-fleet-key": "fk" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agentId: "482913", address: "482913@d" });
  });

  it("POST /register without fleet key is 403", async () => {
    const deps = makeDeps({ verifyFleetKey: vi.fn(async () => false) as never });
    const app = createApp(deps);
    const res = await app.request("/register", signed("POST", "/register"));
    expect(res.status).toBe(403);
  });

  it("GET /me returns caller identity", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/me", signed("GET", "/me"));
    expect(await res.json()).toEqual({ agentId: "482913", address: "482913@d", capabilities: [] });
  });

  it("GET /me returns capabilities (empty when untagged)", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/me", signed("GET", "/me"));
    expect(await res.json()).toEqual({ agentId: "482913", address: "482913@d", capabilities: [] });
  });

  it("GET /me returns capabilities when the record is tagged", async () => {
    const deps = makeDeps({
      getByFingerprint: vi.fn(async () => ({ ...agent, capabilities: ["github"] })) as never,
    });
    const app = createApp(deps);
    const res = await app.request("/me", signed("GET", "/me"));
    expect(await res.json()).toEqual(
      expect.objectContaining({ capabilities: ["github"] }),
    );
  });

  it("GET /emails passes since/limit and scopes to caller", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const path = "/emails?since=2026-07-01T00%3A00%3A00Z&limit=5";
    const res = await app.request(path, signed("GET", path));
    expect(res.status).toBe(200);
    expect(deps.emails.listEmails).toHaveBeenCalledWith("482913", {
      since: "2026-07-01T00:00:00Z", limit: 5, cursor: undefined,
      includeUnsolicited: false, includeUnauthenticated: false,
    });
  });

  it("GET /emails opts into unsolicited and unauthenticated mail via query params", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const path = "/emails?includeUnsolicited=true&includeUnauthenticated=true";
    const res = await app.request(path, signed("GET", path));
    expect(res.status).toBe(200);
    expect(deps.emails.listEmails).toHaveBeenCalledWith("482913",
      expect.objectContaining({ includeUnsolicited: true, includeUnauthenticated: true }));
  });

  it("GET /emails returns 400 for a malformed cursor", async () => {
    const deps = makeDeps({
      listEmails: vi.fn(async () => { throw new InvalidCursorError("malformed cursor"); }) as never,
    });
    const app = createApp(deps);
    const path = "/emails?cursor=notacursor";
    const res = await app.request(path, signed("GET", path));
    expect(res.status).toBe(400);
  });

  it("GET /emails/:id 404s on missing/foreign email", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/emails/01ABC", signed("GET", "/emails/01ABC"));
    expect(res.status).toBe(404);
  });

  it("GET /emails/:id surfaces auth verdicts read-only", async () => {
    const deps = makeDeps({
      getEmail: vi.fn(async () => ({
        id: "01ABC", from: "a", subject: "s", receivedAt: "t",
        text: "hi", links: [], auth: { spf: "FAIL", dkim: "PASS", dmarc: "GRAY" },
      })) as never,
    });
    const app = createApp(deps);
    const res = await app.request("/emails/01ABC", signed("GET", "/emails/01ABC"));
    const body = await res.json();
    expect(body.auth).toEqual({ spf: "FAIL", dkim: "PASS", dmarc: "GRAY" });
  });

  it("GET /emails/:id omits auth for records stored before verdict capture", async () => {
    const deps = makeDeps({
      getEmail: vi.fn(async () => ({
        id: "01ABC", from: "a", subject: "s", receivedAt: "t", text: "hi", links: [],
      })) as never,
    });
    const app = createApp(deps);
    const res = await app.request("/emails/01ABC", signed("GET", "/emails/01ABC"));
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("auth");
  });

  it("GET /emails/:id reads through bodyS3Key overflow", async () => {
    const deps = makeDeps({
      getEmail: vi.fn(async () => ({
        id: "01ABC", from: "a", subject: "s", receivedAt: "t",
        text: "", links: [], bodyS3Key: "bodies/482913/01ABC.json",
      })) as never,
    });
    const app = createApp(deps);
    const res = await app.request("/emails/01ABC", signed("GET", "/emails/01ABC"));
    const body = await res.json();
    expect(body.text).toBe("overflow");
    expect(deps.readBody).toHaveBeenCalledWith("bodies/482913/01ABC.json");
  });
});

describe("admin capability routes", () => {
  const grantPath = "/admin/agents/482913/capabilities";
  const grant = (headers: Record<string, string>, body = JSON.stringify({ capability: "github" })) => ({
    method: "POST", body, headers: { "content-type": "application/json", ...headers },
  });

  it("POST grants a capability with a valid admin key", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const res = await app.request(grantPath, grant({ "x-admin-key": "adm-good" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agentId: "482913", capabilities: ["github"] });
    expect((deps.agents as never as { addCapability: unknown }).addCapability)
      .toHaveBeenCalledWith("482913", "github");
  });

  it("DELETE removes a capability with a valid admin key", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const res = await app.request(`${grantPath}/github`, {
      method: "DELETE", headers: { "x-admin-key": "adm-good" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agentId: "482913", capabilities: [] });
    expect((deps.agents as never as { removeCapability: unknown }).removeCapability)
      .toHaveBeenCalledWith("482913", "github");
  });

  it("missing admin key is 403 without consulting key verification", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const res = await app.request(grantPath, grant({}));
    expect(res.status).toBe(403);
    const a = deps.agents as never as { verifyAdminKey: ReturnType<typeof vi.fn>; addCapability: ReturnType<typeof vi.fn> };
    expect(a.verifyAdminKey).not.toHaveBeenCalled();
    expect(a.addCapability).not.toHaveBeenCalled();
  });

  it("invalid admin key is 403 with a body identical to the missing-key case", async () => {
    const app = createApp(makeDeps());
    const missing = await app.request(grantPath, grant({}));
    const invalid = await app.request(grantPath, grant({ "x-admin-key": "adm-wrong" }));
    expect(invalid.status).toBe(403);
    expect(await invalid.text()).toBe(await missing.text());
  });

  it("the fleet key is not accepted via x-fleet-key", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const res = await app.request(grantPath, grant({ "x-fleet-key": "fk" }));
    expect(res.status).toBe(403);
    const a = deps.agents as never as { verifyFleetKey: ReturnType<typeof vi.fn>; addCapability: ReturnType<typeof vi.fn> };
    expect(a.verifyFleetKey).not.toHaveBeenCalled();
    expect(a.addCapability).not.toHaveBeenCalled();
  });

  it("a fleet key pasted into x-admin-key fails the admin lookup", async () => {
    // verifyAdminKey only matches ADMINKEY# records; the mock mirrors that by
    // rejecting anything but the minted admin key.
    const deps = makeDeps();
    const app = createApp(deps);
    const res = await app.request(grantPath, grant({ "x-admin-key": "fleet-key-value" }));
    expect(res.status).toBe(403);
  });

  it("a valid agent signature is not accepted in place of the admin key", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const body = JSON.stringify({ capability: "github" });
    const req = signed("POST", grantPath, body);
    const res = await app.request(grantPath, req);
    expect(res.status).toBe(403);
    const a = deps.agents as never as { getByFingerprint: ReturnType<typeof vi.fn>; addCapability: ReturnType<typeof vi.fn> };
    expect(a.getByFingerprint).not.toHaveBeenCalled();
    expect(a.addCapability).not.toHaveBeenCalled();
  });

  it("an oversized admin key is rejected before any verification", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const res = await app.request(grantPath, grant({ "x-admin-key": "a".repeat(10_000) }));
    expect(res.status).toBe(403);
    expect((deps.agents as never as { verifyAdminKey: ReturnType<typeof vi.fn> }).verifyAdminKey)
      .not.toHaveBeenCalled();
  });

  it("rejects a malformed capability with 400", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    for (const body of ["{nope", JSON.stringify({}), JSON.stringify({ capability: "../ADMIN" })]) {
      const res = await app.request(grantPath, grant({ "x-admin-key": "adm-good" }, body));
      expect(res.status).toBe(400);
    }
    expect((deps.agents as never as { addCapability: ReturnType<typeof vi.fn> }).addCapability)
      .not.toHaveBeenCalled();
  });

  it("404s for an unknown agentId", async () => {
    const deps = makeDeps({ addCapability: vi.fn(async () => undefined) as never });
    const app = createApp(deps);
    const res = await app.request(grantPath, grant({ "x-admin-key": "adm-good" }));
    expect(res.status).toBe(404);
  });

  it("the admin key does not authorize agent routes", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/me", { headers: { "x-admin-key": "adm-good" } });
    expect(res.status).toBe(401);
  });
});
