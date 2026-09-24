import { createSign } from "node:crypto";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { ForgeError, type CredentialStore } from "./forge.js";

const TTL_MS = 300_000;
// Refresh the installation token this far before its stated expiry so a
// commit flow never races the 1h expiry mid-request.
const TOKEN_SKEW_MS = 60_000;

export class SsmCredentialStore implements CredentialStore {
  private readonly cache = new Map<string, { value: string; at: number }>();
  // In-memory GitHub App installation token, shared across identities (the
  // token is per-installation, not per-agent). Refreshed near expiry.
  private appToken?: { token: string; refreshAt: number };

  constructor(
    private readonly basePath: string = "/agent-identity/forge",
    private readonly ssm: Pick<SSMClient, "send"> = new SSMClient({}),
    private readonly now: () => number = Date.now,
    private readonly fetchFn: typeof globalThis.fetch = globalThis.fetch,
    private readonly apiBase: string = "https://api.github.com",
  ) {}

  private async tryGet(name: string): Promise<string | undefined> {
    try {
      const res = await this.ssm.send(new GetParameterCommand({
        Name: name, WithDecryption: true,
      })) as { Parameter?: { Value?: string } };
      return res.Parameter?.Value;
    } catch (err) {
      if ((err as Error).name === "ParameterNotFound") return undefined;
      throw err;
    }
  }

  async getParam(name: string): Promise<string> {
    const value = await this.tryGet(name);
    if (!value) throw new Error(`missing SSM parameter ${name}`);
    return value;
  }

  async resolve(service: string, agentId: string): Promise<string> {
    const cacheKey = `${service}/${agentId}`;
    const hit = this.cache.get(cacheKey);
    if (hit && this.now() - hit.at < TTL_MS) return hit.value;
    const value = await this.tryGet(`${this.basePath}/${service}/pat/${agentId}`)
      ?? await this.tryGet(`${this.basePath}/${service}/pat`);
    if (!value) {
      throw new ForgeError("not_provisioned",
        `no credential for ${service}; provision this identity first (POST /forge/${service}/provision)`);
    }
    this.cache.set(cacheKey, { value, at: this.now() });
    return value;
  }

  /** Credential for the COMMIT write path. For github, an App installation
   *  token when the app is configured (GitHub then verified-signs the
   *  commit); otherwise the PAT (unsigned, unchanged). */
  async resolveCommitToken(service: string, agentId: string): Promise<string> {
    if (service === "github") {
      const appToken = await this.githubInstallationToken();
      if (appToken) return appToken;
    }
    return this.resolve(service, agentId);
  }

  /** Undefined when no App is configured (caller falls back to the PAT).
   *  Throws (fail-closed) when the App is only PARTIALLY configured — a
   *  half-set signer must never silently emit unsigned commits. */
  private async githubInstallationToken(): Promise<string | undefined> {
    // Hot path: a live cached token needs no SSM reads and no exchange.
    if (this.appToken && this.now() < this.appToken.refreshAt) return this.appToken.token;

    const [appId, installationId, privateKey] = await Promise.all([
      this.tryGet(`${this.basePath}/github/app-id`),
      this.tryGet(`${this.basePath}/github/installation-id`),
      this.tryGet(`${this.basePath}/github/app-private-key`),
    ]);
    const present = [appId, installationId, privateKey].filter(Boolean).length;
    if (present === 0) return undefined; // no App → PAT fallback (unsigned)
    if (present < 3) {
      throw new ForgeError("upstream_auth",
        "github app signing is partially configured; set app-id, installation-id, and "
        + "app-private-key (or clear all three) — refusing to fall back to unsigned commits");
    }
    return this.mintInstallationToken(appId!, installationId!, privateKey!);
  }

  private async mintInstallationToken(
    appId: string, installationId: string, privateKey: string,
  ): Promise<string> {
    const jwt = this.buildAppJwt(appId, privateKey);
    let res: Response;
    try {
      res = await this.fetchFn(
        `${this.apiBase}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
        { method: "POST", headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json" } },
      );
    } catch {
      // Never surface the JWT/key — a network error message could echo the URL/body.
      throw new ForgeError("upstream_auth", "github app installation token exchange failed");
    }
    if (!res.ok) {
      throw new ForgeError("upstream_auth",
        `github app installation token exchange rejected (status ${res.status})`, res.status);
    }
    const data = await res.json() as { token?: string; expires_at?: string };
    if (!data.token) {
      throw new ForgeError("upstream_auth", "github app installation token response had no token");
    }
    const expiresAtMs = data.expires_at ? Date.parse(data.expires_at) : NaN;
    const refreshAt = Number.isFinite(expiresAtMs)
      ? expiresAtMs - TOKEN_SKEW_MS
      : this.now() + (3_600_000 - TOKEN_SKEW_MS);
    this.appToken = { token: data.token, refreshAt };
    return data.token;
  }

  /** GitHub App JWT (RS256), <10min lifetime, iat back-dated 60s for clock
   *  skew. node:crypto only — no dependency. The signing input and key never
   *  leave this method. */
  private buildAppJwt(appId: string, privateKey: string): string {
    const nowSec = Math.floor(this.now() / 1000);
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const signingInput = `${enc({ alg: "RS256", typ: "JWT" })}.`
      + `${enc({ iat: nowSec - 60, exp: nowSec + 540, iss: appId })}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(privateKey).toString("base64url");
    return `${signingInput}.${signature}`;
  }

  async has(service: string, agentId: string): Promise<boolean> {
    return (await this.tryGet(`${this.basePath}/${service}/pat/${agentId}`)) !== undefined;
  }

  async put(service: string, agentId: string, token: string): Promise<void> {
    await this.ssm.send(new PutParameterCommand({
      Name: `${this.basePath}/${service}/pat/${agentId}`,
      Value: token, Type: "SecureString", Overwrite: true,
    }));
    this.cache.delete(`${service}/${agentId}`);
  }
}
