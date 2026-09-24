import type {
  BlobResult, BlobSpec, CommentResult, CommitChangesSpec, CommitResult, CommitSpec,
  ForkResult, PrResult, PrSpec, RepoInfo, RepoRef,
  RepoVisibility,
} from "@agent-identity/shared";
import {
  ForgeError, type Author, type CredentialStore, type Forge,
} from "./forge.js";

export interface GithubForgeOptions {
  credentials: CredentialStore;
  fetch?: typeof globalThis.fetch;
  apiBase?: string;
}

export class GithubForge implements Forge {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly base: string;

  constructor(private readonly opts: GithubForgeOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.base = opts.apiBase ?? "https://api.github.com";
  }

  /** `commit: true` selects the COMMIT write-path token (a GitHub App
   *  installation token when configured — GitHub verified-signs the commit,
   *  issue #120); every other call uses the PAT via resolve(). */
  private async gh<T>(
    method: string, path: string, agentId: string, body?: unknown, commit = false,
  ): Promise<T> {
    const token = commit
      ? await this.opts.credentials.resolveCommitToken("github", agentId)
      : await this.opts.credentials.resolve("github", agentId);
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await this.mapError(res);
    return res.json() as Promise<T>;
  }

  private async mapError(res: Response): Promise<ForgeError> {
    const text = await res.text();
    if (res.status === 401) return new ForgeError("upstream_auth", "github rejected the credential", 401);
    if (res.status === 404) return new ForgeError("not_found", "not found on github", 404);
    if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0"))
      return new ForgeError("rate_limited", "github rate limit exhausted", res.status);
    // A non-rate-limit 403 is a permission problem (missing scope / no repo
    // access), not a malformed request — keep it distinct from `invalid`.
    if (res.status === 403)
      return new ForgeError("forbidden", "github forbade the operation for this credential", 403);
    if (res.status === 422 && /fast forward/i.test(text))
      return new ForgeError("non_fast_forward", "ref update is not a fast forward", 422);
    return new ForgeError("invalid", `github ${res.status}: ${text.slice(0, 200)}`, res.status);
  }

  /** GitHub has no nested namespaces: owner and repo are each ONE path
   *  segment. Enforced here because ref values are interpolated into request
   *  paths, where fetch's WHATWG URL normalization would let a separator,
   *  dot segment, or "%" escape the policy-pinned fork repo. */
  private repoPath(ref: RepoRef): string {
    const segment = /^[A-Za-z0-9_.-]+$/;
    if (!segment.test(ref.owner) || !segment.test(ref.name)
      || /^\.+$/.test(ref.owner) || /^\.+$/.test(ref.name)) {
      throw new ForgeError("invalid", "owner and repo must each be a single path segment", 400);
    }
    return `/repos/${ref.owner}/${ref.name}`;
  }

  async getRepo(ref: RepoRef, actor: Author): Promise<RepoInfo> {
    const r = this.repoPath(ref);
    const repo = await this.gh<{ default_branch: string }>("GET", r, actor.name);
    const head = await this.gh<{ object: { sha: string } }>(
      "GET", `${r}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`, actor.name);
    return { defaultBranch: repo.default_branch, headSha: head.object.sha };
  }

  /** Head sha of the branch, auto-creating it when missing (issue #93):
   *  the ref is created from THIS repo's default-branch head — never the
   *  source repo's — so a fresh fork needs no raw-PAT branch setup. Runs
   *  only inside createCommit, which the proxy policy-gates before any call. */
  private async resolveBranchHead(r: string, branch: string, agentId: string): Promise<string> {
    // Encoded so the branch stays ONE path unit: an unencoded branch would
    // let dot segments re-target the ref URLs outside `r` (fetch normalizes
    // them before the request leaves the process).
    const ref = `${r}/git/ref/heads/${encodeURIComponent(branch)}`;
    try {
      const head = await this.gh<{ object: { sha: string } }>("GET", ref, agentId, undefined, true);
      return head.object.sha;
    } catch (err) {
      if (!(err instanceof ForgeError && err.kind === "not_found")) throw err;
    }
    // An empty repo (fresh fork still importing) 404s here — the existing
    // retryable not_found, not a new error class.
    const repo = await this.gh<{ default_branch: string }>("GET", r, agentId, undefined, true);
    const def = await this.gh<{ object: { sha: string } }>(
      "GET", `${r}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`, agentId, undefined, true);
    try {
      await this.gh("POST", `${r}/git/refs`, agentId,
        { ref: `refs/heads/${branch}`, sha: def.object.sha }, true);
      return def.object.sha;
    } catch (err) {
      // The ref appeared between check and create — commit onto it as-is.
      if (err instanceof ForgeError && err.upstream === 422 && /already exists/i.test(err.message)) {
        const head = await this.gh<{ object: { sha: string } }>("GET", ref, agentId, undefined, true);
        return head.object.sha;
      }
      throw err;
    }
  }

  /** One tree entry as the git-data API expects it. An add/modify sets
   *  either `content` (inline UTF-8) or `sha` (a pre-uploaded blob); a
   *  deletion sets `sha: null`, which removes the path from the base tree. */
  private static entry(
    e: { path: string; content?: string; sha?: string | null },
  ): Record<string, unknown> {
    return { mode: "100644", type: "blob", ...e };
  }

  /** The single tree→commit→ref write path shared by createCommit (inline
   *  small path) and commitChanges (size-agnostic). CRITICAL: repoPath() has
   *  already validated owner/repo and the proxy has already run the
   *  fork-namespace policy + app-layer name/branch validation BEFORE this is
   *  reached — no blob/tree/commit/ref write happens for a rejected target. */
  private async commitTree(
    r: string, branch: string, message: string,
    entries: { path: string; content?: string; sha?: string | null }[],
    actor: Author,
  ): Promise<CommitResult> {
    const headSha = await this.resolveBranchHead(r, branch, actor.name);
    const baseCommit = await this.gh<{ tree: { sha: string } }>(
      "GET", `${r}/git/commits/${headSha}`, actor.name, undefined, true);
    const tree = await this.gh<{ sha: string }>("POST", `${r}/git/trees`, actor.name, {
      base_tree: baseCommit.tree.sha,
      tree: entries.map((e) => GithubForge.entry(e)),
    }, true);
    // Only `author` is set to the acting identity; `committer` is left to the
    // commit-path token's account. Under a GitHub App installation token
    // GitHub verified-signs the commit as the app (issue #120) while author
    // stays the identity — that split is the attribution model, not an
    // oversight. With no app configured this is the PAT (unsigned), unchanged.
    const commit = await this.gh<{ sha: string; html_url: string }>(
      "POST", `${r}/git/commits`, actor.name, {
        message, tree: tree.sha, parents: [headSha],
        author: { name: actor.name, email: actor.email },
      }, true);
    await this.gh("PATCH", `${r}/git/refs/heads/${encodeURIComponent(branch)}`, actor.name,
      { sha: commit.sha, force: false }, true);
    return { sha: commit.sha, url: commit.html_url };
  }

  async createCommit(ref: RepoRef, spec: CommitSpec, actor: Author): Promise<CommitResult> {
    const r = this.repoPath(ref);
    return this.commitTree(r, spec.branch, spec.message,
      spec.files.map((f) => ({ path: f.path, content: f.content })), actor);
  }

  async putBlob(ref: RepoRef, spec: BlobSpec, actor: Author): Promise<BlobResult> {
    // repoPath() pins owner/repo to a single segment BEFORE the write — a
    // blob for an off-namespace target is refused by the proxy policy first,
    // and a malformed ref never leaves the process.
    const r = this.repoPath(ref);
    const blob = await this.gh<{ sha: string }>("POST", `${r}/git/blobs`, actor.name, {
      content: spec.contentBase64, encoding: "base64",
    }, true);
    return { sha: blob.sha };
  }

  async commitChanges(ref: RepoRef, spec: CommitChangesSpec, actor: Author): Promise<CommitResult> {
    const r = this.repoPath(ref);
    const entries = spec.changes.map((c) => {
      if ("deleted" in c) return { path: c.path, sha: null };
      if ("blobSha" in c) return { path: c.path, sha: c.blobSha };
      return { path: c.path, content: c.content };
    });
    return this.commitTree(r, spec.branch, spec.message, entries, actor);
  }

  async openPullRequest(ref: RepoRef, spec: PrSpec, actor: Author): Promise<PrResult> {
    const pr = await this.gh<{ number: number; html_url: string }>(
      "POST", `${this.repoPath(ref)}/pulls`, actor.name, {
        title: spec.title, head: spec.head, base: spec.base, body: spec.body,
      });
    return { number: pr.number, url: pr.html_url };
  }

  async comment(ref: RepoRef, issue: number, body: string, actor: Author): Promise<CommentResult> {
    const c = await this.gh<{ id: number; html_url: string }>(
      "POST", `${this.repoPath(ref)}/issues/${issue}/comments`, actor.name, { body });
    return { id: c.id, url: c.html_url };
  }

  async fork(ref: RepoRef, actor: Author): Promise<ForkResult> {
    const f = await this.gh<{ name: string; owner: { login: string }; default_branch: string }>(
      "POST", `${this.repoPath(ref)}/forks`, actor.name);
    return { owner: f.owner.login, repo: f.name, defaultBranch: f.default_branch };
  }

  async repoVisibility(ref: RepoRef, actor: Author): Promise<RepoVisibility> {
    const r = await this.gh<{ private?: boolean; visibility?: string }>(
      "GET", this.repoPath(ref), actor.name);
    // "public" only when the payload AFFIRMS world-readability: private must
    // be exactly false, and any `visibility` field (GHES adds "internal")
    // must be exactly "public" when present. Anything else — including a
    // malformed payload — proves nothing and reads as private.
    return r.private === false && (r.visibility === undefined || r.visibility === "public")
      ? "public" : "private";
  }
}
