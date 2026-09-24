import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalCommitObject } from "./commit-object.js";

const UNIX = 1_758_709_800; // 2025-09-24T10:30:00Z, a fixed instant
const author = { name: "482913", email: "482913@agents.example" };
const committer = { name: "critical-agent-zero", email: "299802836+critical-agent-zero@users.noreply.github.com" };

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
const oracleIt = gitAvailable() ? it : it.skip;

/** Build the SAME commit object with real git and return its raw payload — the
 *  exact bytes git signs (and GitHub reconstructs), our correctness oracle. */
function gitCommitObject(parents: string[], message: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "commitobj-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email,
    GIT_AUTHOR_DATE: `${UNIX} +0000`, GIT_COMMITTER_DATE: `${UNIX} +0000`,
  };
  const git = (args: string[], input?: string) =>
    execFileSync("git", ["-C", dir, ...args], { input, env });
  git(["init", "-q"]);
  const emptyTree = git(["hash-object", "-t", "tree", "/dev/null"]).toString().trim();
  const commitArgs = ["commit-tree", emptyTree, ...parents.flatMap((p) => ["-p", p])];
  const sha = git(commitArgs, message).toString().trim();
  const raw = execFileSync("git", ["-C", dir, "cat-file", "commit", sha], { env });
  return raw;
}

describe("canonicalCommitObject", () => {
  it("emits the exact git object byte layout for a root commit", () => {
    const out = canonicalCommitObject({
      tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      parents: [], author, committer, message: "feat: x\n", unixSec: UNIX,
    });
    expect(out.toString("utf8")).toBe(
      "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n"
      + `author 482913 <482913@agents.example> ${UNIX} +0000\n`
      + `committer critical-agent-zero <299802836+critical-agent-zero@users.noreply.github.com> ${UNIX} +0000\n`
      + "\n"
      + "feat: x\n",
    );
  });

  it("emits a parent line per parent, in order", () => {
    const out = canonicalCommitObject({
      tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      parents: ["1111111111111111111111111111111111111111", "2222222222222222222222222222222222222222"],
      author, committer, message: "m\n", unixSec: UNIX,
    }).toString("utf8");
    expect(out).toContain(
      "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n"
      + "parent 1111111111111111111111111111111111111111\n"
      + "parent 2222222222222222222222222222222222222222\n"
      + "author ",
    );
  });

  it("ensures the message ends with a newline (git's object convention)", () => {
    const out = canonicalCommitObject({
      tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      parents: [], author, committer, message: "feat: no trailing newline", unixSec: UNIX,
    }).toString("utf8");
    expect(out.endsWith("feat: no trailing newline\n")).toBe(true);
    // and does not double a newline that is already present
    const out2 = canonicalCommitObject({
      tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      parents: [], author, committer, message: "already\n", unixSec: UNIX,
    }).toString("utf8");
    expect(out2.endsWith("already\n")).toBe(true);
    expect(out2.endsWith("already\n\n")).toBe(false);
  });

  oracleIt("equals `git commit-tree` output byte-for-byte — root commit (GOLD)", () => {
    const message = "feat(forge): SSH-signed commits\n\nagent commits are Verified.\n";
    const oracle = gitCommitObject([], message);
    const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const mine = canonicalCommitObject({
      tree: emptyTree, parents: [], author, committer, message, unixSec: UNIX,
    });
    expect(mine.equals(oracle)).toBe(true);
  });

  oracleIt("equals `git commit-tree` output byte-for-byte — commit with a parent (GOLD)", () => {
    // A real parent commit sha, produced by git in the same repo semantics.
    const parentMsg = "root\n";
    // Recreate deterministically: the root object's sha is a function of its
    // bytes, so compute the parent via git in a throwaway repo, then build a
    // child pointing at it and compare both git and ours use the same parent.
    const dir = mkdtempSync(join(tmpdir(), "commitobj-parent-"));
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email,
      GIT_AUTHOR_DATE: `${UNIX} +0000`, GIT_COMMITTER_DATE: `${UNIX} +0000`,
    };
    const git = (args: string[], input?: string) =>
      execFileSync("git", ["-C", dir, ...args], { input, env });
    git(["init", "-q"]);
    const emptyTree = git(["hash-object", "-t", "tree", "/dev/null"]).toString().trim();
    const parentSha = git(["commit-tree", emptyTree], parentMsg).toString().trim();
    const childMsg = "child commit body\n";
    const childSha = git(["commit-tree", emptyTree, "-p", parentSha], childMsg).toString().trim();
    const oracle = execFileSync("git", ["-C", dir, "cat-file", "commit", childSha], { env });
    const mine = canonicalCommitObject({
      tree: emptyTree, parents: [parentSha], author, committer, message: childMsg, unixSec: UNIX,
    });
    expect(mine.equals(oracle)).toBe(true);
  });
});
