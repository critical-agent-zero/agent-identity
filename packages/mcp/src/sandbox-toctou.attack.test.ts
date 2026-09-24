import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readInside, SandboxError } from "./sandbox.js";

// The forge tools read working-tree bytes and stream them into a commit on a
// fork. Invariant (d): the server must NEVER read a file outside the repo it
// is delivering. The classic way to break a resolve-then-read sandbox is a
// TOCTOU swap: pass the check with an innocent regular file, then replace it
// (or an ancestor directory) with a symlink pointing at ~/.ssh/id_rsa in the
// window before the bytes are read.
//
// `swap` is a one-shot hook fired from inside a mocked `openSync` — i.e. after
// readInside has resolved+checked the path and captured the inode it proved
// was inside, at the very instant it opens the file. That is exactly the
// resolve->read window the production bug left open. Each test arms it, then
// asserts the secret's bytes never come back.
const swap = vi.hoisted(() => ({ fn: null as null | (() => void) }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    openSync: (p: fs.PathLike, ...rest: unknown[]) => {
      if (swap.fn) { const f = swap.fn; swap.fn = null; f(); }
      return (actual.openSync as (...a: unknown[]) => number)(p, ...rest);
    },
  };
});
import type * as fs from "node:fs";

function fixture() {
  // realpath the temp root: macOS /tmp -> /private/tmp, and readInside
  // realpaths the root, so the fixture must too.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sbx-toctou-")));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "innocent.txt"), "INNOCENT");
  writeFileSync(join(root, "sub", "nested.txt"), "INNOCENT-NESTED");
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "sbx-secret-")));
  writeFileSync(join(outside, "secret"), "TOP SECRET id_rsa");
  return { root, outside };
}

afterEach(() => { swap.fn = null; });

describe("readInside TOCTOU exfiltration (invariant d)", () => {
  it("rejects a leaf swapped to an out-of-sandbox symlink between check and read", () => {
    const { root, outside } = fixture();
    const secret = join(outside, "secret");
    const leaf = join(root, "innocent.txt");
    // Swap the just-blessed regular file for a symlink to the secret at the
    // exact moment readInside opens it.
    swap.fn = () => { unlinkSync(leaf); symlinkSync(secret, leaf); };

    let bytes: Buffer | undefined;
    expect(() => { bytes = readInside(root, "innocent.txt"); }).toThrow(SandboxError);
    expect(bytes).toBeUndefined(); // threw; the secret was never read
  });

  it("rejects a middle directory swapped to an out-of-sandbox symlink between check and read", () => {
    const { root, outside } = fixture();
    // What the swapped `sub` symlink would expose: outside/nested.txt.
    writeFileSync(join(outside, "nested.txt"), "TOP SECRET nested");
    const subDir = join(root, "sub");
    // Replace the intermediate directory with a symlink pointing outside the
    // sandbox, in the resolve->read window. O_NOFOLLOW only guards the leaf,
    // so this escape is caught by the opened fd's inode not matching the one
    // the containment check resolved.
    swap.fn = () => { rmSync(subDir, { recursive: true, force: true }); symlinkSync(outside, subDir); };

    let bytes: Buffer | undefined;
    expect(() => { bytes = readInside(root, "sub/nested.txt"); }).toThrow(SandboxError);
    expect(bytes).toBeUndefined(); // threw; the secret was never read
  });

  it("still reads a genuine in-sandbox file when nothing is swapped", () => {
    const { root } = fixture();
    expect(readInside(root, "innocent.txt").toString()).toBe("INNOCENT");
    expect(readInside(root, "sub/nested.txt").toString()).toBe("INNOCENT-NESTED");
  });

  it("rejects a path that resolves outside the root (no swap needed)", () => {
    const { root, outside } = fixture();
    symlinkSync(join(outside, "secret"), join(root, "escape"));
    expect(() => readInside(root, "escape")).toThrow(SandboxError);
  });
});
