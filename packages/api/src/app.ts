import {
  fingerprint, projectPublicEvent, publicView, sanitizeActivityText,
  STATUS_LABEL_MAX, STATUS_STATES, TASK_NOTE_MAX,
  type ActivityEvent, type AgentStatusState,
} from "@agent-identity/shared";
import { Hono } from "hono";
import { adminKeyAuth, signatureAuth } from "./auth.js";
import type { ActivityRepo } from "./db/activity.js";
import type { AgentsRepo } from "./db/agents.js";
import { InvalidCursorError, type EmailsRepo } from "./db/emails.js";
import type { NoncesRepo } from "./db/nonces.js";

export interface Deps {
  agents: AgentsRepo;
  emails: EmailsRepo;
  activity: ActivityRepo;
  nonces: NoncesRepo;
  readBody: (s3Key: string) => Promise<{ text: string; html?: string; links: string[] }>;
  fleetKeyRequired: boolean;
  /** Normalized repo allowlist for the UNAUTHENTICATED public fleet tier
   *  (parseRepoAllowlist of PUBLIC_REPOS). Empty — the default — means the
   *  public tier shows no forge events at all: fail closed. */
  publicRepos: string[];
}

const isFleetPath = (pathname: string): boolean =>
  pathname === "/fleet" || pathname.startsWith("/fleet/");

// Capability tags are operator-defined slugs; the shape bound keeps
// attacker-shaped strings out of the data layer.
const CAPABILITY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function createApp(deps: Deps): Hono {
  const app = new Hono();

  // The $default catch-all route forwards OPTIONS to this lambda before API
  // Gateway's CORS handling can answer it, so preflights must be answered
  // here — before any auth, with no body. Mirrors the stack's corsPreflight.
  app.options("*", (c) =>
    c.body(null, 204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET",
      "access-control-allow-headers": "content-type, x-viewer-key",
      "access-control-max-age": "3600",
    }));

  // Mounted BEFORE signatureAuth: admin routes are gated only by the admin
  // key, and signature-auth'd agents never reach them. Nothing here is
  // exposed through the MCP surface — the agent-facing client has no admin
  // methods.
  const admin = new Hono();
  admin.use("*", adminKeyAuth(deps.agents));

  admin.post("/agents/:agentId/capabilities", async (c) => {
    let capability: unknown;
    try {
      capability = ((await c.req.json()) as { capability?: unknown }).capability;
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    if (typeof capability !== "string" || !CAPABILITY_RE.test(capability))
      return c.json({ error: "invalid capability" }, 400);
    const agentId = c.req.param("agentId");
    const capabilities = await deps.agents.addCapability(agentId, capability);
    if (!capabilities) return c.json({ error: "not found" }, 404);
    return c.json({ agentId, capabilities });
  });

  admin.delete("/agents/:agentId/capabilities/:capability", async (c) => {
    const capability = c.req.param("capability");
    if (!CAPABILITY_RE.test(capability)) return c.json({ error: "invalid capability" }, 400);
    const agentId = c.req.param("agentId");
    const capabilities = await deps.agents.removeCapability(agentId, capability);
    if (!capabilities) return c.json({ error: "not found" }, 404);
    return c.json({ agentId, capabilities });
  });

  app.route("/admin", admin);

  // Public fleet tier — UNAUTHENTICATED BY DESIGN. Mounted, like /admin,
  // BEFORE the credential middleware: these two GETs deliberately bypass all
  // three credential domains (the API-gateway stage throttle is the rate
  // bound), and any other /fleet/public path or method falls through to the
  // viewer-key wall below. Everything served here passes through the shared
  // publicView() projection, which is fail-closed: forge events only for
  // repos on the deps.publicRepos allowlist (default empty = none), status
  // without labels, task notes never, refs re-validated. Excluded events are
  // absent — no placeholder, no count. No request parameter can widen the
  // output: limit is clamped and nothing else is honored.
  //
  // The storage read is PROJECTION-AWARE: the repo applies isPublicEvent
  // over the whole log before its limit, so it collects public events until
  // `limit` or exhaustion. Reading a fixed RAW window and projecting
  // afterwards would let private events displace public ones — emptying the
  // feed of publishable events and letting an unauthenticated observer read
  // private-event volume out of the deltas (the tempo side channel).
  const PUBLIC_FEED_DEFAULT = 50;
  const PUBLIC_FEED_MAX = 100;
  // Post-projection bound for the roster's per-agent counts (the repo's own
  // fleet-feed max). Counts saturate there as a function of PUBLIC activity
  // only — private volume cannot displace public events or move the numbers.
  const PUBLIC_COUNT_WINDOW = 200;

  const publicFleet = new Hono();

  const isPublicEvent = (e: ActivityEvent): boolean =>
    projectPublicEvent(e, deps.publicRepos) !== undefined;

  publicFleet.get("/agents", async (c) => {
    const [roster, feed] = await Promise.all([
      deps.activity.fleetRoster(),
      deps.activity.listFleetEvents({ limit: PUBLIC_COUNT_WINDOW, filter: isPublicEvent }),
    ]);
    // Roster counts are recomputed over PUBLIC events only — the stored
    // per-class totals would otherwise leak private-work tempo.
    const { agents } = publicView(feed.events, roster, deps.publicRepos);
    return c.json({ publicView: true, agents });
  });

  publicFleet.get("/activity", async (c) => {
    const n = Number(c.req.query("limit"));
    const limit = Number.isFinite(n)
      ? Math.min(Math.max(Math.trunc(n), 1), PUBLIC_FEED_MAX)
      : PUBLIC_FEED_DEFAULT;
    const feed = await deps.activity.listFleetEvents({ limit, filter: isPublicEvent });
    // publicView re-projects what the filter admitted: the projection stays
    // the single authority on what is public, and a storage fake that
    // ignores `filter` still cannot leak. The slice is the same
    // belt-and-suspenders bound against an over-returning repo.
    const { events } = publicView(feed.events, [], deps.publicRepos);
    return c.json({ publicView: true, events: events.slice(0, limit) });
  });

  app.route("/fleet/public", publicFleet);

  const sigAuth = signatureAuth(deps.agents, deps.nonces);
  // Three disjoint credential domains, chosen by path:
  //  - /admin/* (mounted above, so requests never reach this middleware) is
  //    admin-key territory.
  //  - /fleet/* is viewer-key territory: read-only dashboard credential. A
  //    valid agent signature (or the fleet registration key) is deliberately
  //    NOT accepted here. (The two GET /fleet/public routes mounted above
  //    answer first and never reach this wall; any other /fleet/public path
  //    or method still lands here and demands the viewer key.)
  //  - everything else is signature territory: a viewer key presented there
  //    hits the signature check and fails, making the viewer key read-only
  //    by construction.
  app.use("*", async (c, next) => {
    if (!isFleetPath(new URL(c.req.url).pathname)) return sigAuth(c, next);
    const viewerKey = c.req.header("x-viewer-key");
    if (!viewerKey) return c.json({ error: "missing viewer key" }, 401);
    if (!(await deps.agents.verifyViewerKey(viewerKey)))
      return c.json({ error: "invalid viewer key" }, 403);
    return next();
  });

  app.post("/register", async (c) => {
    if (deps.fleetKeyRequired) {
      const fleetKey = c.req.header("x-fleet-key");
      if (!fleetKey || !(await deps.agents.verifyFleetKey(fleetKey)))
        return c.json({ error: "invalid fleet key" }, 403);
    }
    const publicKey = c.get("verifiedPublicKey");
    const identity = await deps.agents.register(publicKey, fingerprint(publicKey));
    return c.json(identity);
  });

  app.get("/me", async (c) => {
    const { agentId, address, capabilities } = c.get("agent");
    const status = await deps.activity.getStatus(agentId);
    return c.json({
      agentId, address, capabilities: capabilities ?? [],
      ...(status ? { status } : {}),
    });
  });

  app.get("/emails", async (c) => {
    const limitRaw = c.req.query("limit");
    try {
      const result = await deps.emails.listEmails(c.get("agent").agentId, {
        since: c.req.query("since"),
        limit: limitRaw ? Number(limitRaw) : undefined,
        cursor: c.req.query("cursor"),
        // Explicit opt-ins; anything but the literal "true" keeps the default
        // exclusion of flagged mail.
        includeUnsolicited: c.req.query("includeUnsolicited") === "true",
        includeUnauthenticated: c.req.query("includeUnauthenticated") === "true",
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof InvalidCursorError) return c.json({ error: "invalid cursor" }, 400);
      throw err;
    }
  });

  app.get("/emails/:id", async (c) => {
    const email = await deps.emails.getEmail(c.get("agent").agentId, c.req.param("id"));
    if (!email) return c.json({ error: "not found" }, 404);
    const { bodyS3Key, ...rest } = email;
    if (bodyS3Key) {
      const body = await deps.readBody(bodyS3Key);
      return c.json({ ...rest, ...body });
    }
    return c.json(rest);
  });

  // Claimed self-reports ONLY. The class is set server-side, unconditionally:
  // no API path may ever store an agent-authored event as attested. Attested
  // events enter through the data layer (proxy/ingest), never through HTTP.
  app.post("/activity", async (c) => {
    const agentId = c.get("agent").agentId;
    const b = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!b) return c.json({ error: "invalid_request" }, 400);
    if (b.class !== undefined && b.class !== "claimed")
      return c.json({ error: "class is assigned by the server; self-reports are always claimed" }, 400);

    const ts = new Date().toISOString();
    let event: ActivityEvent;
    if (b.type === "status") {
      if (!STATUS_STATES.includes(b.state as AgentStatusState))
        return c.json({ error: `state must be one of ${STATUS_STATES.join("|")}` }, 400);
      if (b.label !== undefined && typeof b.label !== "string")
        return c.json({ error: "label must be a string" }, 400);
      const state = b.state as AgentStatusState;
      const label = b.label === undefined
        ? undefined
        : sanitizeActivityText(b.label, STATUS_LABEL_MAX);
      event = {
        agentId, ts, class: "claimed", type: "status",
        summary: `status: ${state}${label ? ` — ${label}` : ""}`,
        detail: { state, ...(label !== undefined ? { label } : {}) },
      };
      await deps.activity.putEvent(event);
      await deps.activity.setStatus(agentId, {
        state, ...(label !== undefined ? { label } : {}), updatedAt: ts,
      });
    } else if (b.type === "task_note") {
      if (typeof b.note !== "string" || b.note.length === 0)
        return c.json({ error: "note must be a non-empty string" }, 400);
      const note = sanitizeActivityText(b.note, TASK_NOTE_MAX);
      event = { agentId, ts, class: "claimed", type: "task_note", summary: note };
      await deps.activity.putEvent(event);
    } else {
      return c.json({
        error: "only claimed event types (status, task_note) may be self-reported; attested events are written by infrastructure only",
      }, 400);
    }
    return c.json({ event }, 201);
  });

  app.get("/agents/me/activity", async (c) => {
    const limitRaw = c.req.query("limit");
    try {
      const result = await deps.activity.listEvents(c.get("agent").agentId, {
        limit: limitRaw ? Number(limitRaw) : undefined,
        cursor: c.req.query("cursor"),
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof InvalidCursorError) return c.json({ error: "invalid cursor" }, 400);
      throw err;
    }
  });

  // Viewer-key routes. Events were redacted and sanitized at write time:
  // email events carry authenticated sender domains only, claimed text is
  // sanitized+capped here, and attested summaries/details/refs get the same
  // character-strip and length cap at their central writers (proxy run(),
  // ingest). The repo maps an explicit field allowlist, so no addresses,
  // keys, or capability grants beyond the roster's own capability list can
  // appear here.
  app.get("/fleet/activity", async (c) => {
    const limitRaw = c.req.query("limit");
    const result = await deps.activity.listFleetEvents({
      limit: limitRaw ? Number(limitRaw) : undefined,
    });
    return c.json(result);
  });

  app.get("/fleet/agents", async (c) => {
    return c.json({ agents: await deps.activity.fleetRoster() });
  });

  return app;
}
