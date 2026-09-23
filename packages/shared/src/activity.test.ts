import { describe, expect, it } from "vitest";
import {
  ATTESTED_ACTIVITY_TYPES, CLAIMED_ACTIVITY_TYPES,
  sanitizeActivityText, STATUS_LABEL_MAX, TASK_NOTE_MAX,
} from "./activity.js";

const cp = (...codes: number[]) => String.fromCodePoint(...codes);

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
});
