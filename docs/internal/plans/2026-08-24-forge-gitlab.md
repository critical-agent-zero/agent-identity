# Forge Proxy — GitLab Adapter + Provisioning (PR 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a GitLab adapter and per-identity service-account provisioning to the forge access proxy shipped in PR1 (#29), and re-introduce the provisioning consumer surface that PR1 deliberately deferred.

**Architecture:** Same ports-and-adapters proxy. `GitlabForge` implements the existing `Forge` port (per-identity credentials via `CredentialStore.resolve`); `GitlabProvisioner` implements a re-introduced `Provisioner` port to create a GitLab group service account whose email is the agent's own mailbox, mint its PAT, and store it at the identity's SSM path. A capability-gated `POST /forge/:service/provision` route drives it.

**Context — the merged PR1 state this builds on (authoritative signatures):**
- `packages/proxy/src/forge.ts` — `Forge` port takes `actor: Author` on every method; `ForgeErrorKind` includes `forbidden` (403) and `not_provisioned` (403); `CredentialStore.resolve(service, agentId)`; NO `Provisioner` interface (removed in PR1 review — re-added in Task 15).
- `packages/proxy/src/ssm.ts` — `SsmCredentialStore` has `resolve(service, agentId)`, `getParam(name)`, and `put(service, agentId, token)`.
- `packages/proxy/src/policy.ts` — `ForgeOp.kind` is `"repo" | "commit" | "pr" | "comment"` (NO provision — added in Task 15); `evaluate(agent, op)`.
- `packages/proxy/src/app.ts` — `ProxyDeps` has `agents, nonces, forges, audit?` (NO provisioners — added in Task 16). `guard(c)` resolves the agent, then service/forge/capability, auditing rejections; `run(c, g, op, call)` audits denied/ok/error/unexpected. `createProxyApp` defines routes repo/commit/pr/comment.
- `packages/proxy/src/lambda.ts` — wires `forges: { github }` only.
- `packages/shared/src/types.ts` — has the forge DTOs but NOT `ForgeProvisionResult` (added in Task 15).

**Conventions:** every command runs from the repo root. Strict TypeScript: after each task's vitest gate passes and before committing, run `npx tsc --noEmit -p tsconfig.base.json` and confirm it is clean. Commit after every green step. Branch: `feat/forge-gitlab`.

---

### Task 15: Re-introduce provisioning types and seams

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/proxy/src/forge.ts`
- Modify: `packages/proxy/src/policy.ts`
- Test: `packages/proxy/src/forge.test.ts`

- [ ] **Step 1: Add the DTO to shared**

Append to the end of `packages/shared/src/types.ts`:

```ts
export interface ForgeProvisionResult {
  username: string;
  email: string;
}
```

- [ ] **Step 2: Add the Provisioner port to forge.ts**

In `packages/proxy/src/forge.ts`, extend the shared import to include `ForgeProvisionResult`:

```ts
import type {
  CommentResult, CommitResult, CommitSpec, ForgeProvisionResult, PrResult, PrSpec,
  RepoInfo, RepoRef,
} from "@agent-identity/shared";
```

and append at the end of the file:

```ts
export interface Provisioner {
  provision(actor: Author): Promise<ForgeProvisionResult>;
}
```

- [ ] **Step 3: Add the provision op kind**

In `packages/proxy/src/policy.ts`, change the `ForgeOp.kind` union to include `"provision"`:

```ts
  kind: "repo" | "commit" | "pr" | "comment" | "provision";
```

- [ ] **Step 4: Add a failing test for the Provisioner shape**

Append to `packages/proxy/src/forge.test.ts` a test that the interface is usable (this is a type-level seam; the test just constructs a value):

```ts
import type { Provisioner } from "./forge.js";

describe("Provisioner port", () => {
  it("is implementable and returns a ForgeProvisionResult", async () => {
    const p: Provisioner = {
      provision: async (actor) => ({ username: `agent-${actor.name}`, email: actor.email }),
    };
    expect(await p.provision({ name: "482913", email: "482913@d" }))
      .toEqual({ username: "agent-482913", email: "482913@d" });
  });
});
```

Add the `Provisioner` import to the existing top import if the file already imports from `./forge.js` (it imports `ForgeError, statusFor`); merge into that line instead of a duplicate import.

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm vitest run packages/proxy/src/forge.test.ts && npx tsc --noEmit -p tsconfig.base.json`
Expected: forge tests pass (3 tests); tsc clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types.ts packages/proxy/src/forge.ts packages/proxy/src/policy.ts packages/proxy/src/forge.test.ts
git commit -m "feat(proxy): re-introduce provisioning port and DTO deferred from PR1"
```

---

### Task 16: Provision route

**Files:**
- Modify: `packages/proxy/src/app.ts`
- Test: `packages/proxy/src/app.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `app.test.ts`)

```ts
describe("POST /forge/:service/provision", () => {
  it("provisions via the registered provisioner and audits", async () => {
    const provision = vi.fn(async () => ({ username: "agent-482913", email: "482913@agents.example" }));
    const { deps, audit } = makeDeps({
      agentOverride: { capabilities: ["github", "gitlab"] },
      forges: { github: new FakeForge(), gitlab: new FakeForge() },
      provisioners: { gitlab: { provision } },
    });
    const app = createProxyApp(deps);
    const path = "/forge/gitlab/provision";
    const res = await app.request(path, signed("POST", path));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: "agent-482913", email: "482913@agents.example" });
    expect(provision).toHaveBeenCalledWith({ name: "482913", email: "482913@agents.example" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "482913", service: "gitlab", op: "provision", outcome: "ok",
    }));
  });

  it("404s provisioning on a service without a provisioner", async () => {
    const { deps } = makeDeps();
    const app = createProxyApp(deps);
    const path = "/forge/github/provision";
    const res = await app.request(path, signed("POST", path));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("provisioning_unsupported");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/proxy/src/app.test.ts`
Expected: the two new tests FAIL.

- [ ] **Step 3: Add the provisioners field and the route**

In `packages/proxy/src/app.ts`, extend the forge import to include `Provisioner`:

```ts
import {
  ForgeError, statusFor, type Author, type Forge, type Provisioner,
} from "./forge.js";
```

Add the field to `ProxyDeps` (after `forges`):

```ts
  provisioners?: Record<string, Provisioner>;
```

Add the route inside `createProxyApp`, after the comment route and before `return app;`:

```ts
  app.post("/forge/:service/provision", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const provisioner = deps.provisioners?.[g.service];
    if (!provisioner) return c.json({ error: "provisioning_unsupported" }, 404);
    const op: ForgeOp = { service: g.service, kind: "provision", owner: "-", repo: "-" };
    return run(c, g, op, () => provisioner.provision(g.actor));
  });
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run packages/proxy/src/app.test.ts && npx tsc --noEmit -p tsconfig.base.json`
Expected: all app tests pass (14 tests); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/proxy/src/app.ts packages/proxy/src/app.test.ts
git commit -m "feat(proxy): capability-gated provision route"
```

---

### Task 17: GitLab adapter

**Files:**
- Create: `packages/proxy/src/gitlab.ts`
- Test: `packages/proxy/src/gitlab.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/proxy/src/gitlab.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "./forge.js";
import { GitlabForge } from "./gitlab.js";

const credentials: CredentialStore = { resolve: async () => "glpat-x" };
const actor = { name: "482913", email: "482913@agents.example" };

function makeFetch(routes: Record<string, { status?: number; json?: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const key = `${init.method ?? "GET"} ${url}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected fetch: ${key}`);
    return new Response(JSON.stringify(route.json ?? {}), { status: route.status ?? 200 });
  });
  return { fn: fn as unknown as typeof globalThis.fetch, calls };
}

const P = "https://gitlab.com/api/v4/projects/o%2Fr";

describe("GitlabForge.getRepo", () => {
  it("returns default branch and head sha, using PRIVATE-TOKEN auth for the actor", async () => {
    const resolve = vi.fn(async () => "glpat-x");
    const { fn, calls } = makeFetch({
      [`GET ${P}`]: { json: { default_branch: "main" } },
      [`GET ${P}/repository/branches/main`]: { json: { commit: { id: "abc123" } } },
    });
    const forge = new GitlabForge({ credentials: { resolve }, fetch: fn });
    const info = await forge.getRepo({ owner: "o", name: "r" }, actor);
    expect(info).toEqual({ defaultBranch: "main", headSha: "abc123" });
    expect(resolve).toHaveBeenCalledWith("gitlab", "482913");
    const h = new Headers(calls[0]!.init.headers);
    expect(h.get("PRIVATE-TOKEN")).toBe("glpat-x");
  });

  it("maps 401 to upstream_auth and 403 to forbidden", async () => {
    const a = makeFetch({ [`GET ${P}`]: { status: 401, json: { message: "401" } } });
    await expect(new GitlabForge({ credentials, fetch: a.fn }).getRepo({ owner: "o", name: "r" }, actor))
      .rejects.toMatchObject({ kind: "upstream_auth" });
    const b = makeFetch({ [`GET ${P}`]: { status: 403, json: { message: "403" } } });
    await expect(new GitlabForge({ credentials, fetch: b.fn }).getRepo({ owner: "o", name: "r" }, actor))
      .rejects.toMatchObject({ kind: "forbidden" });
  });
});

describe("GitlabForge.createCommit", () => {
  it("probes file existence to choose create vs update and forces the author", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${P}/repository/files/exists.txt?ref=main`]: { json: { file_path: "exists.txt" } },
      [`GET ${P}/repository/files/new.txt?ref=main`]: { status: 404, json: { message: "404" } },
      [`POST ${P}/repository/commits`]: {
        json: { id: "sha1", web_url: "https://gitlab.com/o/r/-/commit/sha1" },
      },
    });
    const forge = new GitlabForge({ credentials, fetch: fn });
    const result = await forge.createCommit({ owner: "o", name: "r" }, {
      branch: "main", message: "m",
      files: [{ path: "exists.txt", content: "A" }, { path: "new.txt", content: "B" }],
    }, actor);
    expect(result).toEqual({ sha: "sha1", url: "https://gitlab.com/o/r/-/commit/sha1" });
    const commitCall = calls.find((c) => c.url === `${P}/repository/commits`)!;
    expect(JSON.parse(commitCall.init.body as string)).toEqual({
      branch: "main", commit_message: "m",
      author_name: "482913", author_email: "482913@agents.example",
      actions: [
        { action: "update", file_path: "exists.txt", content: "A" },
        { action: "create", file_path: "new.txt", content: "B" },
      ],
    });
  });
});

describe("GitlabForge.openPullRequest and comment", () => {
  it("opens an MR (iid becomes number)", async () => {
    const { fn, calls } = makeFetch({
      [`POST ${P}/merge_requests`]: {
        json: { iid: 4, web_url: "https://gitlab.com/o/r/-/merge_requests/4" },
      },
    });
    const forge = new GitlabForge({ credentials, fetch: fn });
    const pr = await forge.openPullRequest({ owner: "o", name: "r" },
      { head: "feat/x", base: "main", title: "t", body: "d" }, actor);
    expect(pr).toEqual({ number: 4, url: "https://gitlab.com/o/r/-/merge_requests/4" });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      source_branch: "feat/x", target_branch: "main", title: "t", description: "d",
    });
  });

  it("comments as an issue note with a constructed url", async () => {
    const { fn } = makeFetch({
      [`POST ${P}/issues/12/notes`]: { json: { id: 55 } },
    });
    const forge = new GitlabForge({ credentials, fetch: fn });
    const c = await forge.comment({ owner: "o", name: "r" }, 12, "hi", actor);
    expect(c).toEqual({ id: 55, url: "https://gitlab.com/o/r/-/issues/12#note_55" });
  });
});
```

Note: `encodeURIComponent("exists.txt")` leaves dots intact, so the routing keys use plain `exists.txt` — the implementation must use plain `encodeURIComponent` for file paths.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/proxy/src/gitlab.test.ts`
Expected: FAIL — cannot resolve `./gitlab.js`.

- [ ] **Step 3: Write the adapter**

`packages/proxy/src/gitlab.ts`:

```ts
import type {
  CommentResult, CommitResult, CommitSpec, PrResult, PrSpec, RepoInfo, RepoRef,
} from "@agent-identity/shared";
import {
  ForgeError, type Author, type CredentialStore, type Forge,
} from "./forge.js";

export interface GitlabForgeOptions {
  credentials: CredentialStore;
  fetch?: typeof globalThis.fetch;
  apiBase?: string;   // default https://gitlab.com/api/v4
  webBase?: string;   // default https://gitlab.com
}

export class GitlabForge implements Forge {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly base: string;
  private readonly web: string;

  constructor(private readonly opts: GitlabForgeOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.base = opts.apiBase ?? "https://gitlab.com/api/v4";
    this.web = opts.webBase ?? "https://gitlab.com";
  }

  private project(ref: RepoRef): string {
    return encodeURIComponent(`${ref.owner}/${ref.name}`);
  }

  private async gl<T>(method: string, path: string, agentId: string, body?: unknown): Promise<T> {
    const token = await this.opts.credentials.resolve("gitlab", agentId);
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: {
        "PRIVATE-TOKEN": token,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await this.mapError(res);
    return res.json() as Promise<T>;
  }

  private async mapError(res: Response): Promise<ForgeError> {
    const text = await res.text();
    if (res.status === 401) return new ForgeError("upstream_auth", "gitlab rejected the credential", 401);
    if (res.status === 404) return new ForgeError("not_found", "not found on gitlab", 404);
    if (res.status === 403) return new ForgeError("forbidden", "gitlab forbade the operation for this credential", 403);
    if (res.status === 429) return new ForgeError("rate_limited", "gitlab rate limit", 429);
    return new ForgeError("invalid", `gitlab ${res.status}: ${text.slice(0, 200)}`, res.status);
  }

  private async fileExists(project: string, filePath: string, branch: string, agentId: string): Promise<boolean> {
    try {
      await this.gl("GET",
        `/projects/${project}/repository/files/${encodeURIComponent(filePath)}?ref=${branch}`,
        agentId);
      return true;
    } catch (err) {
      if (err instanceof ForgeError && err.kind === "not_found") return false;
      throw err;
    }
  }

  async getRepo(ref: RepoRef, actor: Author): Promise<RepoInfo> {
    const p = this.project(ref);
    const proj = await this.gl<{ default_branch: string }>("GET", `/projects/${p}`, actor.name);
    const branch = await this.gl<{ commit: { id: string } }>(
      "GET", `/projects/${p}/repository/branches/${proj.default_branch}`, actor.name);
    return { defaultBranch: proj.default_branch, headSha: branch.commit.id };
  }

  async createCommit(ref: RepoRef, spec: CommitSpec, actor: Author): Promise<CommitResult> {
    const p = this.project(ref);
    const actions = [];
    for (const f of spec.files) {
      const exists = await this.fileExists(p, f.path, spec.branch, actor.name);
      actions.push({ action: exists ? "update" : "create", file_path: f.path, content: f.content });
    }
    const commit = await this.gl<{ id: string; web_url: string }>(
      "POST", `/projects/${p}/repository/commits`, actor.name, {
        branch: spec.branch, commit_message: spec.message,
        author_name: actor.name, author_email: actor.email,
        actions,
      });
    return { sha: commit.id, url: commit.web_url };
  }

  async openPullRequest(ref: RepoRef, spec: PrSpec, actor: Author): Promise<PrResult> {
    const mr = await this.gl<{ iid: number; web_url: string }>(
      "POST", `/projects/${this.project(ref)}/merge_requests`, actor.name, {
        source_branch: spec.head, target_branch: spec.base,
        title: spec.title, description: spec.body,
      });
    return { number: mr.iid, url: mr.web_url };
  }

  async comment(ref: RepoRef, issue: number, body: string, actor: Author): Promise<CommentResult> {
    const note = await this.gl<{ id: number }>(
      "POST", `/projects/${this.project(ref)}/issues/${issue}/notes`, actor.name, { body });
    return {
      id: note.id,
      url: `${this.web}/${ref.owner}/${ref.name}/-/issues/${issue}#note_${note.id}`,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/proxy/src/gitlab.test.ts && npx tsc --noEmit -p tsconfig.base.json`
Expected: PASS (5 tests); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/proxy/src/gitlab.ts packages/proxy/src/gitlab.test.ts
git commit -m "feat(proxy): gitlab adapter — per-identity credentials, single-call commits, forbidden mapping"
```

---

### Task 18: GitLab provisioner

**Files:**
- Create: `packages/proxy/src/gitlab-provision.ts`
- Test: `packages/proxy/src/gitlab-provision.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/proxy/src/gitlab-provision.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { GitlabProvisioner } from "./gitlab-provision.js";

const actor = { name: "482913", email: "482913@agents.example" };
const G = "https://gitlab.com/api/v4/groups/42";

function makeFetch(routes: Record<string, { status?: number; json?: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const key = `${init.method ?? "GET"} ${url}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected fetch: ${key}`);
    return new Response(JSON.stringify(route.json ?? {}), { status: route.status ?? 200 });
  });
  return { fn: fn as unknown as typeof globalThis.fetch, calls };
}

function makeDeps(fetchFn: typeof globalThis.fetch) {
  const put = vi.fn(async () => {});
  const provisioner = new GitlabProvisioner({
    config: { adminToken: async () => "owner-tok", groupId: async () => "42" },
    sink: { put },
    fetch: fetchFn,
    now: () => Date.parse("2026-08-24T00:00:00Z"),
  });
  return { provisioner, put };
}

describe("GitlabProvisioner", () => {
  it("creates account, adds membership, mints PAT, stores it", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${G}/service_accounts`]: { json: [] },
      [`POST ${G}/service_accounts`]: {
        json: { id: 777, username: "agent-482913", email: "482913@agents.example" },
      },
      [`POST ${G}/members`]: { json: {} },
      [`POST ${G}/service_accounts/777/personal_access_tokens`]: { json: { token: "glpat-new" } },
    });
    const { provisioner, put } = makeDeps(fn);
    const result = await provisioner.provision(actor);
    expect(result).toEqual({ username: "agent-482913", email: "482913@agents.example" });
    expect(put).toHaveBeenCalledWith("gitlab", "482913", "glpat-new");
    const create = calls.find((c) => c.url === `${G}/service_accounts` && c.init.method === "POST")!;
    expect(JSON.parse(create.init.body as string)).toEqual({
      name: "agent 482913", username: "agent-482913", email: "482913@agents.example",
    });
    const member = calls.find((c) => c.url === `${G}/members`)!;
    expect(JSON.parse(member.init.body as string)).toEqual({ user_id: 777, access_level: 30 });
    const pat = calls.find((c) => c.url.endsWith("/personal_access_tokens"))!;
    expect(JSON.parse(pat.init.body as string)).toEqual({
      name: "agent-identity-proxy", scopes: ["api"], expires_at: "2027-08-24",
    });
    const h = new Headers(create.init.headers);
    expect(h.get("PRIVATE-TOKEN")).toBe("owner-tok");
  });

  it("is idempotent: reuses an existing account and tolerates existing membership", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${G}/service_accounts`]: {
        json: [{ id: 777, username: "agent-482913", email: "482913@agents.example" }],
      },
      [`POST ${G}/members`]: { status: 409, json: { message: "Member already exists" } },
      [`POST ${G}/service_accounts/777/personal_access_tokens`]: { json: { token: "glpat-2" } },
    });
    const { provisioner, put } = makeDeps(fn);
    const result = await provisioner.provision(actor);
    expect(result.username).toBe("agent-482913");
    expect(put).toHaveBeenCalledWith("gitlab", "482913", "glpat-2");
    expect(calls.some((c) => c.url === `${G}/service_accounts` && c.init.method === "POST")).toBe(false);
  });

  it("surfaces owner-token rejection as upstream_auth", async () => {
    const { fn } = makeFetch({
      [`GET ${G}/service_accounts`]: { status: 401, json: { message: "401" } },
    });
    const { provisioner } = makeDeps(fn);
    await expect(provisioner.provision(actor)).rejects.toMatchObject({ kind: "upstream_auth" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/proxy/src/gitlab-provision.test.ts`
Expected: FAIL — cannot resolve `./gitlab-provision.js`.

- [ ] **Step 3: Write the provisioner**

`packages/proxy/src/gitlab-provision.ts`:

```ts
import type { ForgeProvisionResult } from "@agent-identity/shared";
import { ForgeError, type Author, type Provisioner } from "./forge.js";

export interface ProvisionerConfig {
  adminToken(): Promise<string>;
  groupId(): Promise<string>;
}

export interface TokenSink {
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
    const username = `agent-${actor.name}`;

    const accounts = await this.gl<ServiceAccount[]>(token, "GET", `/groups/${gid}/service_accounts`);
    let acct = accounts.find((a) => a.username === username);
    if (!acct) {
      acct = await this.gl<ServiceAccount>(token, "POST", `/groups/${gid}/service_accounts`, {
        name: `agent ${actor.name}`, username, email: actor.email,
      });
    }

    try {
      await this.gl(token, "POST", `/groups/${gid}/members`, {
        user_id: acct.id, access_level: 30,
      });
    } catch (err) {
      if (!(err instanceof ForgeError && /member/i.test(err.message))) throw err;
    }

    const expires = new Date(this.now() + YEAR_MS).toISOString().slice(0, 10);
    const pat = await this.gl<{ token: string }>(token, "POST",
      `/groups/${gid}/service_accounts/${acct.id}/personal_access_tokens`, {
        name: "agent-identity-proxy", scopes: ["api"], expires_at: expires,
      });
    await this.opts.sink.put("gitlab", actor.name, pat.token);

    return { username: acct.username, email: acct.email };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/proxy/src/gitlab-provision.test.ts && npx tsc --noEmit -p tsconfig.base.json`
Expected: PASS (3 tests); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/proxy/src/gitlab-provision.ts packages/proxy/src/gitlab-provision.test.ts
git commit -m "feat(proxy): gitlab service-account provisioner — idempotent, mailbox email"
```

---

### Task 19: Consumer surface — client, MCP, skill

**Files:**
- Modify: `packages/client/src/client.ts`
- Modify: `packages/mcp/src/claim-manager.ts`
- Modify: `packages/mcp/src/tools.ts`
- Modify: `packages/mcp/src/server.ts`
- Modify: `packages/dist/skill/SKILL.md`
- Test: `packages/client/src/client.test.ts`, `packages/mcp/src/tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/client/src/client.test.ts` (inside the existing `describe("forge methods", ...)` block, before its closing `});`):

```ts
  it("forgeProvision posts to the provision path", async () => {
    const fetchMock = makeFetch({ username: "agent-482913", email: "482913@d" });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    const r = await client.forgeProvision("gitlab");
    expect(r).toEqual({ username: "agent-482913", email: "482913@d" });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.example/forge/gitlab/provision");
  });
```

Append to `packages/mcp/src/tools.test.ts` (inside the existing `describe("forge tools", ...)` block, before its closing `});`):

```ts
  it("forge_provision defaults to gitlab", async () => {
    const forgeProvision = vi.fn(async () => ({ username: "agent-1", email: "1@d" }));
    const tools = makeTools(managerWith({ forgeProvision }));
    const r = await tools.forgeProvision({});
    expect(r).toEqual({ username: "agent-1", email: "1@d" });
    expect(forgeProvision).toHaveBeenCalledWith("gitlab");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/client/src/client.test.ts packages/mcp/src/tools.test.ts`
Expected: the two new tests FAIL (`forgeProvision is not a function`).

- [ ] **Step 3: Add the client method**

In `packages/client/src/client.ts`, add `ForgeProvisionResult` to the shared import type list, and add this method after `forgeComment`:

```ts
  forgeProvision(service: string): Promise<ForgeProvisionResult> {
    return this.request("POST", `/forge/${service}/provision`);
  }
```

- [ ] **Step 4: Widen the MCP client interface**

In `packages/mcp/src/claim-manager.ts`, add `ForgeProvisionResult` to the shared import type list, and add this signature to the `AgentClientLike` interface after `forgeComment`:

```ts
  forgeProvision(service: string): Promise<ForgeProvisionResult>;
```

- [ ] **Step 5: Add the MCP tool implementation**

In `packages/mcp/src/tools.ts`, add to the object returned by `makeTools`, after `forgeComment`:

```ts
    async forgeProvision(args: { service?: string }) {
      try {
        return await manager.client().forgeProvision(args.service ?? "gitlab");
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
```

- [ ] **Step 6: Register the tool**

In `packages/mcp/src/server.ts`, add before the transport lines:

```ts
server.registerTool(
  "forge_provision",
  {
    description: "Provision this session's identity on a forge that supports it (default gitlab): creates a service account whose email is this identity's mailbox, then watch for the confirmation email with wait_for_email.",
    inputSchema: { service: z.string().optional() },
  },
  async (args) => json(await tools.forgeProvision(args)),
);
```

- [ ] **Step 7: Document it in the skill**

In `packages/dist/skill/SKILL.md`, replace the "Forge operations (via the access proxy)" paragraph with:

```markdown
## Forge operations (via the access proxy)

If this deployment runs the forge proxy and your identity has the service
capability (`github` or `gitlab`), five tools work: `forge_repo` (default
branch + head sha), `forge_commit` (create a commit — authorship is set
server-side to YOUR identity; you cannot and need not supply an author),
`forge_open_pr`, `forge_comment` (both append an attribution footer naming
your identity), and `forge_provision`. `service` defaults to `"github"`
(`forge_provision` defaults to `"gitlab"`). A `missing_capability` error
means this identity is not onboarded — relay the remediation text to the
human. A `not_provisioned` error on gitlab means: call `forge_provision`,
then `wait_for_email` for the GitLab confirmation mail and follow its
link. Force-push and branch deletion do not exist in this surface.
```

- [ ] **Step 8: Run tests + typecheck**

Run: `pnpm vitest run packages/client packages/mcp && npx tsc --noEmit -p tsconfig.base.json`
Expected: all pass; tsc clean.

- [ ] **Step 9: Commit**

```bash
git add packages/client/src/client.ts packages/client/src/client.test.ts packages/mcp/src/claim-manager.ts packages/mcp/src/tools.ts packages/mcp/src/tools.test.ts packages/mcp/src/server.ts packages/dist/skill/SKILL.md
git commit -m "feat(client,mcp): forgeProvision method and forge_provision tool"
```

---

### Task 20: Wiring + infra

**Files:**
- Modify: `packages/proxy/src/lambda.ts`
- Modify: `infra/lib/stack.ts`

- [ ] **Step 1: Wire the adapter and provisioner**

Replace the body of `packages/proxy/src/lambda.ts` with:

```ts
import { AgentsRepo, NoncesRepo } from "@agent-identity/api";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handle } from "hono/aws-lambda";
import { createProxyApp } from "./app.js";
import { GithubForge } from "./github.js";
import { GitlabForge } from "./gitlab.js";
import { GitlabProvisioner } from "./gitlab-provision.js";
import { SsmCredentialStore } from "./ssm.js";

const table = process.env.TABLE_NAME!;
const domain = process.env.MAIL_DOMAIN!;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const credentials = new SsmCredentialStore();

const app = createProxyApp({
  agents: new AgentsRepo(ddb, table, domain),
  nonces: new NoncesRepo(ddb, table),
  forges: {
    github: new GithubForge({ credentials }),
    gitlab: new GitlabForge({ credentials }),
  },
  provisioners: {
    gitlab: new GitlabProvisioner({
      config: {
        adminToken: () => credentials.getParam("/agent-identity/forge/gitlab/admin-token"),
        groupId: () => credentials.getParam("/agent-identity/forge/gitlab/group"),
      },
      sink: credentials,
    }),
  },
});

export const handler = handle(app);
```

- [ ] **Step 2: Grant PutParameter on the per-identity PAT prefix**

In `infra/lib/stack.ts`, immediately after the existing `proxyFn.addToRolePolicy(... "ssm:GetParameter" ...)` block, add:

```ts
    proxyFn.addToRolePolicy(new PolicyStatement({
      actions: ["ssm:PutParameter"],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/agent-identity/forge/gitlab/pat/*`,
      ],
    }));
```

- [ ] **Step 3: Typecheck + synth**

Run: `npx tsc --noEmit -p tsconfig.base.json`
Expected: clean.

Run: `cd infra && pnpm exec cdk synth -c domain=ci.invalid > /dev/null; echo "exit: $?"; cd ..`
Expected: `exit: 0`.

- [ ] **Step 4: Commit**

```bash
git add packages/proxy/src/lambda.ts infra/lib/stack.ts
git commit -m "feat(infra): wire gitlab adapter and provisioner; scoped PutParameter grant"
```

---

### Task 21: Full verification (controller)

- [ ] Run `pnpm vitest run` (all pass), `npx tsc --noEmit -p tsconfig.base.json` (clean), `cd infra && pnpm exec cdk synth -c domain=ci.invalid > /dev/null; echo $?` (0).
- [ ] Two-stage review over the branch diff, fix findings.
- [ ] Push `feat/forge-gitlab`, open PR 2.

## Post-merge operator steps (manual, not code)

1. GitLab: create a top-level group; mint a group **Owner** token; store `/agent-identity/forge/gitlab/admin-token` (SecureString) and `/agent-identity/forge/gitlab/group` (String, the numeric group id).
2. Approve the production deploy.
3. Tag identities: `mailctl agent tag <id> gitlab`.
4. Agent self-onboarding: `forge_provision` → `wait_for_email` (GitLab confirmation) → follow link → `forge_repo` smoke test.
