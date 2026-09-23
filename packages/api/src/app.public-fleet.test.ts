// Public fleet tier routes: unauthenticated BY DESIGN (the API-gateway
// throttle is the rate bound), and fail-closed by projection — the response
// may only ever contain what publicView() lets through. These tests assert
// on JSON.stringify of whole response bodies: absence of private material
// must hold for the serialized bytes, not just for individual fields.
import { canonicalString, generateKeypair, parseRepoAllowlist, sign } from "@agent-identity/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp, type Deps } from "./app.js";
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

const agent = {
  agentId: "482913", address: "482913@d", status: "active" as const,
  publicKey: kp.publicKeySpkiBase64, createdAt: "t",
};

const FLEET_EVENTS = [
  { agentId: "482913", ts: "2026-09-23T12:00:03.000Z", class: "attested", type: "forge_commit",
    summary: "committed to critical-labs/core@main",
    detail: { service: "github", repo: "critical-labs/core", branch: "main", sha: "abc", visibility: "public" },
    ref: "https://github.com/critical-labs/core/commit/abc" },
  { agentId: "482913", ts: "2026-09-23T12:00:02.000Z", class: "attested", type: "forge_commit",
    summary: "committed to mc/homefree@main",
    detail: { service: "github", repo: "mc/homefree", branch: "main", sha: "ddd", visibility: "public" },
    ref: "https://github.com/mc/homefree/commit/ddd" },
  { agentId: "482913", ts: "2026-09-23T12:00:01.000Z", class: "claimed", type: "status",
    summary: "status: working — homefree billing fix",
    detail: { state: "working", label: "homefree billing fix" } },
  { agentId: "482913", ts: "2026-09-23T12:00:00.000Z", class: "claimed", type: "task_note",
    summary: "rotating homefree db credentials" },
  { agentId: "482913", ts: "2026-09-23T11:59:59.000Z", class: "attested", type: "email_received",
    summary: "email received from secret-partner.example",
    detail: { senderDomain: "secret-partner.example" } },
  { agentId: "482913", ts: "2026-09-23T11:59:58.000Z", class: "attested", type: "email_received",
    summary: "email received from github.com", detail: { senderDomain: "github.com" } },
];

const ROSTER = [{
  agentId: "482913", capabilities: ["github"],
  status: { state: "working", label: "homefree billing fix", updatedAt: "2026-09-23T12:00:01.000Z", stale: false },
  counts: { attested: 4, claimed: 2 },
}];

function makeDeps(overrides: Record<string, unknown> = {}): Deps {
  return {
    agents: {
      getByFingerprint: vi.fn(async () => agent),
      verifyFleetKey: vi.fn(async () => true),
      verifyAdminKey: vi.fn(async (k: string) => k === "adm-good"),
      verifyViewerKey: vi.fn(async (k: string) => k === "vk"),
    } as never,
    emails: {} as never,
    activity: {
      putEvent: vi.fn(async () => "id"),
      listEvents: vi.fn(async () => ({ events: [] })),
      setStatus: vi.fn(async () => {}),
      getStatus: vi.fn(async () => undefined),
      listFleetEvents: vi.fn(async () => ({ events: FLEET_EVENTS })),
      fleetRoster: vi.fn(async () => ROSTER),
      ...overrides,
    } as never,
    nonces: { recordOnce: async () => true } as never as NoncesRepo,
    readBody: vi.fn(async () => ({ text: "", links: [] })),
    fleetKeyRequired: true,
    publicRepos: parseRepoAllowlist("critical-labs/*"),
    ...(overrides.publicRepos !== undefined ? { publicRepos: overrides.publicRepos as string[] } : {}),
  };
}

describe("public fleet routes — no credential required", () => {
  it("GET /fleet/public/activity answers 200 with zero auth headers and marks the tier", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/fleet/public/activity");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.publicView).toBe(true);
    expect(body.events.map((e: { type: string }) => e.type))
      .toEqual(["forge_commit", "status", "email_received"]);
  });

  it("GET /fleet/public/agents answers 200 with zero auth headers and marks the tier", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/fleet/public/agents");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.publicView).toBe(true);
    expect(body.agents).toEqual([{
      agentId: "482913", capabilities: ["github"],
      status: { state: "working", stale: false },
      counts: { attested: 2, claimed: 1 },
    }]);
  });

  it("serialized responses never contain private repos, labels, notes, or non-forge domains", async () => {
    const app = createApp(makeDeps());
    for (const path of ["/fleet/public/activity", "/fleet/public/agents"]) {
      const s = await (await app.request(path)).text();
      expect(s, path).not.toContain("homefree");
      expect(s, path).not.toContain("billing");
      expect(s, path).not.toContain("rotating");
      expect(s, path).not.toContain("secret-partner.example");
      expect(s, path).not.toContain("label");
      expect(s, path).not.toContain("updatedAt");
    }
  });

  it("an empty allowlist yields no forge events and zero attested counts — not an error", async () => {
    const app = createApp(makeDeps({ publicRepos: [] }));
    const feed = await (await app.request("/fleet/public/activity")).json();
    expect(feed.events.map((e: { type: string }) => e.type)).toEqual(["status", "email_received"]);
    const roster = await (await app.request("/fleet/public/agents")).json();
    expect(roster.agents[0].counts).toEqual({ attested: 1, claimed: 1 });
    expect(JSON.stringify(feed) + JSON.stringify(roster)).not.toContain("critical-labs");
  });
});

describe("public fleet routes — credentials grant nothing extra", () => {
  it("viewer key, admin key, fleet key, and a valid signature all get the identical public body", async () => {
    const app = createApp(makeDeps());
    const bare = await (await app.request("/fleet/public/activity")).text();
    const attempts: Record<string, string>[] = [
      { "x-viewer-key": "vk" },
      { "x-admin-key": "adm-good" },
      { "x-fleet-key": "fk" },
      signed("GET", "/fleet/public/activity").headers as never,
    ];
    for (const headers of attempts) {
      expect(await (await app.request("/fleet/public/activity", { headers })).text()).toBe(bare);
    }
  });

  it("keyed fleet routes still demand the viewer key (401/403 unchanged)", async () => {
    const app = createApp(makeDeps());
    expect((await app.request("/fleet/activity")).status).toBe(401);
    expect((await app.request("/fleet/agents")).status).toBe(401);
    expect((await app.request("/fleet/activity", { headers: { "x-viewer-key": "wrong" } })).status).toBe(403);
  });

  it("unknown /fleet/public/* paths and methods fall through to the credential wall", async () => {
    const app = createApp(makeDeps());
    expect((await app.request("/fleet/public/emails")).status).toBe(401);
    expect((await app.request("/fleet/public/activity", { method: "POST" })).status).toBe(401);
  });
});

describe("public fleet routes — parameters cannot widen output", () => {
  it("clamps limit to the public cap and ignores everything else", async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      agentId: "482913", ts: `2026-09-23T11:${String(i % 60).padStart(2, "0")}:00.000Z`,
      class: "attested", type: "forge_commit", summary: "committed to critical-labs/core@main",
      detail: { service: "github", repo: "critical-labs/core", branch: "main", sha: `s${i}`, visibility: "public" },
    }));
    const deps = makeDeps({ listFleetEvents: vi.fn(async () => ({ events: many })) as never });
    const app = createApp(deps);
    const res = await app.request("/fleet/public/activity?limit=999999");
    const body = await res.json();
    expect(body.events.length).toBe(100);
    // the storage read is clamped server-side regardless of the query, and
    // it is projection-aware: the repo filters to PUBLIC events before its
    // limit, so private volume cannot displace public events (no tempo
    // side channel, no availability loss)
    const listFleetEvents = (deps.activity as never as { listFleetEvents: ReturnType<typeof vi.fn> }).listFleetEvents;
    expect(listFleetEvents).toHaveBeenCalledWith({ limit: 100, filter: expect.any(Function) });
  });

  it("defaults a missing/garbage limit and floors a hostile one at 1", async () => {
    const app = createApp(makeDeps());
    expect((await (await app.request("/fleet/public/activity?limit=abc")).json()).events.length).toBe(3);
    expect((await (await app.request("/fleet/public/activity?limit=-5")).json()).events.length).toBe(1);
    expect((await (await app.request("/fleet/public/activity?limit=0")).json()).events.length).toBe(1);
  });

  it("cursor, agentId, and includePrivate params are dead: responses match the bare request", async () => {
    const app = createApp(makeDeps());
    const bare = await (await app.request("/fleet/public/activity")).text();
    for (const q of ["?cursor=abc", "?agentId=482913", "?includePrivate=true", "?class=claimed"]) {
      expect(await (await app.request("/fleet/public/activity" + q)).text(), q).toBe(bare);
    }
  });
});
