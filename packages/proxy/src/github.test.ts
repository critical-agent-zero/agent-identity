import { describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "./forge.js";
import { GithubForge } from "./github.js";

const credentials: CredentialStore = { resolve: async () => "tok123" };
const actor = { name: "482913", email: "482913@agents.example" };

type FakeRoute = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };

/** fetch fake: responds per "METHOD url" from a routing table; records calls.
 *  An array value answers in sequence (last entry repeats) — for endpoints
 *  whose response changes between calls, e.g. a ref that appears mid-flow. */
function makeFetch(routes: Record<string, FakeRoute | FakeRoute[]>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const key = `${init.method ?? "GET"} ${url}`;
    const entry = routes[key];
    const route = Array.isArray(entry)
      ? (entry.length > 1 ? entry.shift() : entry[0])
      : entry;
    if (!route) throw new Error(`unexpected fetch: ${key}`);
    const body = route.text ?? JSON.stringify(route.json ?? {});
    return new Response(body, { status: route.status ?? 200, headers: route.headers });
  });
  return { fn: fn as unknown as typeof globalThis.fetch, calls };
}

const B = "https://api.github.com/repos/o/r";

describe("GithubForge.getRepo", () => {
  it("returns default branch and its head sha, resolving the actor's credential", async () => {
    const resolve = vi.fn(async () => "tok123");
    const { fn, calls } = makeFetch({
      [`GET ${B}`]: { json: { default_branch: "main" } },
      [`GET ${B}/git/ref/heads/main`]: { json: { object: { sha: "abc123" } } },
    });
    const forge = new GithubForge({ credentials: { resolve }, fetch: fn });
    const info = await forge.getRepo({ owner: "o", name: "r" }, actor);
    expect(info).toEqual({ defaultBranch: "main", headSha: "abc123" });
    expect(resolve).toHaveBeenCalledWith("github", "482913");
    const h = new Headers(calls[0]!.init.headers);
    expect(h.get("authorization")).toBe("Bearer tok123");
  });

  it("maps 404 to not_found", async () => {
    const { fn } = makeFetch({ [`GET ${B}`]: { status: 404, json: { message: "Not Found" } } });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.getRepo({ owner: "o", name: "r" }, actor))
      .rejects.toMatchObject({ kind: "not_found" });
  });

  it("maps 401 to upstream_auth", async () => {
    const { fn } = makeFetch({ [`GET ${B}`]: { status: 401, json: { message: "Bad credentials" } } });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.getRepo({ owner: "o", name: "r" }, actor))
      .rejects.toMatchObject({ kind: "upstream_auth", upstream: 401 });
  });

  it("maps exhausted rate limit to rate_limited", async () => {
    const { fn } = makeFetch({
      [`GET ${B}`]: {
        status: 403, json: { message: "API rate limit exceeded" },
        headers: { "x-ratelimit-remaining": "0" },
      },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.getRepo({ owner: "o", name: "r" }, actor))
      .rejects.toMatchObject({ kind: "rate_limited" });
  });

  it("maps a non-rate-limit 403 to forbidden (not invalid)", async () => {
    const { fn } = makeFetch({
      [`GET ${B}`]: {
        status: 403, json: { message: "Resource not accessible by personal access token" },
      },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.getRepo({ owner: "o", name: "r" }, actor))
      .rejects.toMatchObject({ kind: "forbidden" });
  });
});

describe("GithubForge.createCommit", () => {
  const routes = {
    [`GET ${B}/git/ref/heads/main`]: { json: { object: { sha: "head1" } } },
    [`GET ${B}/git/commits/head1`]: { json: { tree: { sha: "tree0" } } },
    [`POST ${B}/git/trees`]: { json: { sha: "tree1" } },
    [`POST ${B}/git/commits`]: { json: { sha: "commit1", html_url: "https://github.com/o/r/commit/commit1" } },
    [`PATCH ${B}/git/refs/heads/main`]: { json: { object: { sha: "commit1" } } },
  };
  const spec = {
    branch: "main", message: "feat: x",
    files: [{ path: "a.txt", content: "A" }],
  };

  it("runs ref → base commit → tree → commit → fast-forward ref update", async () => {
    const { fn, calls } = makeFetch(routes);
    const forge = new GithubForge({ credentials, fetch: fn });
    const result = await forge.createCommit({ owner: "o", name: "r" }, spec, actor);
    expect(result).toEqual({ sha: "commit1", url: "https://github.com/o/r/commit/commit1" });

    const treeCall = calls.find((c) => c.url.endsWith("/git/trees"))!;
    expect(JSON.parse(treeCall.init.body as string)).toEqual({
      base_tree: "tree0",
      tree: [{ path: "a.txt", mode: "100644", type: "blob", content: "A" }],
    });

    const commitCall = calls.find((c) => c.url.endsWith("/git/commits") && c.init.method === "POST")!;
    expect(JSON.parse(commitCall.init.body as string)).toEqual({
      message: "feat: x", tree: "tree1", parents: ["head1"],
      author: { name: "482913", email: "482913@agents.example" },
    });

    const refCall = calls.find((c) => c.init.method === "PATCH")!;
    expect(JSON.parse(refCall.init.body as string)).toEqual({ sha: "commit1", force: false });
  });

  it("maps a non-fast-forward 422 to non_fast_forward", async () => {
    const { fn } = makeFetch({
      ...routes,
      [`PATCH ${B}/git/refs/heads/main`]: {
        status: 422, json: { message: "Update is not a fast forward" },
      },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.createCommit({ owner: "o", name: "r" }, spec, actor))
      .rejects.toMatchObject({ kind: "non_fast_forward" });
  });
});

describe("GithubForge.createCommit branch auto-create", () => {
  const spec = {
    branch: "feat-x", message: "feat: x",
    files: [{ path: "a.txt", content: "A" }],
  };

  it("creates a missing branch from the repo's OWN default-branch head, then commits", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${B}/git/ref/heads/feat-x`]: { status: 404, json: { message: "Not Found" } },
      [`GET ${B}`]: { json: { default_branch: "main" } },
      [`GET ${B}/git/ref/heads/main`]: { json: { object: { sha: "defhead" } } },
      [`POST ${B}/git/refs`]: { status: 201, json: { ref: "refs/heads/feat-x", object: { sha: "defhead" } } },
      [`GET ${B}/git/commits/defhead`]: { json: { tree: { sha: "tree0" } } },
      [`POST ${B}/git/trees`]: { json: { sha: "tree1" } },
      [`POST ${B}/git/commits`]: { json: { sha: "commit1", html_url: "https://github.com/o/r/commit/commit1" } },
      [`PATCH ${B}/git/refs/heads/feat-x`]: { json: { object: { sha: "commit1" } } },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    const result = await forge.createCommit({ owner: "o", name: "r" }, spec, actor);
    expect(result).toEqual({ sha: "commit1", url: "https://github.com/o/r/commit/commit1" });

    const refCreate = calls.findIndex((c) => c.url.endsWith("/git/refs") && c.init.method === "POST");
    expect(refCreate).toBeGreaterThan(-1);
    expect(JSON.parse(calls[refCreate]!.init.body as string)).toEqual({
      ref: "refs/heads/feat-x", sha: "defhead",
    });
    const commitPost = calls.findIndex((c) => c.url.endsWith("/git/commits") && c.init.method === "POST");
    expect(refCreate).toBeLessThan(commitPost);
    expect(JSON.parse(calls[commitPost]!.init.body as string).parents).toEqual(["defhead"]);
  });

  it("falls through to committing when the ref appears between check and create", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${B}/git/ref/heads/feat-x`]: [
        { status: 404, json: { message: "Not Found" } },
        { json: { object: { sha: "racedhead" } } },
      ],
      [`GET ${B}`]: { json: { default_branch: "main" } },
      [`GET ${B}/git/ref/heads/main`]: { json: { object: { sha: "defhead" } } },
      [`POST ${B}/git/refs`]: { status: 422, json: { message: "Reference already exists" } },
      [`GET ${B}/git/commits/racedhead`]: { json: { tree: { sha: "tree0" } } },
      [`POST ${B}/git/trees`]: { json: { sha: "tree1" } },
      [`POST ${B}/git/commits`]: { json: { sha: "commit1", html_url: "https://github.com/o/r/commit/commit1" } },
      [`PATCH ${B}/git/refs/heads/feat-x`]: { json: { object: { sha: "commit1" } } },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    const result = await forge.createCommit({ owner: "o", name: "r" }, spec, actor);
    expect(result).toEqual({ sha: "commit1", url: "https://github.com/o/r/commit/commit1" });
    const commitPost = calls.find((c) => c.url.endsWith("/git/commits") && c.init.method === "POST")!;
    expect(JSON.parse(commitPost.init.body as string).parents).toEqual(["racedhead"]);
  });

  it("surfaces retryable not_found for an empty repo (fresh fork still importing), writing nothing", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${B}/git/ref/heads/feat-x`]: { status: 404, json: { message: "Not Found" } },
      [`GET ${B}`]: { json: { default_branch: "main" } },
      [`GET ${B}/git/ref/heads/main`]: { status: 404, json: { message: "Git Repository is empty." } },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.createCommit({ owner: "o", name: "r" }, spec, actor))
      .rejects.toMatchObject({ kind: "not_found" });
    expect(calls.every((c) => (c.init.method ?? "GET") === "GET")).toBe(true);
  });
});

describe("GithubForge.openPullRequest and comment", () => {
  it("opens a PR", async () => {
    const { fn, calls } = makeFetch({
      [`POST ${B}/pulls`]: { json: { number: 5, html_url: "https://github.com/o/r/pull/5" } },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    const pr = await forge.openPullRequest({ owner: "o", name: "r" },
      { head: "f", base: "main", title: "t", body: "b" }, actor);
    expect(pr).toEqual({ number: 5, url: "https://github.com/o/r/pull/5" });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      title: "t", head: "f", base: "main", body: "b",
    });
  });

  it("comments on an issue", async () => {
    const { fn } = makeFetch({
      [`POST ${B}/issues/12/comments`]: { json: { id: 33, html_url: "https://github.com/o/r/issues/12#c33" } },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    const c = await forge.comment({ owner: "o", name: "r" }, 12, "hello", actor);
    expect(c).toEqual({ id: 33, url: "https://github.com/o/r/issues/12#c33" });
  });
});

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

describe("GithubForge.repoVisibility", () => {
  const vis = async (json: unknown) => {
    const { fn } = makeFetch({ [`GET ${B}`]: { json } });
    return new GithubForge({ credentials, fetch: fn })
      .repoVisibility({ owner: "o", name: "r" }, actor);
  };

  it("maps a world-readable repo to 'public'", async () => {
    expect(await vis({ private: false, visibility: "public" })).toBe("public");
    // older GHES payloads may omit `visibility`; `private: false` suffices
    expect(await vis({ private: false })).toBe("public");
  });

  it("maps private and GHES-internal repos to 'private' (fail closed)", async () => {
    expect(await vis({ private: true, visibility: "private" })).toBe("private");
    expect(await vis({ private: false, visibility: "internal" })).toBe("private");
    // a malformed payload proves nothing: not public
    expect(await vis({})).toBe("private");
  });

  it("propagates upstream errors as ForgeErrors (callers decide the fail-closed handling)", async () => {
    const { fn } = makeFetch({ [`GET ${B}`]: { status: 404, json: { message: "Not Found" } } });
    await expect(new GithubForge({ credentials, fetch: fn })
      .repoVisibility({ owner: "o", name: "r" }, actor))
      .rejects.toMatchObject({ kind: "not_found" });
  });
});
