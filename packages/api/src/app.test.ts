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

      verifyViewerKey: vi.fn(async (k: string) => k === "vk"),
      ...overrides,
    } as never,
    emails: {
      listEmails: vi.fn(async () => ({ emails: [] })),
      getEmail: vi.fn(async () => undefined),
      ...overrides,
    } as never,
    activity: {
      putEvent: vi.fn(async () => "id"),
      listEvents: vi.fn(async () => ({ events: [] })),
      setStatus: vi.fn(async () => {}),
      getStatus: vi.fn(async () => undefined),
      listFleetEvents: vi.fn(async () => ({ events: [] })),
      fleetRoster: vi.fn(async () => []),
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

const cp = (...codes: number[]) => String.fromCodePoint(...codes);

const postActivity = (app: ReturnType<typeof createApp>, body: unknown) => {
  const payload = JSON.stringify(body);
  return app.request("/activity", signed("POST", "/activity", payload));
};

describe("POST /activity (claimed self-reports)", () => {
  it("stores a status event as claimed and overwrites the STATUS row", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const res = await postActivity(app, { type: "status", state: "working", label: "shipping" });
    expect(res.status).toBe(201);
    const putEvent = (deps.activity as never as { putEvent: ReturnType<typeof vi.fn> }).putEvent;
    expect(putEvent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "482913", class: "claimed", type: "status",
      detail: expect.objectContaining({ state: "working", label: "shipping" }),
    }));
    const setStatus = (deps.activity as never as { setStatus: ReturnType<typeof vi.fn> }).setStatus;
    expect(setStatus).toHaveBeenCalledWith("482913", expect.objectContaining({
      state: "working", label: "shipping",
    }));
  });

  it("stores a task_note as claimed without touching the STATUS row", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const res = await postActivity(app, { type: "task_note", note: "wrote tests" });
    expect(res.status).toBe(201);
    const putEvent = (deps.activity as never as { putEvent: ReturnType<typeof vi.fn> }).putEvent;
    expect(putEvent).toHaveBeenCalledWith(expect.objectContaining({
      class: "claimed", type: "task_note", summary: "wrote tests",
    }));
    const setStatus = (deps.activity as never as { setStatus: ReturnType<typeof vi.fn> }).setStatus;
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("400s every laundering attempt: attested class or attested type from a client", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    for (const body of [
      { type: "forge_commit", summary: "I totally committed" },
      { class: "attested", type: "status", state: "working" },
      { class: "attested", type: "forge_pr" },
      { type: "email_received" },
      { type: "capability_granted" },
    ]) {
      const res = await postActivity(app, body);
      expect(res.status).toBe(400);
    }
    const putEvent = (deps.activity as never as { putEvent: ReturnType<typeof vi.fn> }).putEvent;
    expect(putEvent).not.toHaveBeenCalled();
  });

  it("accepts an explicit claimed class (it is what the server sets anyway)", async () => {
    const app = createApp(makeDeps());
    const res = await postActivity(app, { class: "claimed", type: "task_note", note: "n" });
    expect(res.status).toBe(201);
  });

  it("validates status state and note presence", async () => {
    const app = createApp(makeDeps());
    expect((await postActivity(app, { type: "status", state: "napping" })).status).toBe(400);
    expect((await postActivity(app, { type: "status" })).status).toBe(400);
    expect((await postActivity(app, { type: "task_note" })).status).toBe(400);
    expect((await postActivity(app, { type: "task_note", note: "" })).status).toBe(400);
    expect((await postActivity(app, { type: "task_note", note: 42 })).status).toBe(400);
  });

  it("sanitizes and caps agent-supplied strings at write time", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const label = `evil${cp(0x1b)}[31m` + "x".repeat(200);
    await postActivity(app, { type: "status", state: "blocked", label });
    const putEvent = (deps.activity as never as { putEvent: ReturnType<typeof vi.fn> }).putEvent;
    const stored = putEvent.mock.calls[0][0] as { detail: { label: string } };
    expect(stored.detail.label).not.toContain(cp(0x1b));
    expect(stored.detail.label.length).toBe(120);

    await postActivity(app, { type: "task_note", note: `n${cp(0x202e)}` + "y".repeat(600) });
    const note = (putEvent.mock.calls[1][0] as { summary: string }).summary;
    expect(note).not.toContain(cp(0x202e));
    expect(note.length).toBe(500);
  });
});

describe("GET /agents/me/activity", () => {
  it("returns the caller's own feed with cursor pagination", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const path = "/agents/me/activity?limit=5&cursor=abc";
    const res = await app.request(path, signed("GET", path));
    expect(res.status).toBe(200);
    const listEvents = (deps.activity as never as { listEvents: ReturnType<typeof vi.fn> }).listEvents;
    expect(listEvents).toHaveBeenCalledWith("482913", { limit: 5, cursor: "abc" });
  });

  it("400s a malformed cursor", async () => {
    const deps = makeDeps({
      listEvents: vi.fn(async () => { throw new InvalidCursorError("malformed cursor"); }) as never,
    });
    const app = createApp(deps);
    const path = "/agents/me/activity?cursor=nope";
    const res = await app.request(path, signed("GET", path));
    expect(res.status).toBe(400);
  });
});

describe("GET /me recorded status", () => {
  it("carries the server-recorded status with freshness", async () => {
    const deps = makeDeps({
      getStatus: vi.fn(async () => ({
        state: "working", label: "l", updatedAt: "t", stale: false,
      })) as never,
    });
    const app = createApp(deps);
    const res = await app.request("/me", signed("GET", "/me"));
    expect(await res.json()).toEqual(expect.objectContaining({
      status: { state: "working", label: "l", updatedAt: "t", stale: false },
    }));
  });
});

describe("fleet routes auth matrix", () => {
  it("viewer key grants GET /fleet/activity and GET /fleet/agents", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    for (const path of ["/fleet/activity", "/fleet/agents"]) {
      const res = await app.request(path, { headers: { "x-viewer-key": "vk" } });
      expect(res.status).toBe(200);
    }
  });

  it("missing viewer key is 401; wrong viewer key is 403", async () => {
    const app = createApp(makeDeps());
    expect((await app.request("/fleet/activity")).status).toBe(401);
    expect((await app.request("/fleet/activity", { headers: { "x-viewer-key": "wrong" } })).status).toBe(403);
  });

  it("a valid agent signature does NOT open fleet routes", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/fleet/activity", signed("GET", "/fleet/activity"));
    expect(res.status).toBe(401);
  });

  it("the fleet (registration) key does NOT open fleet routes", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    expect((await app.request("/fleet/activity", { headers: { "x-fleet-key": "fk" } })).status).toBe(401);
    // Presenting the fleet key VALUE as a viewer key must also fail: viewer
    // keys live in their own credential partition.
    expect((await app.request("/fleet/activity", { headers: { "x-viewer-key": "fk" } })).status).toBe(403);
  });

  it("the viewer key is rejected on every non-fleet route", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const attempts: [string, string, unknown][] = [
      ["POST", "/activity", { type: "task_note", note: "n" }],
      ["GET", "/emails", undefined],
      ["GET", "/me", undefined],
      ["GET", "/agents/me/activity", undefined],
      ["POST", "/register", undefined],
    ];
    for (const [method, path, body] of attempts) {
      const res = await app.request(path, {
        method,
        body: body ? JSON.stringify(body) : undefined,
        headers: { "x-viewer-key": "vk" },
      });
      expect(res.status).toBe(401);
    }
    const putEvent = (deps.activity as never as { putEvent: ReturnType<typeof vi.fn> }).putEvent;
    expect(putEvent).not.toHaveBeenCalled();
  });

  it("GET /fleet/activity serves the fleet feed", async () => {
    const deps = makeDeps({
      listFleetEvents: vi.fn(async () => ({
        events: [{ agentId: "1", ts: "t", class: "attested", type: "email_received", summary: "email received from github.com", detail: { senderDomain: "github.com" } }],
      })) as never,
    });
    const app = createApp(deps);
    const res = await app.request("/fleet/activity?limit=10", { headers: { "x-viewer-key": "vk" } });
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    const listFleetEvents = (deps.activity as never as { listFleetEvents: ReturnType<typeof vi.fn> }).listFleetEvents;
    expect(listFleetEvents).toHaveBeenCalledWith({ limit: 10 });
  });

  it("GET /fleet/agents serves the roster", async () => {
    const deps = makeDeps({
      fleetRoster: vi.fn(async () => [
        { agentId: "1", capabilities: ["github"], counts: { attested: 2, claimed: 1 } },
      ]) as never,
    });
    const app = createApp(deps);
    const res = await app.request("/fleet/agents", { headers: { "x-viewer-key": "vk" } });
    expect(await res.json()).toEqual({
      agents: [{ agentId: "1", capabilities: ["github"], counts: { attested: 2, claimed: 1 } }],
    });
  });
});
