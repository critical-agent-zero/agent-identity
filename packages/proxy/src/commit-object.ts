import type { Author } from "./forge.js";

export interface CommitObjectSpec {
  /** The tree sha this commit points at. */
  tree: string;
  /** Parent commit shas, in order (empty for a root commit). */
  parents: string[];
  author: Author;
  committer: Author;
  message: string;
  /** One Unix-seconds instant used for BOTH the author and committer dates.
   *  Captured once by the caller so the signed bytes and the ISO dates handed
   *  to the API describe the same moment (always in UTC / +0000). */
  unixSec: number;
}

/**
 * The exact byte payload git signs for a commit — `git cat-file commit`'s
 * output — and the bytes GitHub reconstructs from a git-data create-commit
 * request. An SSH signature over these bytes is what makes GitHub report the
 * commit `verified` (issue #120), so the layout must be identical to git's:
 * `tree`, then a `parent` line per parent, `author`, `committer`, a blank
 * line, then the message. Dates are `<unixSec> +0000` (UTC); the message is
 * given a trailing newline if it lacks one (git's object convention) but an
 * existing newline is never doubled.
 */
export function canonicalCommitObject(spec: CommitObjectSpec): Buffer {
  const { tree, parents, author, committer, message, unixSec } = spec;
  const ident = (who: Author) => `${who.name} <${who.email}> ${unixSec} +0000`;
  const headers =
    `tree ${tree}\n`
    + parents.map((p) => `parent ${p}\n`).join("")
    + `author ${ident(author)}\n`
    + `committer ${ident(committer)}\n`;
  const body = message.endsWith("\n") ? message : `${message}\n`;
  return Buffer.from(`${headers}\n${body}`, "utf8");
}
