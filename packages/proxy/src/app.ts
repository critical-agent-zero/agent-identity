import {
  signatureAuth, type AgentRecord, type AgentsRepo, type NoncesRepo,
} from "@agent-identity/api";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  ForgeError, statusFor, type Author, type Forge, type Provisioner,
} from "./forge.js";
import { evaluate, type ForgeOp, type Policy } from "./policy.js";

export interface ProxyDeps {
  agents: AgentsRepo;
  nonces: NoncesRepo;
  forges: Record<string, Forge>;
  provisioners?: Record<string, Provisioner>;
  policy?: Policy;
  audit?: (line: Record<string, unknown>) => void;
}

interface Guarded {
  service: string;
  forge: Forge;
  agent: AgentRecord;
  actor: Author;
}

export function createProxyApp(deps: ProxyDeps): Hono {
  const app = new Hono();
  const audit = deps.audit ?? ((line: Record<string, unknown>) => console.log(JSON.stringify(line)));
  app.use("*", signatureAuth(deps.agents, deps.nonces));

  const guard = (c: Context): Guarded | Response => {
    const agent = c.get("agent") as AgentRecord;
    const service = c.req.param("service");
    const forge = service ? deps.forges[service] : undefined;
    if (!service || !forge) {
      audit({ agentId: agent.agentId, service: service ?? "-", outcome: "rejected", reason: "unknown_service" });
      return c.json({ error: "unknown_service" }, 404);
    }
    if (!(agent.capabilities ?? []).includes(service)) {
      audit({ agentId: agent.agentId, service, outcome: "rejected", reason: "missing_capability" });
      return c.json({
        error: "missing_capability",
        remediation: `ask the operator to run: mailctl agent tag ${agent.agentId} ${service}`,
      }, 403);
    }
    return { service, forge, agent, actor: { name: agent.agentId, email: agent.address } };
  };

  const run = async <T>(
    c: Context, g: Guarded, op: ForgeOp, call: () => Promise<T>,
  ): Promise<Response> => {
    const base = {
      agentId: g.agent.agentId, service: op.service, op: op.kind,
      owner: op.owner, repo: op.repo,
    };
    const decision = (deps.policy ?? evaluate)(g.agent, op);
    if (!decision.allow) {
      audit({ ...base, outcome: "denied", reason: decision.reason });
      return c.json({ error: "denied", reason: decision.reason }, 403);
    }
    const started = Date.now();
    try {
      const result = await call();
      audit({ ...base, outcome: "ok", latencyMs: Date.now() - started });
      return c.json(result as object);
    } catch (err) {
      if (err instanceof ForgeError) {
        audit({
          ...base, outcome: "error", errorKind: err.kind,
          upstreamStatus: err.upstream, latencyMs: Date.now() - started,
        });
        const label = err.kind === "upstream_auth" ? "upstream_credential_invalid" : err.kind;
        // provision runs with the group-owner admin token; its upstream error
        // text is admin-context, so don't echo it to the calling agent.
        const payload = op.kind === "provision"
          ? { error: label }
          : { error: label, detail: err.message };
        return c.json(payload, statusFor(err.kind) as never);
      }
      // Never silently swallow an unexpected failure in a credential proxy.
      audit({ ...base, outcome: "unexpected", latencyMs: Date.now() - started });
      throw err;
    }
  };

  app.get("/forge/:service/repo/:owner/:repo", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const { owner, repo } = c.req.param();
    const op: ForgeOp = { service: g.service, kind: "repo", owner, repo };
    return run(c, g, op, () => g.forge.getRepo({ owner, name: repo }, g.actor));
  });

  const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  // owner/repo/branch are interpolated into upstream URL paths by adapters,
  // where fetch's WHATWG URL normalization turns ".." into an escape from the
  // policy-pinned fork repo — so names must be single path segments and a
  // branch may contain "/" but never dot segments, "..", "\", or controls.
  const isName = (v: unknown): v is string =>
    isStr(v) && /^[A-Za-z0-9_.-]+$/.test(v) && !/^\.+$/.test(v);
  const isBranch = (v: unknown): v is string =>
    isStr(v) && !v.includes("..") && !/[\\\u0000-\u001f\u007f]/.test(v) &&
    v.split("/").every((s) => s.length > 0 && s !== ".");
  const isFiles = (v: unknown): v is { path: string; content: string }[] =>
    Array.isArray(v) && v.length > 0 &&
    v.every((f) => isStr((f as { path?: unknown }).path) &&
      typeof (f as { content?: unknown }).content === "string");

  app.post("/forge/:service/commit", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const b = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!b || !isName(b.owner) || !isName(b.repo) || !isBranch(b.branch)
      || !isStr(b.message) || !isFiles(b.files)) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const op: ForgeOp = { service: g.service, kind: "commit", owner: b.owner, repo: b.repo };
    return run(c, g, op, () => g.forge.createCommit(
      { owner: b.owner as string, name: b.repo as string },
      {
        branch: b.branch as string, message: b.message as string,
        files: b.files as { path: string; content: string }[],
      },
      g.actor,
    ));
  });

  app.post("/forge/:service/pr", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const b = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!b || !isStr(b.owner) || !isStr(b.repo) || !isStr(b.head)
      || !isStr(b.base) || !isStr(b.title) || typeof b.body !== "string") {
      return c.json({ error: "invalid_request" }, 400);
    }
    const op: ForgeOp = { service: g.service, kind: "pr", owner: b.owner, repo: b.repo };
    const footer = `\n\n_opened by agent ${g.agent.agentId} via agent-identity proxy_`;
    return run(c, g, op, () => g.forge.openPullRequest(
      { owner: b.owner as string, name: b.repo as string },
      {
        head: b.head as string, base: b.base as string,
        title: b.title as string, body: `${b.body}${footer}`,
      },
      g.actor,
    ));
  });

  app.post("/forge/:service/comment", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const b = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!b || !isStr(b.owner) || !isStr(b.repo)
      || !Number.isInteger(b.issue) || typeof b.body !== "string") {
      return c.json({ error: "invalid_request" }, 400);
    }
    const op: ForgeOp = { service: g.service, kind: "comment", owner: b.owner, repo: b.repo };
    const footer = `\n\n_comment by agent ${g.agent.agentId} via agent-identity proxy_`;
    return run(c, g, op, () => g.forge.comment(
      { owner: b.owner as string, name: b.repo as string },
      b.issue as number, `${b.body}${footer}`, g.actor,
    ));
  });

  app.post("/forge/:service/fork", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const b = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!b || !isStr(b.owner) || !isStr(b.repo)) return c.json({ error: "invalid_request" }, 400);
    const op: ForgeOp = { service: g.service, kind: "fork", owner: b.owner, repo: b.repo };
    return run(c, g, op, () => g.forge.fork({ owner: b.owner as string, name: b.repo as string }, g.actor));
  });

  app.post("/forge/:service/provision", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const provisioner = deps.provisioners?.[g.service];
    if (!provisioner) return c.json({ error: "provisioning_unsupported" }, 404);
    const op: ForgeOp = { service: g.service, kind: "provision", owner: "-", repo: "-" };
    return run(c, g, op, () => provisioner.provision(g.actor));
  });

  return app;
}
