// ADVERSARIAL leak-hunt tests for the public fleet projection. Each test
// asserts the INVARIANT ("nothing about private repositories or free-text
// agent claims reaches the public tier"); a FAILING test here demonstrates a
// real hole, it does not indicate a broken test.
import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "./activity.js";
import { parseRepoAllowlist, publicView, repoMatchesAllowlist } from "./public-fleet.js";

const ALLOW = parseRepoAllowlist("critical-labs/*,acme/widgets");

const ev = (over: Partial<ActivityEvent>): ActivityEvent => ({
  agentId: "482913", ts: "2026-09-23T12:00:00.000Z", class: "attested",
  type: "forge_commit", summary: "s", ...over,
});

describe("ATTACK 1 — allowlist bypass probes (all must stay dropped)", () => {
  it("unicode case-folding lookalikes never match", () => {
    for (const evil of [
      "critical-labs/coreK",      // KELVIN SIGN lowercases to "k" -> "corek"; owner exact so only */wildcard would see it
      "crıtical-labs/core",        // dotless i
      "crİtical-labs/core",        // dotted capital I -> "i" + combining dot
      "critical-labſ/core",        // long s
      "ｃritical-labs/core",        // fullwidth c
      "critical-labs／core",        // fullwidth solidus instead of "/"
      "critical‐labs/core",        // unicode hyphen
      "critical-labs/co​re",       // zero-width space
      "critical-labs\u0000/core",  // NUL
      " critical-labs/core",       // outer whitespace
      "critical-labs/core ",
    ]) {
      // owner must be the literal ascii "critical-labs"; any fold/confusable fails
      if (evil === "critical-labs/coreK") {
        // owner is exact -> the wildcard applies; repo "corek" after folding is
        // ascii-clean, so this MATCHES critical-labs/* — acceptable only
        // because the owner segment itself is byte-exact (and the visibility
        // gate below still requires the proxy's "public" stamp). Document it:
        expect(repoMatchesAllowlist(evil, ALLOW)).toBe(true);
      } else {
        expect(repoMatchesAllowlist(evil, ALLOW), JSON.stringify(evil)).toBe(false);
      }
    }
  });

  it("structural probes never match", () => {
    for (const evil of [
      "critical-labs", "critical-labs/", "/critical-labs", "a/critical-labs/b",
      "critical-labs//core", "critical-labs/core/..", "critical-labs/..",
      "critical-labs-x/y", "x-critical-labs/y", "critical-labs.x/y",
    ]) {
      expect(repoMatchesAllowlist(evil, ALLOW), evil).toBe(false);
    }
  });

  it("forge events with detail.repo missing, non-string, or laundered are DROPPED not passed", () => {
    const cases: ActivityEvent[] = [
      ev({ detail: undefined }),                                     // no detail at all
      ev({ detail: { service: "github", branch: "m", sha: "a", visibility: "public" } }),  // detail without repo
      ev({ detail: { service: "github", repo: 42 as never, branch: "m", sha: "a", visibility: "public" } }),
      ev({ detail: { service: "github", repo: ["critical-labs", "core"] as never, branch: "m", sha: "a", visibility: "public" } }),
      ev({ class: "claimed", detail: { service: "github", repo: "critical-labs/core", branch: "m", sha: "a", visibility: "public" } }),
    ];
    for (const e of cases) expect(publicView([e], [], ALLOW).events, JSON.stringify(e.detail)).toEqual([]);
  });

  it("ref at an allowlisted repo cannot rescue an event whose detail.repo is private (and vice versa)", () => {
    // ref allowlisted, repo private -> whole event dropped
    const a = ev({
      detail: { service: "github", repo: "mc/homefree", branch: "m", sha: "a", visibility: "public" },
      ref: "https://github.com/critical-labs/core/commit/a",
    });
    expect(publicView([a], [], ALLOW).events).toEqual([]);
    // repo allowlisted, ref private -> event kept, ref dropped, private name absent
    const b = ev({
      detail: { service: "github", repo: "critical-labs/core", branch: "m", sha: "a", visibility: "public" },
      ref: "https://github.com/mc/homefree/commit/a",
    });
    const view = publicView([b], [], ALLOW);
    expect(view.events).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain("homefree");
  });

  it("ref path-normalization escapes (dot segments, backslashes, encoded slashes) are dropped", () => {
    for (const bad of [
      "https://github.com/critical-labs/core/../../mc/homefree/commit/a",
      "https://github.com/critical-labs/core\\..\\..\\mc\\homefree",
      "https://github.com/critical-labs/core%2f../homefree",
      "https://github.com./critical-labs/core",
    ]) {
      const view = publicView([ev({
        detail: { service: "github", repo: "critical-labs/core", branch: "m", sha: "a", visibility: "public" },
        ref: bad,
      })], [], ALLOW);
      expect(JSON.stringify(view), bad).not.toContain("homefree");
      expect(view.events[0], bad).not.toHaveProperty("ref");
    }
  });
});

describe("ATTACK 2 — wildcard allowlists vs actual repo visibility", () => {
  it("owner/* never publishes a PRIVATE repo of that owner — name, branch, sha all absent", () => {
    // The allowlist matches NAMES; an operator sets critical-labs/* because
    // the org's repos are public, and the org later gains a private repo.
    // Only the proxy's attestation-time visibility stamp may open the public
    // tier: an event whose repo the forge reports private stays out.
    const view = publicView([ev({
      summary: "committed to critical-labs/homefree-billing-internal@main",
      detail: { service: "github", repo: "critical-labs/homefree-billing-internal", branch: "main", sha: "a", visibility: "private" },
      ref: "https://github.com/critical-labs/homefree-billing-internal/commit/a",
    })], [], parseRepoAllowlist("critical-labs/*"));
    expect(JSON.stringify(view)).not.toContain("homefree-billing-internal");
  });

  it("an event with NO visibility stamp is dropped even when its repo name is allowlisted (fail closed)", () => {
    // Events attested before stamping existed — or by any writer that
    // forgot the stamp — carry no proof of public visibility: never shown.
    const view = publicView([ev({
      summary: "committed to critical-labs/homefree-billing-internal@main",
      detail: { service: "github", repo: "critical-labs/homefree-billing-internal", branch: "main", sha: "a" },
      ref: "https://github.com/critical-labs/homefree-billing-internal/commit/a",
    })], [], parseRepoAllowlist("critical-labs/*"));
    expect(JSON.stringify(view)).not.toContain("homefree-billing-internal");
  });

  it("visibility-shaped junk never passes the gate", () => {
    for (const junk of ["private", "internal", "PUBLIC", "Public", " public", "public ", true, 1] as const) {
      const view = publicView([ev({
        detail: { service: "github", repo: "critical-labs/core", branch: "m", sha: "a", visibility: junk as never },
      })], [], ALLOW);
      expect(view.events, JSON.stringify(junk)).toEqual([]);
    }
  });
});
