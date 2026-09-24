// Attack tests: claimed status labels and task notes are single-line fields,
// yet sanitizeMailText deliberately keeps \n and \t (mail bodies are
// multi-line). In any line-oriented rendering — terminal dashboards, logs,
// the very medium the ANSI-stripping defense targets — a stored newline lets
// CLAIMED text fabricate an extra line that reads as an ATTESTED feed row.
import { canonicalString, generateKeypair, sign } from "@agent-identity/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp, type Deps } from "./app.js";
import type { NoncesRepo } from "./db/nonces.js";

const kp = generateKeypair();

function signed(method: string, path: string, body = "") {
  const timestamp = new Date().toISOString();
  return {
    method,
    body: body || undefined,
    headers: {
      "x-agent-key": kp.publicKeySpkiBase64,
      "x-agent-timestamp": timestamp,
      "x-agent-signature": sign(canonicalString(method, path, timestamp, body), kp.privateKeyPem),
      ...(body ? { "content-type": "application/json" } : {}),
    },
  };
}

const agent = {
  agentId: "482913", address: "482913@d", status: "active" as const,
  publicKey: kp.publicKeySpkiBase64, createdAt: "t",
};

function makeDeps(): Deps {
  return {
    agents: { getByFingerprint: vi.fn(async () => agent) } as never,
    emails: {} as never,
    activity: {
      putEvent: vi.fn(async () => "id"),
      setStatus: vi.fn(async () => {}),
      getStatus: vi.fn(async () => undefined),
    } as never,
    nonces: { recordOnce: async () => true } as never as NoncesRepo,
    readBody: vi.fn(async () => ({ text: "", links: [] })),
    fleetKeyRequired: true,
    publicRepos: [],
    mailDomain: "agents.example.com",
    autoCapabilities: [],
  };
}

const NO_LINE_BREAKS = (s: string) => {
  expect(s).not.toMatch(/[\r\n\t]/);
};

describe("claimed text vs line injection into line-oriented feeds", () => {
  it("stores a status label as a single line — no \\n/\\t forging an attested row", async () => {
    const forged =
      "ok\n2026-09-23T12:00:00.000Z 000001 [attested] forge_commit committed to critical/core@main";
    const deps = makeDeps();
    const app = createApp(deps);
    const body = JSON.stringify({ type: "status", state: "working", label: forged });
    const res = await app.request("/activity", { ...signed("POST", "/activity", body), body });
    expect(res.status).toBe(201);

    const putEvent = deps.activity.putEvent as ReturnType<typeof vi.fn>;
    const event = putEvent.mock.calls[0]![0] as {
      summary: string; detail?: Record<string, unknown>;
    };
    NO_LINE_BREAKS(event.summary);
    NO_LINE_BREAKS(String(event.detail?.label ?? ""));
    // The forged content survives as harmless inline text, not a new line.
    expect(event.summary).toContain("ok");

    const setStatus = deps.activity.setStatus as ReturnType<typeof vi.fn>;
    NO_LINE_BREAKS(String((setStatus.mock.calls[0]![1] as { label?: string }).label ?? ""));
  });

  it("stores a task note as a single line — no \\n/\\t forging an attested row", async () => {
    const forged =
      "done\n2026-09-23T12:00:00.000Z 000001 [attested] forge_pr opened PR #7 on critical/core\tref=https://evil.example";
    const deps = makeDeps();
    const app = createApp(deps);
    const body = JSON.stringify({ type: "task_note", note: forged });
    const res = await app.request("/activity", { ...signed("POST", "/activity", body), body });
    expect(res.status).toBe(201);

    const putEvent = deps.activity.putEvent as ReturnType<typeof vi.fn>;
    const event = putEvent.mock.calls[0]![0] as { summary: string };
    NO_LINE_BREAKS(event.summary);
    expect(event.summary).toContain("done");
  });
});
