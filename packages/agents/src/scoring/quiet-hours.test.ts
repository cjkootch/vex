import { describe, expect, it } from "vitest";
import { canContactNow } from "./quiet-hours.js";

describe("canContactNow", () => {
  it("allows 14:00 America/New_York (default window)", () => {
    // 18:00 UTC = 14:00 EDT. Inside 08:00-21:00.
    const d = canContactNow(new Date("2026-04-18T18:00:00Z"), "America/New_York");
    expect(d.ok).toBe(true);
    expect(d.localHour).toBe(14);
  });

  it("blocks 02:00 America/New_York with reason=quiet_hours", () => {
    const d = canContactNow(new Date("2026-04-18T06:00:00Z"), "America/New_York");
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("quiet_hours");
    expect(d.localHour).toBe(2);
  });

  it("blocks 23:00 recipient-local (evening cutoff)", () => {
    // 03:00 UTC = 23:00 America/New_York (prior day).
    const d = canContactNow(new Date("2026-04-18T03:00:00Z"), "America/New_York");
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("quiet_hours");
  });

  it("treats endHour as exclusive (21:00 blocks, 20:59 passes)", () => {
    // 21:00 UTC = 17:00 America/New_York, fine.
    // We want exactly 21:00 local → UTC 01:00 next day.
    const blocked = canContactNow(new Date("2026-04-19T01:00:00Z"), "America/New_York");
    expect(blocked.ok).toBe(false);
    expect(blocked.localHour).toBe(21);
  });

  it("falls back to UTC when timezone is null", () => {
    // 14:00 UTC with no tz — still inside default window.
    const d = canContactNow(new Date("2026-04-18T14:00:00Z"), null);
    expect(d.ok).toBe(true);
    expect(d.timezone).toBe("UTC");
  });

  it("returns invalid_timezone for an unknown IANA string", () => {
    const d = canContactNow(new Date("2026-04-18T14:00:00Z"), "Foo/Bar");
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("invalid_timezone");
  });

  it("honors a custom window", () => {
    // 14:00 UTC with window [15, 18): 14 is outside → block.
    const d = canContactNow(
      new Date("2026-04-18T14:00:00Z"),
      "UTC",
      { startHour: 15, endHour: 18 },
    );
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("quiet_hours");
  });
});
