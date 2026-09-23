import {
  fingerprint, sanitizeActivityText, STATUS_LABEL_MAX, STATUS_STATES, TASK_NOTE_MAX,
  type ActivityEvent, type AgentStatusState,
} from "@agent-identity/shared";
import { Hono } from "hono";
import { signatureAuth } from "./auth.js";
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
}

const isFleetPath = (pathname: string): boolean =>
  pathname === "/fleet" || pathname.startsWith("/fleet/");

export function createApp(deps: Deps): Hono {
  const app = new Hono();
  const sigAuth = signatureAuth(deps.agents, deps.nonces);

  // Two disjoint credential domains, chosen by path:
  //  - /fleet/* is viewer-key territory: read-only dashboard credential. A
  //    valid agent signature (or the fleet registration key) is deliberately
  //    NOT accepted here.
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
