import { chmodSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  adminKeyPath, disableGithub, enableGithub, readAdminKeyFile, resolveAdminApiUrl,
  resolveAdminKey, writeAdminKeyFile,
} from "./admin.js";
import { poolDir, savePoolProfile, type PoolProfile } from "./claims.js";

const base = () => mkdtempSync(join(tmpdir(), "aid-admin-"));

const profile = (agentId: string, github?: { username: string }): PoolProfile & { agentId: string } => ({
  publicKeySpkiBase64: `pk-${agentId}`,
  privateKeyPem: `sk-${agentId}`,
  agentId,
  address: `${agentId}@d`,
  ...(github ? { github } : {}),
});

const savedProfile = (dir: string, agentId: string) =>
  JSON.parse(readFileSync(join(poolDir(dir), `${agentId}.json`), "utf8"));

function fetchOk(body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
}

describe("admin key file", () => {
  it("round-trips trimmed key with mode 600", () => {
    const dir = base();
    writeAdminKeyFile("  adm-123\n", dir);
    expect(readAdminKeyFile(dir)).toBe("adm-123");
    expect(statSync(adminKeyPath(dir)).mode & 0o777).toBe(0o600);
  });

  it("returns undefined when missing or empty", () => {
    const dir = base();
    expect(readAdminKeyFile(dir)).toBeUndefined();
    writeAdminKeyFile("", dir);
    expect(readAdminKeyFile(dir)).toBeUndefined();
  });

  it("refuses a group/world-accessible key file", () => {
    const dir = base();
    writeAdminKeyFile("adm-123", dir);
    chmodSync(adminKeyPath(dir), 0o644);
    expect(() => readAdminKeyFile(dir)).toThrow(/chmod 600/);
  });

  it("restores mode 600 when overwriting a looser-mode file", () => {
    const dir = base();
    writeAdminKeyFile("adm-123", dir);
    chmodSync(adminKeyPath(dir), 0o644);
    writeAdminKeyFile("adm-456", dir);
    expect(statSync(adminKeyPath(dir)).mode & 0o777).toBe(0o600);
    expect(readAdminKeyFile(dir)).toBe("adm-456");
  });
});

describe("resolveAdminApiUrl", () => {
  const confirmSpy = (answer: boolean) => vi.fn(async () => answer);

  it("uses an operator-typed --api-url without confirmation", async () => {
    const confirm = confirmSpy(false);
    await expect(resolveAdminApiUrl({
      flagUrl: "https://flag.example", envUrl: "https://env.example",
      configUrl: "https://config.example", confirm,
    })).resolves.toBe("https://flag.example");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("uses the operator shell env before the agent-writable machine config", async () => {
    const confirm = confirmSpy(false);
    await expect(resolveAdminApiUrl({
      envUrl: "https://env.example", configUrl: "https://config.example", confirm,
    })).resolves.toBe("https://env.example");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("requires confirmation for a machine-config apiUrl", async () => {
    const confirm = confirmSpy(true);
    await expect(resolveAdminApiUrl({ configUrl: "https://config.example", confirm }))
      .resolves.toBe("https://config.example");
    expect(confirm).toHaveBeenCalledWith("https://config.example");
  });

  it("refuses a declined machine-config apiUrl", async () => {
    await expect(resolveAdminApiUrl({ configUrl: "https://evil.example", confirm: confirmSpy(false) }))
      .rejects.toThrow(/refused to send the admin key to https:\/\/evil\.example/);
  });

  it("fails without any apiUrl before asking anything", async () => {
    const confirm = confirmSpy(true);
    await expect(resolveAdminApiUrl({ confirm })).rejects.toThrow(/no API URL/);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("resolveAdminKey", () => {
  it("prefers the env value over the file, empty env = unset", () => {
    const dir = base();
    expect(resolveAdminKey(undefined, dir)).toBeUndefined();
    writeAdminKeyFile("from-file", dir);
    expect(resolveAdminKey(undefined, dir)).toBe("from-file");
    expect(resolveAdminKey("", dir)).toBe("from-file");
    expect(resolveAdminKey("from-env", dir)).toBe("from-env");
  });
});

describe("enableGithub", () => {
  it("grants the capability over the admin route and links github locally", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    const fetchFn = fetchOk({ agentId: "111111", capabilities: ["github"] });
    const r = await enableGithub({
      agentId: "111111", apiUrl: "https://api.example", adminKey: "adm",
      username: "critical-agent-two", credentialRef: "op://x", base: dir, fetchFn,
    });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/admin/agents/111111/capabilities");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-admin-key"]).toBe("adm");
    expect(JSON.parse(init.body as string)).toEqual({ capability: "github" });
    expect(savedProfile(dir, "111111").github)
      .toEqual({ username: "critical-agent-two", credentialRef: "op://x" });
    expect(r).toEqual({
      agentId: "111111", address: "111111@d", capabilities: ["github"],
      github: { username: "critical-agent-two", credentialRef: "op://x" },
    });
  });

  it("keeps an existing local github link when no username is passed", async () => {
    const dir = base();
    savePoolProfile(profile("111111", { username: "existing-login" }), dir);
    const fetchFn = fetchOk({ agentId: "111111", capabilities: ["github"] });
    const r = await enableGithub({
      agentId: "111111", apiUrl: "https://api.example", adminKey: "adm", base: dir, fetchFn,
    });
    expect(r.github).toEqual({ username: "existing-login" });
    expect(savedProfile(dir, "111111").github).toEqual({ username: "existing-login" });
  });

  it("fails before calling the API when no username is known", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    const fetchFn = fetchOk({});
    await expect(enableGithub({
      agentId: "111111", apiUrl: "https://api.example", adminKey: "adm", base: dir, fetchFn,
    })).rejects.toThrow(/--username/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fails before calling the API for an unknown pool identity", async () => {
    const fetchFn = fetchOk({});
    await expect(enableGithub({
      agentId: "999999", apiUrl: "https://api.example", adminKey: "adm",
      username: "x", base: base(), fetchFn,
    })).rejects.toThrow(/no pool identity 999999/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("surfaces API errors with status and leaves the profile unlinked", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    const fetchFn = vi.fn(async () => new Response("forbidden", { status: 403 }));
    await expect(enableGithub({
      agentId: "111111", apiUrl: "https://api.example", adminKey: "bad",
      username: "x", base: dir, fetchFn,
    })).rejects.toThrow(/API 403/);
    expect(savedProfile(dir, "111111").github).toBeUndefined();
  });
});

describe("disableGithub", () => {
  it("revokes over the admin route and unlinks locally", async () => {
    const dir = base();
    savePoolProfile(profile("111111", { username: "critical-agent-two" }), dir);
    const fetchFn = fetchOk({ agentId: "111111", capabilities: [] });
    const r = await disableGithub({
      agentId: "111111", apiUrl: "https://api.example", adminKey: "adm", base: dir, fetchFn,
    });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/admin/agents/111111/capabilities/github");
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>)["x-admin-key"]).toBe("adm");
    expect(savedProfile(dir, "111111").github).toBeUndefined();
    expect(r).toEqual({ agentId: "111111", capabilities: [] });
  });

  it("fails for an unknown pool identity", async () => {
    const fetchFn = fetchOk({});
    await expect(disableGithub({
      agentId: "999999", apiUrl: "https://api.example", adminKey: "adm", base: base(), fetchFn,
    })).rejects.toThrow(/no pool identity 999999/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
