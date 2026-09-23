// Fleet activity ledger types shared by the API, proxy, ingest, and MCP
// packages. Design principle (docs/): agents stay separate and autonomous —
// ATTESTED events are written only by infrastructure that observed the act;
// CLAIMED events are signed agent self-reports. No path may ever store or
// return a claimed event as attested.
import { sanitizeMailText } from "./mail.js";

export const ATTESTED_ACTIVITY_TYPES = [
  "forge_commit", "forge_fork", "forge_pr", "forge_comment",
  "email_received", "capability_granted",
] as const;

export const CLAIMED_ACTIVITY_TYPES = ["status", "task_note"] as const;

export type AttestedActivityType = (typeof ATTESTED_ACTIVITY_TYPES)[number];
export type ClaimedActivityType = (typeof CLAIMED_ACTIVITY_TYPES)[number];
export type ActivityClass = "attested" | "claimed";

export const STATUS_STATES = ["working", "idle", "blocked"] as const;
export type AgentStatusState = (typeof STATUS_STATES)[number];

// Hard caps on agent-supplied strings, enforced at WRITE time.
export const STATUS_LABEL_MAX = 120;
export const TASK_NOTE_MAX = 500;

export interface ActivityEvent {
  agentId: string;
  ts: string;                       // ISO timestamp
  class: ActivityClass;
  type: AttestedActivityType | ClaimedActivityType;
  summary: string;
  // Structured, type-specific fields, e.g. { repo, sha, branch } for
  // forge_commit or { senderDomain } for email_received (never subject/body).
  detail?: Record<string, string | number | boolean>;
  ref?: string;                     // canonical URL of the act, when one exists
}

/** The overwritten per-agent STATUS row. */
export interface AgentStatus {
  state: AgentStatusState;
  label?: string;
  updatedAt: string;                // ISO
}

/** What readers get: staleness is computed server-side at read time. */
export interface AgentStatusView extends AgentStatus {
  stale: boolean;
}

// Same storage-layer character defense as stored mail (ANSI/C1, zero-width,
// bidi overrides), then the hard length cap. Sanitize FIRST so stripped
// characters cannot be used to smuggle length past the cap.
export function sanitizeActivityText(text: string, max: number): string {
  return sanitizeMailText(text).slice(0, max);
}
