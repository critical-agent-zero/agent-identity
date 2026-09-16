import type { AgentRecord } from "@agent-identity/api";
import { describe, expect, it } from "vitest";
import { evaluate, forkNamespacePolicy } from "./policy.js";

const agent: AgentRecord = {
  agentId: "482913", address: "482913@d", publicKey: "pk",
  status: "active", createdAt: "t", capabilities: ["github"],
};

describe("policy", () => {
  it("allows everything in the MVP", () => {
    expect(evaluate(agent, {
      service: "github", kind: "commit", owner: "critical-labs", repo: "agent-identity",
    })).toEqual({ allow: true });
  });
});

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
