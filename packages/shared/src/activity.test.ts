import { describe, expect, it } from "vitest";
import {
  ATTESTED_ACTIVITY_TYPES, ATTESTED_TEXT_MAX, CLAIMED_ACTIVITY_TYPES,
  sanitizeActivityText, sanitizeAttestedEvent, STATUS_LABEL_MAX, TASK_NOTE_MAX,
  type ActivityEvent,
} from "./activity.js";

const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const NL = cp(0x0a);
const TAB = cp(0x09);
const CR = cp(0x0d);
const RLO = cp(0x202e);
const ZWSP = cp(0x200b);

describe("activity type sets", () => {
  it("keeps attested and claimed types disjoint", () => {
    for (const t of CLAIMED_ACTIVITY_TYPES) {
      expect(ATTESTED_ACTIVITY_TYPES).not.toContain(t);
    }
  });

  it("claimed set is exactly the self-reportable types", () => {
    expect([...CLAIMED_ACTIVITY_TYPES].sort()).toEqual(["status", "task_note"]);
  });
});

describe("sanitizeActivityText", () => {
  it("strips ANSI/control and invisible characters like stored mail text", () => {
    const dirty = `ok${cp(0x1b)}[31m evil${cp(0x200b)}${cp(0x202e)}`;
    expect(sanitizeActivityText(dirty, 120)).toBe("ok[31m evil");
  });

  it("caps length after sanitizing", () => {
    // 120 control chars followed by 200 'a's: naive cap-then-sanitize would
    // leave far fewer than 120 visible characters.
    const dirty = cp(0x1b).repeat(120) + "a".repeat(200);
    expect(sanitizeActivityText(dirty, STATUS_LABEL_MAX)).toBe("a".repeat(120));
  });

  it("exposes the fixed caps", () => {
    expect(STATUS_LABEL_MAX).toBe(120);
    expect(TASK_NOTE_MAX).toBe(500);
  });

  it("collapses newlines and tabs to a single space — no line injection", () => {
    // Activity text is single-line; a kept \n would let claimed text
    // fabricate an extra feed row in line-oriented renderings.
    expect(sanitizeActivityText(`ok${NL}[attested] fake${TAB}row`, 120))
      .toBe("ok [attested] fake row");
    expect(sanitizeActivityText(`a${CR}${NL}${NL}${TAB}b`, 120)).toBe("a b");
  });
});

describe("sanitizeAttestedEvent", () => {
  const base: ActivityEvent = {
    agentId: "482913", ts: "2026-07-04T10:00:00.000Z",
    class: "attested", type: "forge_commit", summary: "s",
  };

  it("sanitizes and caps summary, string detail values, and ref", () => {
    const dirty = `b${RLO}${ZWSP}${NL}x` + "a".repeat(1000);
    const out = sanitizeAttestedEvent({
      ...base,
      summary: `committed to o/r@${dirty}`,
      detail: { branch: dirty, sha: "c1", issue: 12, ok: true },
      ref: `https://forge/${cp(0x1b)}]8;;evil`,
    });
    for (const value of [out.summary, out.detail!.branch as string, out.ref!]) {
      for (const bad of [RLO, ZWSP, NL, TAB]) expect(value).not.toContain(bad);
      expect(value.length).toBeLessThanOrEqual(ATTESTED_TEXT_MAX);
    }
    expect(out.detail).toEqual(expect.objectContaining({ sha: "c1", issue: 12, ok: true }));
    expect(out.ref).toBe("https://forge/]8;;evil");
  });

  it("leaves clean events untouched and preserves class/type/agentId", () => {
    const clean = {
      ...base,
      summary: "committed to o/r@main",
      detail: { repo: "o/r", branch: "main", sha: "c1" },
      ref: "https://forge/c1",
    };
    expect(sanitizeAttestedEvent(clean)).toEqual(clean);
  });
});
