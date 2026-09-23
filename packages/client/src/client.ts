import {
  canonicalString, sign, type ActivityEvent, type AgentIdentity, type AgentStatusState,
  type AgentStatusView, type CommentResult, type CommitResult,
  type CommitSpec, type EmailFull, type EmailSummary, type ForgeProvisionResult,
  type ForkResult, type Keypair, type PrResult, type PrSpec, type RepoInfo, type RepoRef,
} from "@agent-identity/shared";

/** GET /me: identity plus operator-set capabilities and, when one has been
 *  recorded, the agent's own claimed status with server-computed freshness. */
export interface MeResponse extends AgentIdentity {
  capabilities?: string[];
  status?: AgentStatusView;
}

export interface ClientOptions {
  apiUrl: string;
  keypair: Keypair;
  fleetKey?: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
}

// 429 retry policy: throttling is default and the bucket is shared across
// agents, so brief bursts are expected. Max 2 retries keeps worst-case
// latency bounded; Retry-After (seconds, capped) wins over the jittered
// backoff when the server sends it.
const MAX_RETRIES_429 = 2;

export class AgentIdentityClient {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: ClientOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async request<T>(method: string, pathWithQuery: string, body = "", extra: Record<string, string> = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      // Sign inside the loop: each attempt needs a fresh timestamp to pass
      // the server's signature-freshness check.
      const timestamp = new Date().toISOString();
      const signature = sign(
        canonicalString(method, pathWithQuery, timestamp, body),
        this.opts.keypair.privateKeyPem,
      );
      const res = await this.fetchFn(`${this.opts.apiUrl}${pathWithQuery}`, {
        method,
        body: body || undefined,
        headers: {
          "x-agent-key": this.opts.keypair.publicKeySpkiBase64,
          "x-agent-timestamp": timestamp,
          "x-agent-signature": signature,
          ...(body ? { "content-type": "application/json" } : {}),
          ...extra,
        },
      });
      if (res.status === 429 && attempt < MAX_RETRIES_429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const delayMs = retryAfter > 0
          ? Math.min(retryAfter, 30) * 1000
          : 500 * (attempt + 1) + Math.random() * 250;
        await this.sleep(delayMs);
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`API ${res.status}: ${text}`);
      return JSON.parse(text) as T;
    }
  }

  register(): Promise<AgentIdentity> {
    return this.request("POST", "/register", "",
      this.opts.fleetKey ? { "x-fleet-key": this.opts.fleetKey } : {});
  }

  me(): Promise<MeResponse> {
    return this.request("GET", "/me");
  }

  /** CLAIMED self-report: sets this agent's public status. The server stores
   *  it as class "claimed" — it is never presented as attested. */
  setStatus(state: AgentStatusState, label?: string): Promise<{ event: ActivityEvent }> {
    return this.request("POST", "/activity",
      JSON.stringify({ type: "status", state, ...(label !== undefined ? { label } : {}) }));
  }

  /** CLAIMED self-report: appends a short public task note to the ledger. */
  reportTaskNote(note: string): Promise<{ event: ActivityEvent }> {
    return this.request("POST", "/activity", JSON.stringify({ type: "task_note", note }));
  }

  myActivity(opts: { limit?: number; cursor?: string } = {}):
    Promise<{ events: ActivityEvent[]; cursor?: string }> {
    const q = new URLSearchParams();
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.cursor) q.set("cursor", opts.cursor);
    const qs = q.toString();
    return this.request("GET", `/agents/me/activity${qs ? `?${qs}` : ""}`);
  }

  listEmails(opts: {
    since?: string; limit?: number; cursor?: string;
    includeUnsolicited?: boolean; includeUnauthenticated?: boolean;
  } = {}): Promise<{ emails: EmailSummary[]; cursor?: string }> {
    const q = new URLSearchParams();
    if (opts.since) q.set("since", opts.since);
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.cursor) q.set("cursor", opts.cursor);
    if (opts.includeUnsolicited) q.set("includeUnsolicited", "true");
    if (opts.includeUnauthenticated) q.set("includeUnauthenticated", "true");
    const qs = q.toString();
    return this.request("GET", `/emails${qs ? `?${qs}` : ""}`);
  }

  getEmail(id: string): Promise<EmailFull> {
    return this.request("GET", `/emails/${id}`);
  }

  forgeRepo(service: string, ref: RepoRef): Promise<RepoInfo> {
    return this.request("GET", `/forge/${service}/repo/${ref.owner}/${ref.name}`);
  }

  forgeCommit(service: string, ref: RepoRef, spec: CommitSpec): Promise<CommitResult> {
    return this.request("POST", `/forge/${service}/commit`,
      JSON.stringify({ owner: ref.owner, repo: ref.name, ...spec }));
  }

  forgeOpenPr(service: string, ref: RepoRef, spec: PrSpec): Promise<PrResult> {
    return this.request("POST", `/forge/${service}/pr`,
      JSON.stringify({ owner: ref.owner, repo: ref.name, ...spec }));
  }

  forgeComment(service: string, ref: RepoRef, issue: number, body: string): Promise<CommentResult> {
    return this.request("POST", `/forge/${service}/comment`,
      JSON.stringify({ owner: ref.owner, repo: ref.name, issue, body }));
  }

  forgeFork(service: string, ref: RepoRef): Promise<ForkResult> {
    return this.request("POST", `/forge/${service}/fork`,
      JSON.stringify({ owner: ref.owner, repo: ref.name }));
  }

  forgeProvision(service: string): Promise<ForgeProvisionResult> {
    return this.request("POST", `/forge/${service}/provision`);
  }
}
