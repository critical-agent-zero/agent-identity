import type { ForgeProvisionResult } from "@agent-identity/shared";
import { ForgeError, type Author, type Provisioner } from "./forge.js";
import { gitlabServiceAccountUsername } from "./gitlab-names.js";

export interface ProvisionerConfig {
  adminToken(): Promise<string>;
  groupId(): Promise<string>;
}

export interface TokenSink {
  has(service: string, agentId: string): Promise<boolean>;
  put(service: string, agentId: string, token: string): Promise<void>;
}

export interface GitlabProvisionerOptions {
  config: ProvisionerConfig;
  sink: TokenSink;
  fetch?: typeof globalThis.fetch;
  apiBase?: string;
  now?: () => number;
}

interface ServiceAccount {
  id: number;
  username: string;
  email: string;
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export class GitlabProvisioner implements Provisioner {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly base: string;
  private readonly now: () => number;

  constructor(private readonly opts: GitlabProvisionerOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.base = opts.apiBase ?? "https://gitlab.com/api/v4";
    this.now = opts.now ?? Date.now;
  }

  private async gl<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: {
        "PRIVATE-TOKEN": token,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401) throw new ForgeError("upstream_auth", "gitlab rejected the admin token", 401);
      throw new ForgeError("invalid", `gitlab ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
    return res.json() as Promise<T>;
  }

  async provision(actor: Author): Promise<ForgeProvisionResult> {
    const token = await this.opts.config.adminToken();
    const gid = await this.opts.config.groupId();
    const username = gitlabServiceAccountUsername(actor.name);

    const accounts = await this.gl<ServiceAccount[]>(token, "GET", `/groups/${gid}/service_accounts`);
    let acct = accounts.find((a) => a.username === username);
    if (!acct) {
      acct = await this.gl<ServiceAccount>(token, "POST", `/groups/${gid}/service_accounts`, {
        name: `agent ${actor.name}`, username, email: actor.email,
      });
    }

    // Idempotent: once an identity holds a stored credential it is provisioned.
    // Re-minting would orphan the prior PAT (still live on GitLab, no longer
    // stored). To force a fresh token, delete the identity's SSM parameter.
    if (await this.opts.sink.has("gitlab", actor.name)) {
      return { username: acct.username, email: acct.email };
    }

    try {
      await this.gl(token, "POST", `/groups/${gid}/members`, {
        user_id: acct.id, access_level: 30,
      });
    } catch (err) {
      // Tolerate only "already a member" (409), gated on status — matching the
      // error body text would swallow genuine membership failures too.
      if (!(err instanceof ForgeError && err.upstream === 409)) throw err;
    }

    const expires = new Date(this.now() + YEAR_MS).toISOString().slice(0, 10);
    const pat = await this.gl<{ token?: string }>(token, "POST",
      `/groups/${gid}/service_accounts/${acct.id}/personal_access_tokens`, {
        name: "agent-identity-proxy", scopes: ["api"], expires_at: expires,
      });
    if (!pat.token) throw new ForgeError("invalid", "gitlab did not return a PAT");
    await this.opts.sink.put("gitlab", actor.name, pat.token);

    return { username: acct.username, email: acct.email };
  }
}
