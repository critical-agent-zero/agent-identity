import { poolStatus, savePoolProfile } from "@agent-identity/client";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClaimManager, NoIdentityError } from "./claim-manager.js";

const base = () => mkdtempSync(join(tmpdir(), "aid-mgr-"));

const profile = (agentId: string, github?: { username: string }) => ({
  publicKeySpkiBase64: `pk-${agentId}`,
  privateKeyPem: `sk-${agentId}`,
  agentId,
  address: `${agentId}@d`,
  ...(github ? { github } : {}),
});

// Fake client factory: register() echoes back an identity derived from the keypair.
function fakeFactory(registered: string[] = []) {
  return vi.fn((keypair: { publicKeySpkiBase64: string }) => {
    const id = keypair.publicKeySpkiBase64.startsWith("pk-")
      ? keypair.publicKeySpkiBase64.slice(3)
      : "555555"; // fresh keypair created by auto-create
    return {
      register: vi.fn(async () => {
        registered.push(id);
        return { agentId: id, address: `${id}@d` };
      }),
      listEmails: vi.fn(async () => ({ emails: [] })),
      getEmail: vi.fn(async () => ({ id: "e", from: "f", subject: "s", receivedAt: "t", text: "", links: [] })),
    };
  });
}

// Fake client factory modeling the auto-capabilities policy: register()
// grants the intersection of requestedCapabilities and `granting`. Fresh
// keypairs (auto-provision) get stable sequential ids starting at 555550.
function grantingFactory(granting: string[], registerCalls: unknown[] = []) {
  const ids = new Map<string, string>();
  let fresh = 0;
  return vi.fn((keypair: { publicKeySpkiBase64: string }) => {
    const key = keypair.publicKeySpkiBase64;
    let id: string;
    if (key.startsWith("pk-")) {
      id = key.slice(3);
    } else {
      if (!ids.has(key)) ids.set(key, String(555550 + fresh++));
      id = ids.get(key)!;
    }
    return {
      register: vi.fn(async (opts?: { requestedCapabilities?: string[] }) => {
        registerCalls.push(opts);
        const caps = (opts?.requestedCapabilities ?? []).filter((c) => granting.includes(c));
        return {
          agentId: id, address: `${id}@d`,
          ...(caps.length > 0 ? { capabilities: caps } : {}),
        };
      }),
    };
  });
}

describe("ClaimManager auto-capabilities", () => {
  it("require with the policy ON mints a capable identity, claims it, and records the grant", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir); // plain only — cannot satisfy require
    const calls: unknown[] = [];
    const mgr = new ClaimManager({
      base: dir, fleetKey: "fk", makeClient: grantingFactory(["github"], calls) as never,
    });
    await mgr.init();
    expect(mgr.status().held?.name).toBe("111111");
    const identity = await mgr.ensureIdentity(["github"]);
    expect(identity.agentId).toBe("555550");
    expect(calls[0]).toEqual({ requestedCapabilities: ["github"] });
    expect(mgr.status().held?.name).toBe("555550");
    expect(mgr.status().held?.capabilities).toContain("github");
    mgr.release();
  });

  it("require with the policy OFF fails with the remediation text plus the policy hint, keeping the claim", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    const mgr = new ClaimManager({
      base: dir, fleetKey: "fk", makeClient: grantingFactory([], []) as never,
    });
    await mgr.init();
    await expect(mgr.ensureIdentity(["github"])).rejects.toThrow(
      /no free identity with capabilities \[github\][\s\S]*auto-capabilities/,
    );
    expect(mgr.status().held?.name).toBe("111111");
    // The refused-grant identity is still a valid plain one: kept in the
    // pool rather than orphaning a registered keypair.
    expect(mgr.status().pool.total).toBe(2);
    mgr.release();
  });

  it("plain auto-provision (no require) asks for no capabilities", async () => {
    const dir = base(); // empty pool
    const calls: unknown[] = [];
    const mgr = new ClaimManager({
      base: dir, fleetKey: "fk", makeClient: grantingFactory(["github"], calls) as never,
    });
    await mgr.init();
    expect(mgr.status().held?.agentId).toBe("555550");
    expect(calls[0] ?? {}).toEqual({});
  });

  it("require satisfied by the pool never mints", async () => {
    const dir = base();
    savePoolProfile(profile("222222", { username: "x" }), dir);
    const calls: unknown[] = [];
    const mgr = new ClaimManager({
      base: dir, require: ["github"], fleetKey: "fk",
      makeClient: grantingFactory(["github"], calls) as never,
    });
    await mgr.init();
    expect(mgr.status().held?.name).toBe("222222");
    expect(calls).toEqual([]);
    mgr.release();
  });
});

// Models a server whose AUTO_CAPABILITIES policy is OFF: register() succeeds
// (fleet key accepted) but never grants anything. Fresh keypairs get stable
// sequential ids, mirroring real registration.
function policyOffFactory(registered: string[]) {
  let fresh = 0;
  const ids = new Map<string, string>();
  return vi.fn((keypair: { publicKeySpkiBase64: string }) => {
    const key = keypair.publicKeySpkiBase64;
    if (!ids.has(key)) ids.set(key, String(700000 + fresh++));
    const id = ids.get(key)!;
    return {
      register: vi.fn(async () => {
        registered.push(id);
        return { agentId: id, address: `${id}@d`, capabilities: [] };
      }),
    };
  });
}

// Every server-side registration is permanent (agent record, mailbox address
// from the finite agentId space, roster entry), so a require the policy
// refuses must not mint one identity per retry or per session restart.
describe("ClaimManager probe suppression (mint-runaway regression)", () => {
  it("repeated ensureIdentity(require) with the policy OFF registers at most one probe identity", async () => {
    const dir = base();
    const registered: string[] = [];
    const mgr = new ClaimManager({
      base: dir, fleetKey: "fk", makeClient: policyOffFactory(registered) as never,
    });
    // An agent (or its harness) retrying the documented remediation path.
    for (let i = 0; i < 5; i++) {
      await expect(mgr.ensureIdentity(["github"])).rejects.toThrow(/no free identity/);
    }
    // One refused-grant probe is the stated trade-off (avoids orphaning a
    // registered keypair); retries must reuse its recorded refusal.
    expect(registered).toHaveLength(1);
    expect(poolStatus({ base: dir }).total).toBe(1);
  });

  it("MCP restarts with AGENT_IDENTITY_REQUIRE set share the one parked probe across managers", async () => {
    const dir = base();
    const registered: string[] = [];
    // ONE factory across restarts: the real server allocates a fresh agentId
    // for every fresh keypair, regardless of client process lifetime.
    const factory = policyOffFactory(registered);
    for (let restart = 0; restart < 3; restart++) {
      const mgr = new ClaimManager({
        base: dir, fleetKey: "fk", require: ["github"], makeClient: factory as never,
      });
      await mgr.init(); // swallows the NoIdentityError into initError
      expect(mgr.status().held).toBeNull();
      mgr.release();
    }
    expect(registered).toHaveLength(1);
    expect(poolStatus({ base: dir }).total).toBe(1);
  });

  it("the suppressed error names the parked probe and keeps both remediations", async () => {
    const dir = base();
    const mgr = new ClaimManager({
      base: dir, fleetKey: "fk", makeClient: policyOffFactory([]) as never,
    });
    await expect(mgr.ensureIdentity(["github"])).rejects.toThrow(/auto-capabilities/);
    await expect(mgr.ensureIdentity(["github"])).rejects.toThrow(
      /no free identity with capabilities \[github\][\s\S]*700000[\s\S]*AUTO_CAPABILITIES/,
    );
  });

  it("a parked probe consumed by a plain session no longer suppresses a fresh probe", async () => {
    const dir = base();
    const registered: string[] = [];
    const factory = policyOffFactory(registered);
    const mgr = new ClaimManager({ base: dir, fleetKey: "fk", makeClient: factory as never });
    await expect(mgr.ensureIdentity(["github"])).rejects.toThrow(/no free identity/);
    // A plain session claims the parked refused-grant identity (it is a
    // valid plain one)...
    const plain = new ClaimManager({ base: dir, fleetKey: "fk", makeClient: factory as never });
    await plain.init();
    expect(plain.status().held?.name).toBe("700000");
    // ...so the probe path may register again: pool growth stays bounded by
    // real identity consumption, exactly like plain auto-provision.
    await expect(mgr.ensureIdentity(["github"])).rejects.toThrow(/no free identity/);
    expect(registered).toHaveLength(2);
    plain.release();
  });
});

describe("ClaimManager", () => {
  it("init claims a free pool profile and client() works", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    const mgr = new ClaimManager({ base: dir, makeClient: fakeFactory() as never });
    await mgr.init();
    expect(mgr.status().held?.name).toBe("111111");
    expect(mgr.client()).toBeDefined();
    mgr.release();
  });

  it("init with empty pool auto-creates, registers, and claims a new profile", async () => {
    const dir = base();
    const registered: string[] = [];
    const mgr = new ClaimManager({
      base: dir, fleetKey: "fk", makeClient: fakeFactory(registered) as never,
    });
    await mgr.init();
    expect(registered).toEqual(["555555"]);
    expect(mgr.status().held?.agentId).toBe("555555");
    expect(mgr.status().pool.total).toBe(1); // saved into the pool
    mgr.release();
  });

  it("init with require github and none free stores the error; tools throw NoIdentityError", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir); // plain only
    const mgr = new ClaimManager({
      base: dir, require: ["github"], makeClient: fakeFactory() as never,
    });
    await mgr.init(); // must not throw
    expect(mgr.status().held).toBeNull();
    expect(() => mgr.client()).toThrow(NoIdentityError);
    await expect(mgr.ensureIdentity()).rejects.toThrow(/no free identity with capabilities \[github\]/);
  });

  it("ensureIdentity registers, persists identity, and is idempotent", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    const mgr = new ClaimManager({ base: dir, makeClient: fakeFactory() as never });
    await mgr.init();
    expect(await mgr.ensureIdentity()).toEqual({ agentId: "111111", address: "111111@d" });
    expect(await mgr.ensureIdentity()).toEqual({ agentId: "111111", address: "111111@d" });
    mgr.release();
  });

  it("ensureIdentity({require:[github]}) swaps to a qualifying profile and frees the old one", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    savePoolProfile(profile("222222", { username: "x" }), dir);
    const mgr = new ClaimManager({ base: dir, makeClient: fakeFactory() as never });
    await mgr.init();
    expect(mgr.status().held?.name).toBe("111111");
    expect(await mgr.ensureIdentity(["github"])).toEqual({ agentId: "222222", address: "222222@d" });
    expect(mgr.status().held?.name).toBe("222222");
    expect(mgr.status().pool.freeByCapability).toEqual({}); // github one now held
    // old profile is free again:
    const mgr2 = new ClaimManager({ base: dir, makeClient: fakeFactory() as never });
    await mgr2.init();
    expect(mgr2.status().held?.name).toBe("111111");
    mgr.release();
    mgr2.release();
  });

  it("failed swap keeps the current claim", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    const mgr = new ClaimManager({ base: dir, makeClient: fakeFactory() as never });
    await mgr.init();
    await expect(mgr.ensureIdentity(["github"])).rejects.toThrow(NoIdentityError);
    expect(mgr.status().held?.name).toBe("111111");
    // the lock must still exist on disk — the old claim was never released
    expect(existsSync(join(dir, "claims", "111111.lock"))).toBe(true);
    mgr.release();
  });
});
