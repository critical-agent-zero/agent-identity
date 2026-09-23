// Operator-only admin-key handling: resolves the operator admin key and
// drives the capability routes it gates. Deliberately NOT re-exported from
// index.ts — the agent-facing MCP server depends on that library surface and
// must never gain access to the admin key. The CLI imports this module
// directly.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { linkGithub, listPool, unlinkGithub, type GithubLink } from "./claims.js";
import { defaultProfileDir } from "./profile.js";

export const adminKeyPath = (base: string = defaultProfileDir()): string =>
  join(base, "admin_key");

export function readAdminKeyFile(base?: string): string | undefined {
  try {
    const key = readFileSync(adminKeyPath(base), "utf8").trim();
    return key || undefined;
  } catch {
    return undefined;
  }
}

export function writeAdminKeyFile(key: string, base: string = defaultProfileDir()): void {
  mkdirSync(base, { recursive: true });
  writeFileSync(adminKeyPath(base), `${key.trim()}\n`, { mode: 0o600 });
}

export function resolveAdminKey(
  env: string | undefined = process.env.AGENT_IDENTITY_ADMIN_KEY,
  base?: string,
): string | undefined {
  return env || readAdminKeyFile(base);
}

export interface CapabilityCallOptions {
  apiUrl: string;
  adminKey: string;
  fetchFn?: typeof globalThis.fetch;
}

interface CapabilityResult {
  agentId: string;
  capabilities: string[];
}

async function callCapabilityRoute(
  opts: CapabilityCallOptions, method: "POST" | "DELETE", agentId: string, capability: string,
): Promise<CapabilityResult> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const path = method === "POST"
    ? `/admin/agents/${agentId}/capabilities`
    : `/admin/agents/${agentId}/capabilities/${capability}`;
  const res = await fetchFn(`${opts.apiUrl}${path}`, {
    method,
    headers: {
      "x-admin-key": opts.adminKey,
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    body: method === "POST" ? JSON.stringify({ capability }) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`API ${res.status}: ${text}`);
  return JSON.parse(text) as CapabilityResult;
}

function findPoolEntry(agentId: string, base?: string) {
  const entry = listPool(base).find(
    (p) => p.name === agentId || p.profile.agentId === agentId,
  );
  if (!entry) throw new Error(`no pool identity ${agentId}`);
  return entry;
}

export interface EnableGithubOptions extends CapabilityCallOptions {
  agentId: string;
  username?: string;
  credentialRef?: string;
  base?: string;
}

export interface EnableGithubResult {
  agentId: string;
  address?: string;
  capabilities: string[];
  github: GithubLink;
}

export async function enableGithub(opts: EnableGithubOptions): Promise<EnableGithubResult> {
  const entry = findPoolEntry(opts.agentId, opts.base);
  // Passthrough --username wins; otherwise reuse the profile's existing link.
  const link: GithubLink | undefined = opts.username
    ? { username: opts.username, ...(opts.credentialRef ? { credentialRef: opts.credentialRef } : {}) }
    : entry.profile.github;
  if (!link) throw new Error(`no GitHub username on file for ${opts.agentId}; pass --username`);
  const remoteId = entry.profile.agentId ?? entry.name;
  const { capabilities } = await callCapabilityRoute(opts, "POST", remoteId, "github");
  linkGithub(entry.name, link, opts.base);
  return { agentId: remoteId, address: entry.profile.address, capabilities, github: link };
}

export interface DisableGithubOptions extends CapabilityCallOptions {
  agentId: string;
  base?: string;
}

export async function disableGithub(
  opts: DisableGithubOptions,
): Promise<{ agentId: string; capabilities: string[] }> {
  const entry = findPoolEntry(opts.agentId, opts.base);
  const remoteId = entry.profile.agentId ?? entry.name;
  const { capabilities } = await callCapabilityRoute(opts, "DELETE", remoteId, "github");
  unlinkGithub(entry.name, opts.base);
  return { agentId: remoteId, capabilities };
}
