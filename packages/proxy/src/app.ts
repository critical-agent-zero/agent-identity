import {
  signatureAuth, type AgentRecord, type AgentsRepo, type NoncesRepo,
} from "@agent-identity/api";
import type { ActivityEvent } from "@agent-identity/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  ForgeError, statusFor, type Author, type Forge, type Provisioner,
} from "./forge.js";
import { evaluate, type ForgeOp, type Policy } from "./policy.js";

/** Attested-event sink (the shared data layer's ActivityRepo in production).
 *  The proxy is infrastructure: it observed the forge operation succeed, so
 *  it — and only it — may write these events as class "attested". */
export interface ActivityLedger {
  putEvent(event: ActivityEvent): Promise<unknown>;
}

/** What a route contributes to the attested event; agentId/ts/class are
 *  filled in centrally so no route can mislabel an event's class. */
type Attestation = Pick<ActivityEvent, "type" | "summary" | "detail" | "ref">;

export interface ProxyDeps {
  agents: AgentsRepo;
  nonces: NoncesRepo;
  forges: Record<string, Forge>;
  provisioners?: Record<string, Provisioner>;
  policy?: Policy;
  audit?: (line: Record<string, unknown>) => void;
  activity?: ActivityLedger;
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
    attest?: (result: T) => Attestation,
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
      if (attest && deps.activity) {
        try {
          await deps.activity.putEvent({
            agentId: g.agent.agentId, ts: new Date().toISOString(),
            class: "attested", ...attest(result),
          });
        } catch (ledgerErr) {
          // The forge operation already succeeded; a ledger outage must
          // never turn that success into a failure. Log and continue.
          audit({
            ...base, outcome: "ledger_write_failed",
            error: (ledgerErr as Error).message,
          });
        }
      }
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
  const isFiles = (v: unknown): v is { path: string; content: string }[] =>
    Array.isArray(v) && v.length > 0 &&
    v.every((f) => isStr((f as { path?: unknown }).path) &&
      typeof (f as { content?: unknown }).content === "string");

  app.post("/forge/:service/commit", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const b = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!b || !isStr(b.owner) || !isStr(b.repo) || !isStr(b.branch)
      || !isStr(b.message) || !isFiles(b.files)) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const op: ForgeOp = { service: g.service, kind: "commit", owner: b.owner, repo: b.repo };
    const repo = `${b.owner}/${b.repo}`;
    return run(c, g, op, () => g.forge.createCommit(
      { owner: b.owner as string, name: b.repo as string },
      {
        branch: b.branch as string, message: b.message as string,
        files: b.files as { path: string; content: string }[],
      },
      g.actor,
    ), (r) => ({
      type: "forge_commit",
      summary: `committed to ${repo}@${b.branch}`,
      detail: { service: g.service, repo, branch: b.branch as string, sha: r.sha },
      ref: r.url,
    }));
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
    const repo = `${b.owner}/${b.repo}`;
    return run(c, g, op, () => g.forge.openPullRequest(
      { owner: b.owner as string, name: b.repo as string },
      {
        head: b.head as string, base: b.base as string,
        title: b.title as string, body: `${b.body}${footer}`,
      },
      g.actor,
    ), (r) => ({
      type: "forge_pr",
      summary: `opened PR #${r.number} on ${repo}`,
      detail: { service: g.service, repo, number: r.number },
      ref: r.url,
    }));
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
    const repo = `${b.owner}/${b.repo}`;
    return run(c, g, op, () => g.forge.comment(
      { owner: b.owner as string, name: b.repo as string },
      b.issue as number, `${b.body}${footer}`, g.actor,
    ), (r) => ({
      type: "forge_comment",
      summary: `commented on ${repo}#${b.issue}`,
      detail: { service: g.service, repo, issue: b.issue as number },
      ref: r.url,
    }));
  });

  app.post("/forge/:service/fork", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const b = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!b || !isStr(b.owner) || !isStr(b.repo)) return c.json({ error: "invalid_request" }, 400);
    const op: ForgeOp = { service: g.service, kind: "fork", owner: b.owner, repo: b.repo };
    const source = `${b.owner}/${b.repo}`;
    return run(c, g, op,
      () => g.forge.fork({ owner: b.owner as string, name: b.repo as string }, g.actor),
      (r) => ({
        type: "forge_fork",
        summary: `forked ${source} to ${r.owner}/${r.repo}`,
        detail: { service: g.service, source, fork: `${r.owner}/${r.repo}` },
      }));
  });

  app.post("/forge/:service/provision", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const provisioner = deps.provisioners?.[g.service];
    if (!provisioner) return c.json({ error: "provisioning_unsupported" }, 404);
    const op: ForgeOp = { service: g.service, kind: "provision", owner: "-", repo: "-" };
    // The event deliberately records only the service: the provisioned
    // username and mailbox address must never reach fleet feeds.
    return run(c, g, op, () => provisioner.provision(g.actor), () => ({
      type: "capability_granted",
      summary: `provisioned a ${g.service} service account`,
      detail: { service: g.service },
    }));
  });

  return app;
}
