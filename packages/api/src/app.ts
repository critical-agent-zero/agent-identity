import { fingerprint } from "@agent-identity/shared";
import { Hono } from "hono";
import { adminKeyAuth, signatureAuth } from "./auth.js";
import type { AgentsRepo } from "./db/agents.js";
import { InvalidCursorError, type EmailsRepo } from "./db/emails.js";
import type { NoncesRepo } from "./db/nonces.js";

export interface Deps {
  agents: AgentsRepo;
  emails: EmailsRepo;
  nonces: NoncesRepo;
  readBody: (s3Key: string) => Promise<{ text: string; html?: string; links: string[] }>;
  fleetKeyRequired: boolean;
}

// Capability tags are operator-defined slugs; the shape bound keeps
// attacker-shaped strings out of the data layer.
const CAPABILITY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function createApp(deps: Deps): Hono {
  const app = new Hono();

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

  app.use("*", signatureAuth(deps.agents, deps.nonces));

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

  app.get("/me", (c) => {
    const { agentId, address, capabilities } = c.get("agent");
    return c.json({ agentId, address, capabilities: capabilities ?? [] });
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

  return app;
}
