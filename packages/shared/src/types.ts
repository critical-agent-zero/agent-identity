export interface AgentIdentity {
  agentId: string;        // numeric string, e.g. "482913"
  address: string;        // "482913@mail.example.com"
}

export type AuthVerdictStatus = "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED";

// SES receipt verdicts captured at ingest. Records stored before capture
// lack the field entirely — every reader must tolerate undefined.
export interface EmailAuthVerdicts {
  spf?: AuthVerdictStatus;
  dkim?: AuthVerdictStatus;
  dmarc?: AuthVerdictStatus;
  spam?: AuthVerdictStatus;
  virus?: AuthVerdictStatus;
}

export interface EmailSummary {
  id: string;             // ULID
  from: string;
  subject: string;
  receivedAt: string;     // ISO
  auth?: EmailAuthVerdicts;
  // Sender domain was not on the ingest allowlist. Records stored before the
  // allowlist (field absent) are grandfathered as solicited.
  unsolicited?: boolean;
}

export interface EmailFull extends EmailSummary {
  text: string;
  html?: string;
  links: string[];
}

export interface RegisterResponse extends AgentIdentity {}

// --- forge proxy DTOs (see docs/forge-access.md; history: docs/internal/specs/) ---

export interface RepoRef {
  owner: string;
  name: string;
}

export interface ForgeFile {
  path: string;
  content: string;
}

export interface CommitSpec {
  branch: string;
  message: string;
  files: ForgeFile[];
}

export interface PrSpec {
  head: string;
  base: string;
  title: string;
  body: string;
}

/** A repo's ACTUAL visibility on the forge, as read at attestation time.
 *  Deliberately binary: anything that is not world-readable ("private",
 *  GitLab "internal", GHES "internal", unknown) collapses to "private" —
 *  the public fleet tier publishes a forge event only when the proxy
 *  stamped detail.visibility === "public". */
export type RepoVisibility = "public" | "private";

export interface RepoInfo {
  defaultBranch: string;
  headSha: string;
}

export interface CommitResult {
  sha: string;
  url: string;
}

export interface PrResult {
  number: number;
  url: string;
}

export interface CommentResult {
  id: number;
  url: string;
}

export interface ForgeProvisionResult {
  username: string;
  email: string;
}

export interface ForkResult {
  owner: string;
  repo: string;
  defaultBranch: string;
}
