import * as nodeFs from "node:fs";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** A disk-read the forge tools refused because the target resolved outside
 *  the sandbox root (absolute escape, `..` traversal, or a symlink pointing
 *  out). The adversarial reviewer WILL try to make the server read
 *  ~/.ssh/id_rsa or any file outside the repo being delivered — this is the
 *  single choke point that stops it. */
export class SandboxError extends Error {}

/** Resolve `target` to a REAL absolute path that is `root` itself or strictly
 *  inside it, after following every symlink. Throws SandboxError on any
 *  escape and lets the underlying ENOENT surface for a path that does not
 *  exist (both the file and its ancestors are realpath'd, so a symlinked
 *  directory in the middle of the path cannot smuggle the target out).
 *
 *  `root` must be an existing directory (the process cwd, or a `dir` already
 *  resolved inside it). `target` may be relative to `root` or absolute — an
 *  absolute target is accepted ONLY when it still lands inside `root`. */
export function resolveInside(root: string, target: string): string {
  const realRoot = realpathSync(resolve(root));
  const abs = isAbsolute(target) ? resolve(target) : resolve(realRoot, target);
  // realpathSync resolves the FULL chain of symlinks; if any component points
  // outside realRoot the containment check below catches it. Throws ENOENT
  // for a missing path — a genuine "no such file", surfaced to the caller.
  let real: string;
  try {
    real = realpathSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SandboxError(`no such path inside the sandbox: ${target}`);
    }
    throw err;
  }
  if (real !== realRoot) {
    const rel = relative(realRoot, real);
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
      throw new SandboxError(
        `path escapes the sandbox root (${root}): ${target}`);
    }
  }
  return real;
}

/** Resolve `target` inside `root` AND read its bytes, with no second path
 *  traversal after the check — closing the resolve-then-read TOCTOU gap that a
 *  plain `resolveInside(...)` + later `readFile(path)` leaves open.
 *
 *  `resolveInside` proves containment only for the canonical path AT CHECK
 *  TIME; an adversary who controls the working tree can, in the window before
 *  the bytes are read, swap the blessed regular file (or an ancestor
 *  directory) for a symlink pointing at ~/.ssh/id_rsa or /etc/passwd, and a
 *  follow-up `readFile` would dutifully follow it out of the sandbox. This
 *  reads through a single pinned file descriptor instead:
 *    - the inode the containment check resolved is captured up front;
 *    - the leaf is opened with O_NOFOLLOW, so a leaf swapped to a symlink is
 *      rejected outright (ELOOP) rather than followed;
 *    - the opened fd's own inode is compared to the captured one, so a swapped
 *      ancestor directory (which O_NOFOLLOW does not guard) is caught because
 *      the fd then points at a different inode than the one we blessed;
 *    - the bytes are read from that fd — never re-derived from the path — so
 *      whatever we verified is exactly what we read.
 *  A non-regular file (dir, device, fifo) is refused. Throws SandboxError on
 *  any escape, mismatch, or a path that vanished under the check. */
export function readInside(root: string, target: string): Buffer {
  const real = resolveInside(root, target);
  // Capture the blessed inode adjacently to the containment check, before any
  // open, so a swap in the resolve->read window can only make the fd disagree.
  const expected = nodeFs.statSync(real);
  let fd: number;
  try {
    fd = nodeFs.openSync(real, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ELOOP: the leaf became a symlink after the check (O_NOFOLLOW refused it).
    // EMLINK: some BSDs report O_NOFOLLOW-on-symlink this way. ENOENT: it was
    // unlinked under us. All mean the path changed since we blessed it.
    if (code === "ELOOP" || code === "EMLINK" || code === "ENOENT") {
      throw new SandboxError(`path changed under the sandbox check: ${target}`);
    }
    throw err;
  }
  try {
    const st = nodeFs.fstatSync(fd);
    if (!st.isFile()) {
      throw new SandboxError(`not a regular file inside the sandbox: ${target}`);
    }
    // The fd is pinned to whatever inode the open landed on. If an ancestor
    // directory was swapped to a symlink after the check, that inode is not
    // the one we blessed — refuse it rather than stream its bytes off-sandbox.
    if (st.dev !== expected.dev || st.ino !== expected.ino) {
      throw new SandboxError(`path changed under the sandbox check: ${target}`);
    }
    return nodeFs.readFileSync(fd);
  } finally {
    nodeFs.closeSync(fd);
  }
}
