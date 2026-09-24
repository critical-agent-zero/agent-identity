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
