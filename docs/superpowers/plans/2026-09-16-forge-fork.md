# Forge Proxy — Fork Operation + Fork-Namespace Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Support the fork-and-PR contribution model in the forge proxy: agents fork a source repo, commit to their fork, and open PRs/MRs back to the source — never writing to the source repo. Add a `forge_fork` operation to both adapters, and a deterministic proxy policy that refuses commits targeting anything but the identity's fork namespace.

**Why:** Agents should not hold write access to source repos. The credential is scoped to the bot's fork namespace (its own repos); this plan adds (a) the missing fork operation, and (b) a server-side guard so "no source write" is enforced by the proxy, not just by credential scope.

**Context — authoritative current signatures (post PR #29/#30, merged):**
- `packages/proxy/src/forge.ts` — `Forge` port: `getRepo/createCommit/openPullRequest/comment`, each takes `actor: Author`. `ForgeErrorKind` includes `forbidden`. `CredentialStore.resolve(service, agentId)`.
- `packages/proxy/src/policy.ts` — `ForgeOp { service, kind: "repo"|"commit"|"pr"|"comment"|"provision", owner, repo }`; `PolicyDecision`; `evaluate(agent, op)` returns `{allow:true}`.
- `packages/proxy/src/app.ts` — `ProxyDeps { agents, nonces, forges, provisioners?, audit? }`; `run()` calls `evaluate(g.agent, op)` directly; routes repo/commit/pr/comment/provision; helpers `isStr`, `isFiles`.
- `packages/proxy/src/app.test.ts` — exports `FakeForge` (implements `Forge`) and `makeDeps`.
- `packages/proxy/src/github.ts` / `gitlab.ts` — adapters with a private `gh`/`gl` request helper; `github.ts` uses `credentials.resolve("github", actor.name)`, `gitlab.ts` uses `project(ref)=encodeURIComponent(owner/name)` and `resolve("gitlab", actor.name)`.
- `packages/proxy/src/lambda.ts` — wires `forges: { github, gitlab }`, `provisioners: { gitlab }`.
- `infra/lib/stack.ts` — `proxyFn` uses `...fnDefaults` (which sets `environment: commonEnv`).

**Conventions:** commands from repo root. A task is done only when its vitest gate passes AND `npx tsc --noEmit -p tsconfig.base.json` is clean. Commit after each task. Branch `feat/forge-fork`. **Ordering matters:** the `Forge` interface gains `fork` only in Task 4, after both adapters (Tasks 2–3) already implement it, so tsc stays green at every commit.

---

### Task 1: ForkResult DTO + fork op kind

**Files:** Modify `packages/shared/src/types.ts`, `packages/proxy/src/policy.ts`.

- [ ] **Step 1:** Append to `packages/shared/src/types.ts`:

```ts
export interface ForkResult {
  owner: string;
  repo: string;
  defaultBranch: string;
}
```

- [ ] **Step 2:** In `packages/proxy/src/policy.ts`, add `"fork"` to `ForgeOp.kind`:

```ts
  kind: "repo" | "commit" | "pr" | "comment" | "provision" | "fork";
```

- [ ] **Step 3:** `npx tsc --noEmit -p tsconfig.base.json` (clean) and `pnpm vitest run packages/proxy packages/shared` (all pass).

- [ ] **Step 4:** Commit:

```bash
git add packages/shared/src/types.ts packages/proxy/src/policy.ts
git commit -m "feat(proxy): ForkResult DTO and fork op kind"
```

---

### Task 2: GitHub adapter fork()

**Files:** Modify `packages/proxy/src/github.ts`, `packages/proxy/src/github.test.ts`.

- [ ] **Step 1: Failing test** — append to `github.test.ts`:

```ts
describe("GithubForge.fork", () => {
  it("forks under the credential account and returns the fork coordinates", async () => {
    const { fn, calls } = makeFetch({
      [`POST ${B}/forks`]: {
        json: { name: "r", owner: { login: "critical-agent-zero" }, default_branch: "main" },
      },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    const fork = await forge.fork({ owner: "o", name: "r" }, actor);
    expect(fork).toEqual({ owner: "critical-agent-zero", repo: "r", defaultBranch: "main" });
    expect(calls[0]!.init.method).toBe("POST");
  });
});
```

- [ ] **Step 2:** Run `pnpm vitest run packages/proxy/src/github.test.ts` → the new test FAILS (`forge.fork is not a function`).

- [ ] **Step 3:** In `github.ts`, add `ForkResult` to the shared type import, and add this method to the `GithubForge` class (after `comment`):

```ts
  async fork(ref: RepoRef, actor: Author): Promise<ForkResult> {
    const f = await this.gh<{ name: string; owner: { login: string }; default_branch: string }>(
      "POST", `/repos/${ref.owner}/${ref.name}/forks`, actor.name);
    return { owner: f.owner.login, repo: f.name, defaultBranch: f.default_branch };
  }
```

- [ ] **Step 4:** `pnpm vitest run packages/proxy/src/github.test.ts && npx tsc --noEmit -p tsconfig.base.json` → pass + clean.

- [ ] **Step 5:** Commit:

```bash
git add packages/proxy/src/github.ts packages/proxy/src/github.test.ts
git commit -m "feat(proxy): github adapter fork()"
```

---

### Task 3: GitLab adapter fork()

**Files:** Modify `packages/proxy/src/gitlab.ts`, `packages/proxy/src/gitlab.test.ts`.

- [ ] **Step 1: Failing test** — append to `gitlab.test.ts`:

```ts
describe("GitlabForge.fork", () => {
  it("forks into the service-account namespace and returns fork coordinates", async () => {
    const { fn, calls } = makeFetch({
      [`POST ${P}/fork`]: {
        json: { path: "r", default_branch: "main", namespace: { full_path: "agent-482913" } },
      },
    });
    const forge = new GitlabForge({ credentials, fetch: fn });
    const fork = await forge.fork({ owner: "o", name: "r" }, actor);
    expect(fork).toEqual({ owner: "agent-482913", repo: "r", defaultBranch: "main" });
    expect(calls[0]!.init.method).toBe("POST");
  });
});
```

- [ ] **Step 2:** Run `pnpm vitest run packages/proxy/src/gitlab.test.ts` → new test FAILS.

- [ ] **Step 3:** In `gitlab.ts`, add `ForkResult` to the shared type import, and add this method to `GitlabForge` (after `comment`):

```ts
  async fork(ref: RepoRef, actor: Author): Promise<ForkResult> {
    const f = await this.gl<{ path: string; default_branch: string; namespace: { full_path: string } }>(
      "POST", `/projects/${this.project(ref)}/fork`, actor.name);
    return { owner: f.namespace.full_path, repo: f.path, defaultBranch: f.default_branch };
  }
```

- [ ] **Step 4:** `pnpm vitest run packages/proxy/src/gitlab.test.ts && npx tsc --noEmit -p tsconfig.base.json` → pass + clean.

- [ ] **Step 5:** Commit:

```bash
git add packages/proxy/src/gitlab.ts packages/proxy/src/gitlab.test.ts
git commit -m "feat(proxy): gitlab adapter fork() into the service-account namespace"
```

---

### Task 4: Forge port + FakeForge + fork route

**Files:** Modify `packages/proxy/src/forge.ts`, `packages/proxy/src/app.ts`, `packages/proxy/src/app.test.ts`.

- [ ] **Step 1: Failing test** — append to `app.test.ts` a fork route test:

```ts
describe("POST /forge/:service/fork", () => {
  it("forks via the adapter with the actor and returns fork coordinates", async () => {
    const { deps, forge } = makeDeps();
    const app = createProxyApp(deps);
    const path = "/forge/github/fork";
    const body = JSON.stringify({ owner: "critical-labs", repo: "agent-identity" });
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ owner: "fork-acct", repo: "agent-identity", defaultBranch: "main" });
    const [name, ref, actor] = forge.calls.at(-1)!;
    expect(name).toBe("fork");
    expect(ref).toEqual({ owner: "critical-labs", name: "agent-identity" });
    expect(actor).toEqual({ name: "482913", email: "482913@agents.example" });
  });

  it("400s a fork request missing fields", async () => {
    const { deps } = makeDeps();
    const app = createProxyApp(deps);
    const path = "/forge/github/fork";
    const body = JSON.stringify({ owner: "o" });
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(400);
  });
});
```

Add a `fork` method to the exported `FakeForge` class (after `comment`):

```ts
  async fork(ref: RepoRef, actor: Author) {
    this.calls.push(["fork", ref, actor]);
    if (this.failWith) throw this.failWith;
    return { owner: "fork-acct", repo: ref.name, defaultBranch: "main" };
  }
```

- [ ] **Step 2:** Run `pnpm vitest run packages/proxy/src/app.test.ts` → the two new tests FAIL (route 404). (FakeForge already compiles with the extra method.)

- [ ] **Step 3a:** In `forge.ts`, add `ForkResult` to the shared import and add to the `Forge` interface (after `comment`):

```ts
  fork(ref: RepoRef, actor: Author): Promise<ForkResult>;
```

- [ ] **Step 3b:** In `app.ts`, add the fork route inside `createProxyApp`, after the comment route:

```ts
  app.post("/forge/:service/fork", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const b = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!b || !isStr(b.owner) || !isStr(b.repo)) return c.json({ error: "invalid_request" }, 400);
    const op: ForgeOp = { service: g.service, kind: "fork", owner: b.owner, repo: b.repo };
    return run(c, g, op, () => g.forge.fork({ owner: b.owner as string, name: b.repo as string }, g.actor));
  });
```

- [ ] **Step 4:** `pnpm vitest run packages/proxy && npx tsc --noEmit -p tsconfig.base.json` → all pass + clean (github/gitlab adapters already implement `fork`, so the interface addition compiles).

- [ ] **Step 5:** Commit:

```bash
git add packages/proxy/src/forge.ts packages/proxy/src/app.ts packages/proxy/src/app.test.ts
git commit -m "feat(proxy): add fork to the Forge port and a fork route"
```

---

### Task 5: Injectable policy + fork-namespace guard

**Files:** Modify `packages/proxy/src/policy.ts`, `packages/proxy/src/policy.test.ts`, `packages/proxy/src/app.ts`, `packages/proxy/src/app.test.ts`.

- [ ] **Step 1: Failing tests** — append to `policy.test.ts`:

```ts
import { forkNamespacePolicy } from "./policy.js";

describe("forkNamespacePolicy", () => {
  const gh = { ...agent, capabilities: ["github"] };
  const gl = { ...agent, capabilities: ["gitlab"] };

  it("denies a github commit outside the configured fork owner", () => {
    const p = forkNamespacePolicy({ githubForkOwner: "critical-agent-zero" });
    expect(p(gh, { service: "github", kind: "commit", owner: "critical-labs", repo: "agent-identity" }))
      .toEqual({ allow: false, reason: expect.stringContaining("critical-agent-zero") });
  });

  it("allows a github commit into the fork owner", () => {
    const p = forkNamespacePolicy({ githubForkOwner: "critical-agent-zero" });
    expect(p(gh, { service: "github", kind: "commit", owner: "critical-agent-zero", repo: "agent-identity" }))
      .toEqual({ allow: true });
  });

  it("pins gitlab commits to agent-<id> without extra config", () => {
    const p = forkNamespacePolicy();
    expect(p(gl, { service: "gitlab", kind: "commit", owner: "someone-else", repo: "r" }).allow).toBe(false);
    expect(p(gl, { service: "gitlab", kind: "commit", owner: "agent-482913", repo: "r" }))
      .toEqual({ allow: true });
  });

  it("does not restrict non-commit ops, and leaves github unpinned when unconfigured", () => {
    const p = forkNamespacePolicy();
    expect(p(gh, { service: "github", kind: "fork", owner: "critical-labs", repo: "r" })).toEqual({ allow: true });
    expect(p(gh, { service: "github", kind: "pr", owner: "critical-labs", repo: "r" })).toEqual({ allow: true });
    expect(p(gh, { service: "github", kind: "commit", owner: "anyone", repo: "r" })).toEqual({ allow: true });
  });
});
```

`policy.test.ts` already defines an `agent: AgentRecord` const (agentId "482913"); reuse it. Add the `forkNamespacePolicy` import to the existing `./policy.js` import if present, else add the import line shown.

- [ ] **Step 2:** Run `pnpm vitest run packages/proxy/src/policy.test.ts` → new tests FAIL.

- [ ] **Step 3:** In `policy.ts`, append:

```ts
export type Policy = (agent: AgentRecord, op: ForgeOp) => PolicyDecision;

export interface ForkPolicyConfig {
  /** The shared GitHub PAT account login (the fork namespace). Unset = do not
   *  pin GitHub commit targets (rely on credential scope). */
  githubForkOwner?: string;
}

/** Deterministic guard-rail (issue #23): a commit may only target the calling
 *  identity's fork namespace, never the source repo. GitLab forks live in the
 *  identity's own service-account namespace (agent-<id>), derivable with no
 *  config; GitHub uses one shared fork account, supplied via config. */
export function forkNamespacePolicy(config: ForkPolicyConfig = {}): Policy {
  return (agent, op) => {
    if (op.kind !== "commit") return { allow: true };
    const expected = op.service === "gitlab" ? `agent-${agent.agentId}` : config.githubForkOwner;
    if (!expected) return { allow: true };
    if (op.owner !== expected) {
      return {
        allow: false,
        reason: `commits must target the fork namespace "${expected}", not "${op.owner}"`,
      };
    }
    return { allow: true };
  };
}
```

- [ ] **Step 4:** Make the app use an injectable policy. In `app.ts`: change the policy import to `import { evaluate, type ForgeOp, type Policy } from "./policy.js";`, add `policy?: Policy;` to `ProxyDeps` (after `provisioners?`), and in `run()` change `const decision = evaluate(g.agent, op);` to `const decision = (deps.policy ?? evaluate)(g.agent, op);`.

- [ ] **Step 5: Failing app test for enforcement** — append to `app.test.ts`:

```ts
describe("policy enforcement", () => {
  it("denies a commit the injected policy rejects, before calling the adapter, and audits it", async () => {
    const denyOffFork: import("./policy.js").Policy = (_a, op) =>
      op.kind === "commit" && op.owner !== "fork-acct"
        ? { allow: false, reason: "off-fork" }
        : { allow: true };
    const { deps, forge, audit } = makeDeps({ policy: denyOffFork });
    const app = createProxyApp(deps);
    const path = "/forge/github/commit";
    const body = JSON.stringify({
      owner: "critical-labs", repo: "agent-identity", branch: "main",
      message: "m", files: [{ path: "f", content: "x" }],
    });
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("denied");
    expect(forge.calls.some((c) => c[0] === "createCommit")).toBe(false);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
  });
});
```

- [ ] **Step 6:** `pnpm vitest run packages/proxy && npx tsc --noEmit -p tsconfig.base.json` → all pass + clean.

- [ ] **Step 7:** Commit:

```bash
git add packages/proxy/src/policy.ts packages/proxy/src/policy.test.ts packages/proxy/src/app.ts packages/proxy/src/app.test.ts
git commit -m "feat(proxy): injectable policy and fork-namespace commit guard (issue #23 seam)"
```

---

### Task 6: Consumer surface — client forgeFork + MCP forge_fork

**Files:** Modify `packages/client/src/client.ts`, `packages/client/src/client.test.ts`, `packages/mcp/src/claim-manager.ts`, `packages/mcp/src/tools.ts`, `packages/mcp/src/tools.test.ts`, `packages/mcp/src/server.ts`.

- [ ] **Step 1: Failing tests** — append inside `describe("forge methods")` in `client.test.ts`:

```ts
  it("forgeFork posts to the fork path", async () => {
    const fetchMock = makeFetch({ owner: "fork-acct", repo: "r", defaultBranch: "main" });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    const r = await client.forgeFork("github", { owner: "o", name: "r" });
    expect(r).toEqual({ owner: "fork-acct", repo: "r", defaultBranch: "main" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/forge/github/fork");
    expect(JSON.parse(init.body as string)).toEqual({ owner: "o", repo: "r" });
  });
```

And inside `describe("forge tools")` in `tools.test.ts`:

```ts
  it("forge_fork delegates with service defaulting to github", async () => {
    const forgeFork = vi.fn(async () => ({ owner: "fork-acct", repo: "r", defaultBranch: "main" }));
    const tools = makeTools(managerWith({ forgeFork }));
    const r = await tools.forgeFork({ owner: "o", repo: "r" });
    expect(r).toEqual({ owner: "fork-acct", repo: "r", defaultBranch: "main" });
    expect(forgeFork).toHaveBeenCalledWith("github", { owner: "o", name: "r" });
  });
```

- [ ] **Step 2:** Run `pnpm vitest run packages/client/src/client.test.ts packages/mcp/src/tools.test.ts` → new tests FAIL.

- [ ] **Step 3:** In `client.ts`, add `ForkResult` to the shared import and add (after `forgeComment`):

```ts
  forgeFork(service: string, ref: RepoRef): Promise<ForkResult> {
    return this.request("POST", `/forge/${service}/fork`,
      JSON.stringify({ owner: ref.owner, repo: ref.name }));
  }
```

- [ ] **Step 4:** In `claim-manager.ts`, add `ForkResult` to the shared import and this signature to `AgentClientLike` (after `forgeComment`):

```ts
  forgeFork(service: string, ref: RepoRef): Promise<ForkResult>;
```

- [ ] **Step 5:** In `tools.ts`, add to the returned object (after `forgeComment`):

```ts
    async forgeFork(args: { service?: string; owner: string; repo: string }) {
      try {
        return await manager.client().forgeFork(args.service ?? "github",
          { owner: args.owner, name: args.repo });
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
```

- [ ] **Step 6:** In `server.ts`, register before the transport lines:

```ts
server.registerTool(
  "forge_fork",
  {
    description: "Fork a source repo so you can commit to your own copy and open a PR/MR back. Returns the fork's owner/repo/defaultBranch. Commit to the fork (owner = the returned owner), never to the source. service defaults to github.",
    inputSchema: { service: z.string().optional(), owner: z.string(), repo: z.string() },
  },
  async (args) => json(await tools.forgeFork(args)),
);
```

- [ ] **Step 7:** `pnpm vitest run packages/client packages/mcp && npx tsc --noEmit -p tsconfig.base.json` → pass + clean.

- [ ] **Step 8:** Commit:

```bash
git add packages/client/src/client.ts packages/client/src/client.test.ts packages/mcp/src/claim-manager.ts packages/mcp/src/tools.ts packages/mcp/src/tools.test.ts packages/mcp/src/server.ts
git commit -m "feat(client,mcp): forgeFork method and forge_fork tool"
```

---

### Task 7: Wiring, infra, and docs

**Files:** Modify `packages/proxy/src/lambda.ts`, `infra/lib/stack.ts`, `packages/dist/skill/SKILL.md`, `.github/workflows/deploy.yml`.

- [ ] **Step 1:** In `lambda.ts`, import the policy and pass it in:

```ts
import { forkNamespacePolicy } from "./policy.js";
```

and add to the `createProxyApp({ ... })` call (after `provisioners`):

```ts
  policy: forkNamespacePolicy({ githubForkOwner: process.env.FORGE_GITHUB_FORK_OWNER }),
```

- [ ] **Step 2:** In `infra/lib/stack.ts`, give the proxy Lambda the fork-owner env var. Change the `proxyFn` definition to set its environment explicitly:

```ts
    const proxyFn = new NodejsFunction(this, "Proxy", {
      ...fnDefaults,
      entry: pkg("proxy/src/lambda.ts"),
      environment: {
        ...commonEnv,
        FORGE_GITHUB_FORK_OWNER: this.node.tryGetContext("githubForkOwner") ?? "",
      },
    });
```

- [ ] **Step 3:** In `packages/dist/skill/SKILL.md`, replace the "Forge operations (via the access proxy)" paragraph with:

```markdown
## Forge operations (via the access proxy)

If this deployment runs the forge proxy and your identity has the service
capability (`github` or `gitlab`), these tools work: `forge_repo` (default
branch + head sha), `forge_fork` (fork a source repo into your own
namespace — returns the fork's owner/repo), `forge_commit` (create a
commit; authorship is set server-side to YOUR identity), `forge_open_pr`,
`forge_comment` (both append an attribution footer), and `forge_provision`
(gitlab). **Contribution model: fork, then PR.** You do not have write
access to source repos — call `forge_fork` on the source, commit to the
returned fork (`forge_commit` with `owner` = the fork owner), then
`forge_open_pr` on the source with `head` = `<fork-owner>:<branch>`. The
proxy rejects a commit aimed at anything but your fork namespace. `service`
defaults to `"github"` (`forge_provision` defaults to `"gitlab"`). A
`missing_capability` error means this identity is not onboarded; a
`not_provisioned` error on gitlab means call `forge_provision` first.
Force-push and branch deletion do not exist in this surface.
```

- [ ] **Step 4:** In `.github/workflows/deploy.yml`, correct the GitHub PAT guidance in the job-summary heredoc. Replace item 4 (`4. Store the shared GitHub PAT ...`) with:

```
          4. Store the shared GitHub PAT (proxy): a token scoped to the bot's FORK namespace (its own repos), with contents+PR write there and the ability to fork + open PRs to the source — NOT write to source repos. \`aws ssm put-parameter --name /agent-identity/forge/github/pat --type SecureString --value <PAT>\`. Deploy with \`-c githubForkOwner=<bot-login>\` so the proxy pins commits to that fork namespace.
```

- [ ] **Step 5:** `npx tsc --noEmit -p tsconfig.base.json` (clean) and `cd infra && pnpm exec cdk synth -c domain=ci.invalid > /dev/null; echo "exit: $?"; cd ..` (exit 0).

- [ ] **Step 6:** Commit:

```bash
git add packages/proxy/src/lambda.ts infra/lib/stack.ts packages/dist/skill/SKILL.md .github/workflows/deploy.yml
git commit -m "feat(infra): wire fork-namespace policy; document fork-and-PR model"
```

---

### Task 8: Full verification (controller)

- [ ] `pnpm vitest run` (all pass), `npx tsc --noEmit -p tsconfig.base.json` (clean), `cd infra && pnpm exec cdk synth -c domain=ci.invalid > /dev/null; echo $?` (0).
- [ ] Two-stage review; fix findings.
- [ ] Push, open PR.

## Notes for the operator / reviewer

- **GitHub credential nuance:** a *fine-grained* PAT is locked to one resource owner and cannot open a PR against a source repo owned by someone else. For cross-owner fork→source PRs use a **classic** PAT with `public_repo` (or `repo` for private) scope, owned by the bot account. Same-owner (bot and source under one org) works with fine-grained.
- **Shared GitHub fork account:** with one shared PAT, all agents' GitHub forks live under the single bot account, so they share fork repos (distinct branch names keep work separate; authorship is still per-identity). GitLab forks land in each identity's own service-account namespace, so there is no sharing there.
