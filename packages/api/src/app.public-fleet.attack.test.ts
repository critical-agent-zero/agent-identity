// ADVERSARIAL leak-hunt tests for the /fleet/public routes. Each test
// asserts an invariant of the unauthenticated tier; a FAILING test here
// demonstrates a real hole, not a broken test.
//
// The volume-oracle suite guards the fix for: "a fixed raw pre-projection
// window lets private activity crowd out public events and thereby signal
// itself" — the routes must read projection-aware (filter first, then
// limit), so private volume can neither empty the public feed nor perturb
// the public roster counts.
import { parseRepoAllowlist, type ActivityEvent } from "@agent-identity/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp, type Deps } from "./app.js";
import type { NoncesRepo } from "./db/nonces.js";

const privateCommit = (i: number): ActivityEvent => ({
  agentId: "482913", ts: new Date(Date.UTC(2026, 8, 23, 12, 0, i)).toISOString(),
  class: "attested", type: "forge_commit",
  summary: "committed to mc/homefree@main",
  detail: { service: "github", repo: "mc/homefree", branch: "main", sha: `priv${i}`, visibility: "private" },
  ref: `https://github.com/mc/homefree/commit/priv${i}`,
});

const publicCommit = (i: number): ActivityEvent => ({
  agentId: "482913", ts: new Date(Date.UTC(2026, 8, 23, 11, 0, i)).toISOString(),
  class: "attested", type: "forge_commit",
  summary: "committed to critical-labs/core@main",
  detail: { service: "github", repo: "critical-labs/core", branch: "main", sha: `pub${i}`, visibility: "public" },
  ref: `https://github.com/critical-labs/core/commit/pub${i}`,
});

function makeDeps(allEvents: ActivityEvent[], roster: unknown[] = []): Deps {
  return {
    agents: {
      getByFingerprint: vi.fn(async () => undefined),
      verifyFleetKey: vi.fn(async () => false),
      verifyAdminKey: vi.fn(async () => false),
      verifyViewerKey: vi.fn(async () => false),
    } as never,
    emails: {} as never,
    activity: {
      // Faithful mock of ActivityRepo.listFleetEvents: the real scan reads
      // the WHOLE log, sorts newest-first, applies the caller's filter, and
      // only then slices to the limit (packages/api/src/db/activity.ts).
      listFleetEvents: vi.fn(async (
        opts: { limit?: number; filter?: (e: ActivityEvent) => boolean } = {},
      ) => {
        const sorted = [...allEvents].sort((a, b) => (a.ts < b.ts ? 1 : -1));
        const kept = opts.filter ? sorted.filter(opts.filter) : sorted;
        return { events: kept.slice(0, Math.min(opts.limit ?? 50, 200)) };
      }),
      fleetRoster: vi.fn(async () => roster),
    } as never,
    nonces: { recordOnce: async () => true } as never as NoncesRepo,
    readBody: vi.fn(async () => ({ text: "", links: [] })),
    fleetKeyRequired: true,
    publicRepos: parseRepoAllowlist("critical-labs/*"),
  };
}

describe("ATTACK — private-event volume oracle via a fixed pre-projection window", () => {
  it("200 newer private events cannot crowd public events out of the public feed", async () => {
    // Storage: 50 publishable commits (older) + 200 private commits (newer).
    // A raw newest-200 window would return only private events, projecting
    // to an EMPTY public feed — an observer who can see the public commits
    // on GitHub itself would read ~200 private events out of their absence
    // here, and legitimately publishable events would vanish (availability
    // loss). The projection-aware read must still serve all 50.
    const app = createApp(makeDeps([
      ...Array.from({ length: 50 }, (_, i) => publicCommit(i)),
      ...Array.from({ length: 200 }, (_, i) => privateCommit(i)),
    ]));
    const body = await (await app.request("/fleet/public/activity?limit=100")).json();
    expect(body.events.length).toBe(50);
    expect(JSON.stringify(body)).not.toContain("homefree");
  });

  it("public roster counts are unmoved by private events arriving — count deltas cannot mirror private tempo", async () => {
    const roster = [{ agentId: "482913", capabilities: ["github"], counts: { attested: 250, claimed: 0 } }];
    const before = createApp(makeDeps(
      Array.from({ length: 50 }, (_, i) => publicCommit(i)), roster));
    const after = createApp(makeDeps([
      ...Array.from({ length: 50 }, (_, i) => publicCommit(i)),
      ...Array.from({ length: 200 }, (_, i) => privateCommit(i)),
    ], roster));
    const b = await (await before.request("/fleet/public/agents")).json();
    const a = await (await after.request("/fleet/public/agents")).json();
    expect(b.agents[0].counts.attested).toBe(50);
    // No public activity occurred between the two polls; a non-leaking
    // count therefore must still be 50 — any collapse would be a public
    // read-out of private volume.
    expect(a.agents[0].counts.attested).toBe(50);
  });
});

describe("ATTACK — serialization under a hostile fixture set", () => {
  const HOSTILE: ActivityEvent[] = [
    publicCommit(1),
    privateCommit(1),
    { agentId: "482913", ts: "2026-09-23T12:10:00.000Z", class: "attested", type: "forge_commit",
      summary: "committed", detail: { service: "github", visibility: "public" } }, // repo MISSING — must drop
    { agentId: "482913", ts: "2026-09-23T12:11:00.000Z", class: "claimed", type: "status",
      summary: "status: working — homefree#185 rollout",
      detail: { state: "working", label: "homefree#185 rollout" } },
    { agentId: "482913", ts: "2026-09-23T12:12:00.000Z", class: "claimed", type: "task_note",
      summary: "task: set HOMEFREE_DB_URL=postgres://root:hunter2@10.0.0.1/homefree" },
    { agentId: "482913", ts: "2026-09-23T12:13:00.000Z", class: "attested", type: "email_received",
      summary: "email received from homefree-partner.example",
      detail: { senderDomain: "homefree-partner.example" } },
    { agentId: "482913", ts: "2026-09-23T12:14:00.000Z", class: "attested", type: "capability_granted",
      summary: "provisioned a github service account", detail: { service: "github" } },
  ];
  const ROSTER = [{
    agentId: "482913", capabilities: ["github"],
    status: { state: "working", label: "homefree#185 rollout", updatedAt: "2026-09-23T12:11:00.000Z", stale: false },
    counts: { attested: 999, claimed: 999 },
  }];

  it("neither route's serialized bytes contain private repo names, labels, secrets, or foreign domains", async () => {
    const app = createApp(makeDeps(HOSTILE, ROSTER));
    for (const path of ["/fleet/public/activity", "/fleet/public/agents"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      const s = await res.text();
      for (const needle of [
        "homefree", "hunter2", "HOMEFREE_DB_URL", "10.0.0.1", "#185",
        "homefree-partner.example", "label", "updatedAt", "priv1", "999",
      ]) {
        expect(s, `${path} must not contain ${needle}`).not.toContain(needle);
      }
      expect(JSON.parse(s).publicView, path).toBe(true);
    }
  });

  it("the missing-detail.repo forge event is dropped, not passed", async () => {
    const app = createApp(makeDeps(HOSTILE, ROSTER));
    const body = await (await app.request("/fleet/public/activity")).json();
    expect(body.events.map((e: { type: string }) => e.type).sort())
      .toEqual(["forge_commit", "status"]);
    expect(body.events.find((e: { type: string }) => e.type === "forge_commit").detail.sha).toBe("pub1");
  });
});

describe("ATTACK — route isolation and parameter abuse", () => {
  it("hostile limits and unknown params never widen output or change shape", async () => {
    const app = createApp(makeDeps([publicCommit(1), privateCommit(1)]));
    const bare = await (await app.request("/fleet/public/activity")).text();
    for (const q of [
      "?limit=-1", "?limit=1e309", "?limit=NaN", "?limit=0x7f", "?limit=2&limit=99999",
      "?cursor=" + Buffer.from(JSON.stringify({ PK: "AGENT#482913", SK: "ACT#z" })).toString("base64url"),
      "?agentId=../../etc", "?includePrivate=true", "?publicView=false", "?allowlist=mc/homefree",
    ]) {
      const s = await (await app.request("/fleet/public/activity" + q)).text();
      expect(s, q).not.toContain("homefree");
      expect(JSON.parse(s).publicView, q).toBe(true);
    }
    // and the bare body itself is the projected one
    expect(bare).toContain("pub1");
    expect(bare).not.toContain("priv1");
  });

  it("non-GET methods and sibling paths under /fleet/public stay behind the viewer wall", async () => {
    const app = createApp(makeDeps([privateCommit(1)]));
    for (const [path, init] of [
      ["/fleet/public/activity", { method: "POST" }],
      ["/fleet/public/activity", { method: "PUT" }],
      ["/fleet/public/activity", { method: "DELETE" }],
      ["/fleet/public", {}],
      ["/fleet/public/", {}],
      ["/fleet/public/roster", {}],
      ["/fleet/public/agents/482913", {}],
    ] as const) {
      const res = await app.request(path, init as never);
      expect([401, 403, 404], `${(init as { method?: string }).method ?? "GET"} ${path}`).toContain(res.status);
      expect(await res.text()).not.toContain("homefree");
    }
  });

  it("credentials on the public routes change nothing (no auth-widened projection)", async () => {
    const app = createApp(makeDeps([publicCommit(1), privateCommit(1)]));
    const bare = await (await app.request("/fleet/public/activity")).text();
    const attempts: Record<string, string>[] = [
      { "x-viewer-key": "vk" }, { "x-admin-key": "root" }, { "x-fleet-key": "fk" },
      { authorization: "Bearer sneaky" }, { cookie: "admin=1" },
      { "x-agent-key": "k", "x-agent-timestamp": "t", "x-agent-signature": "s" },
    ];
    for (const headers of attempts) {
      expect(await (await app.request("/fleet/public/activity", { headers })).text()).toBe(bare);
    }
  });

  it("error paths do not leak: a storage failure returns a generic 500 body", async () => {
    const deps = makeDeps([]);
    (deps.activity as never as { listFleetEvents: ReturnType<typeof vi.fn> }).listFleetEvents =
      vi.fn(async () => { throw new Error("ConditionalCheckFailed: item AGENT#482913 ACT#homefree"); });
    const app = createApp(deps);
    const res = await app.request("/fleet/public/activity");
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("homefree");
  });
});
