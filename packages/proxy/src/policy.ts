import type { AgentRecord } from "@agent-identity/api";

/** The parsed, typed operation — exactly what issue #23's deterministic
 *  rules will pattern-match on. */
export interface ForgeOp {
  service: string;
  kind: "repo" | "commit" | "pr" | "comment" | "provision" | "fork";
  owner: string;
  repo: string;
}

export type PolicyDecision = { allow: true } | { allow: false; reason: string };

// Allow-all in the #22 MVP; #23 replaces the body, not the signature.
export function evaluate(_agent: AgentRecord, _op: ForgeOp): PolicyDecision {
  return { allow: true };
}

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
