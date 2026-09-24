import type {
  BlobResult, BlobSpec, CommentResult, CommitChangesSpec, CommitResult, CommitSpec,
  ForgeProvisionResult, ForkResult, PrResult, PrSpec,
  RepoInfo, RepoRef, RepoVisibility,
} from "@agent-identity/shared";

/** The acting identity: name is the agentId, email its mailbox address.
 *  Constructed by the core from the authenticated agent record only. */
export interface Author {
  name: string;
  email: string;
}

export type ForgeErrorKind =
  | "not_found" | "forbidden" | "non_fast_forward" | "rate_limited"
  | "upstream_auth" | "invalid" | "not_provisioned";

const STATUS: Record<ForgeErrorKind, number> = {
  not_found: 404,
  forbidden: 403,
  non_fast_forward: 409,
  rate_limited: 429,
  upstream_auth: 502,
  invalid: 400,
  not_provisioned: 403,
};

export const statusFor = (kind: ForgeErrorKind): number => STATUS[kind];

export class ForgeError extends Error {
  constructor(
    public readonly kind: ForgeErrorKind,
    message: string,
    public readonly upstream?: number,
  ) {
    super(message);
  }
}

/** The hexagon's outbound port. Every operation executes AS an identity:
 *  actor is supplied by the core from the authenticated record — adapters
 *  must never accept caller-controlled authorship, and per-identity
 *  adapters (gitlab) resolve the actor's own credential from actor.name. */
export interface Forge {
  getRepo(ref: RepoRef, actor: Author): Promise<RepoInfo>;
  createCommit(ref: RepoRef, spec: CommitSpec, actor: Author): Promise<CommitResult>;
  /** Upload one file's bytes as a blob and return its sha (#118). Streaming
   *  path: the caller uploads each file separately so no single request
   *  carries the whole change. Policy-gated identically to a commit — a
   *  rejected target must create NOTHING. GitLab carries content inline in
   *  the commit and rejects this as unsupported. */
  putBlob(ref: RepoRef, spec: BlobSpec, actor: Author): Promise<BlobResult>;
  /** Size-agnostic commit (#118): a tree/actions-based commit over a set of
   *  changes (pre-uploaded blobs, inline content, or deletions). Authorship
   *  is FORCED to the actor exactly as createCommit; branch auto-create and
   *  the fork-namespace pin are unchanged. */
  commitChanges(ref: RepoRef, spec: CommitChangesSpec, actor: Author): Promise<CommitResult>;
  openPullRequest(ref: RepoRef, spec: PrSpec, actor: Author): Promise<PrResult>;
  comment(ref: RepoRef, issue: number, body: string, actor: Author): Promise<CommentResult>;
  fork(ref: RepoRef, actor: Author): Promise<ForkResult>;
  /** The repo's ACTUAL visibility on the forge right now. Adapters answer
   *  "public" ONLY for a world-readable repo; private, internal, and
   *  malformed upstream payloads all collapse to "private". The proxy uses
   *  this to stamp attested forge events — the public fleet tier shows a
   *  forge event only when that stamp is exactly "public", so a name
   *  allowlist (owner/*) can never publish a private repo. */
  repoVisibility(ref: RepoRef, actor: Author): Promise<RepoVisibility>;
}

export interface CredentialStore {
  /** Per-identity parameter first, shared fallback; throws
   *  ForgeError("not_provisioned") when neither exists. */
  resolve(service: string, agentId: string): Promise<string>;
}

export interface Provisioner {
  provision(actor: Author): Promise<ForgeProvisionResult>;
}
