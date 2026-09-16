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
