import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInside, SandboxError } from "./sandbox.js";

function fixture() {
  // realpath the temp root itself: macOS /tmp is a symlink to /private/tmp,
  // and the resolver realpaths the root, so the fixture must too.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-")));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "in.txt"), "inside");
  writeFileSync(join(root, "sub", "nested.txt"), "nested");
  // a secret living OUTSIDE the root
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "outside-")));
  writeFileSync(join(outside, "secret"), "TOP SECRET");
  return { root, outside };
}

describe("resolveInside", () => {
  it("accepts a repo-relative file inside the root", () => {
    const { root } = fixture();
    expect(resolveInside(root, "in.txt")).toBe(join(root, "in.txt"));
    expect(resolveInside(root, "sub/nested.txt")).toBe(join(root, "sub", "nested.txt"));
  });

  it("accepts an absolute path that still lands inside the root", () => {
    const { root } = fixture();
    expect(resolveInside(root, join(root, "in.txt"))).toBe(join(root, "in.txt"));
  });

  it("rejects a `..` traversal that escapes the root", () => {
    const { root, outside } = fixture();
    expect(() => resolveInside(root, `../${join(outside, "secret").split("/").pop()}`))
      .toThrow(SandboxError);
    expect(() => resolveInside(root, "../../etc/passwd")).toThrow(SandboxError);
  });

  it("rejects an absolute path outside the root (e.g. ~/.ssh/id_rsa)", () => {
    const { root, outside } = fixture();
    expect(() => resolveInside(root, join(outside, "secret"))).toThrow(SandboxError);
  });

  it("rejects a symlink whose target points outside the root", () => {
    const { root, outside } = fixture();
    symlinkSync(join(outside, "secret"), join(root, "escape"));
    expect(() => resolveInside(root, "escape")).toThrow(SandboxError);
  });

  it("rejects a symlinked directory component that escapes the root", () => {
    const { root, outside } = fixture();
    symlinkSync(outside, join(root, "outlink"));
    expect(() => resolveInside(root, "outlink/secret")).toThrow(SandboxError);
  });

  it("accepts a symlink that stays inside the root", () => {
    const { root } = fixture();
    symlinkSync(join(root, "in.txt"), join(root, "alias"));
    expect(resolveInside(root, "alias")).toBe(join(root, "in.txt"));
  });

  it("reports a missing path as a SandboxError, never a raw read of elsewhere", () => {
    const { root } = fixture();
    expect(() => resolveInside(root, "does-not-exist.txt")).toThrow(SandboxError);
  });
});
