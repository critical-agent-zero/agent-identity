import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIX_KEY, FIX_MSG, FIX_SIG } from "./sshsig.fixture.js";
import { sshSign } from "./sshsig.js";

/** ssh-keygen is present in CI and on dev boxes but not guaranteed. When it is
 *  absent the live oracle is skipped; the frozen FIX_SIG fixture (itself an
 *  ssh-keygen output) still runs and pins the exact bytes. */
function sshKeygenAvailable(): boolean {
  try {
    execFileSync("ssh-keygen", ["-Y"], { stdio: "ignore" });
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
const liveIt = sshKeygenAvailable() ? it : it.skip;

describe("sshSign (SSHSIG, namespace git, sha512)", () => {
  it("matches the frozen ssh-keygen fixture byte-for-byte (always-on oracle)", () => {
    expect(sshSign(FIX_MSG, FIX_KEY)).toBe(FIX_SIG);
  });

  liveIt("equals `ssh-keygen -Y sign -n git` byte-for-byte across random messages", () => {
    const dir = mkdtempSync(join(tmpdir(), "sshsig-gold-"));
    const keyPath = join(dir, "key");
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "gold@test", "-f", keyPath],
      { stdio: "ignore" });
    const pem = readFileSync(keyPath, "utf8");
    for (let i = 0; i < 6; i++) {
      const msg = randomBytes(1 + i * 13);
      const msgPath = join(dir, `m${i}`);
      writeFileSync(msgPath, msg);
      execFileSync("ssh-keygen", ["-Y", "sign", "-f", keyPath, "-n", "git", msgPath],
        { stdio: "ignore" });
      const reference = readFileSync(`${msgPath}.sig`, "utf8");
      expect(sshSign(msg, pem)).toBe(reference);
    }
  });

  it("armors as BEGIN/END SSH SIGNATURE with base64 wrapped at 70 columns", () => {
    const out = sshSign(FIX_MSG, FIX_KEY);
    const lines = out.split("\n");
    expect(lines[0]).toBe("-----BEGIN SSH SIGNATURE-----");
    expect(lines.filter((l) => l && !l.includes("SSH SIGNATURE"))
      .every((l) => l.length <= 70)).toBe(true);
    expect(out.trimEnd().endsWith("-----END SSH SIGNATURE-----")).toBe(true);
  });

  it("refuses an encrypted OpenSSH key rather than emit a wrong signature", () => {
    const dir = mkdtempSync(join(tmpdir(), "sshsig-enc-"));
    const keyPath = join(dir, "key");
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "hunter2", "-f", keyPath],
      { stdio: "ignore" });
    const pem = readFileSync(keyPath, "utf8");
    expect(() => sshSign(FIX_MSG, pem)).toThrow();
  });
});
