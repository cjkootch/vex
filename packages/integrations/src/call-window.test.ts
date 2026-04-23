import { describe, expect, it } from "vitest";
import { checkCallWindow, inferTimezone } from "./call-window.js";

describe("inferTimezone", () => {
  it("maps US Eastern area codes to America/New_York", () => {
    expect(inferTimezone("+12125551234")).toBe("America/New_York");
    expect(inferTimezone("+19175551234")).toBe("America/New_York");
  });

  it("maps US Central area codes to America/Chicago", () => {
    expect(inferTimezone("+13125551234")).toBe("America/Chicago");
    expect(inferTimezone("+18325551234")).toBe("America/Chicago");
  });

  it("maps US Pacific area codes to America/Los_Angeles", () => {
    expect(inferTimezone("+14155551234")).toBe("America/Los_Angeles");
    expect(inferTimezone("+13105551234")).toBe("America/Los_Angeles");
  });

  it("maps Caribbean area codes to the correct island tz", () => {
    expect(inferTimezone("+18765551234")).toBe("America/Jamaica");
    expect(inferTimezone("+18685551234")).toBe("America/Port_of_Spain");
    expect(inferTimezone("+18095551234")).toBe("America/Santo_Domingo");
    expect(inferTimezone("+17875551234")).toBe("America/Puerto_Rico");
  });

  it("falls back to America/New_York for unknown NANP area codes", () => {
    // 999 isn't a real area code — heuristic falls back.
    expect(inferTimezone("+19995551234")).toBe("America/New_York");
  });

  it("maps non-NANP country codes to a representative tz", () => {
    expect(inferTimezone("+525512345678")).toBe("America/Mexico_City");
    expect(inferTimezone("+442071234567")).toBe("Europe/London");
    expect(inferTimezone("+819012345678")).toBe("Asia/Tokyo");
  });

  it("normalizes formatting before matching", () => {
    expect(inferTimezone("+1 (876) 555-1234")).toBe("America/Jamaica");
    expect(inferTimezone("+1-212-555-1234")).toBe("America/New_York");
  });

  it("returns null for malformed numbers", () => {
    expect(inferTimezone("12125551234")).toBeNull();
    expect(inferTimezone("not-a-number")).toBeNull();
    expect(inferTimezone("")).toBeNull();
  });
});

describe("checkCallWindow", () => {
  // 2026-04-20 at 15:00 UTC -> 11:00 America/New_York (EDT, UTC-4)
  const ELEVEN_AM_ET = new Date("2026-04-20T15:00:00Z");
  // 2026-04-20 at 04:00 UTC -> 00:00 America/New_York -> graveyard
  const MIDNIGHT_ET = new Date("2026-04-20T04:00:00Z");
  // 2026-04-20 at 01:00 UTC -> 21:00 America/New_York -> past 8pm
  const NINE_PM_ET = new Date("2026-04-20T01:00:00Z");

  it("allows calls during 9–20 local time", () => {
    const result = checkCallWindow({
      to: "+12125551234",
      now: ELEVEN_AM_ET,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.timezone).toBe("America/New_York");
      expect(result.localHour).toBe(11);
    }
  });

  it("blocks calls during early-morning hours", () => {
    const result = checkCallWindow({
      to: "+12125551234",
      now: MIDNIGHT_ET,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("outside_window");
      expect(result.timezone).toBe("America/New_York");
      expect(result.localHour).toBe(0);
    }
  });

  it("blocks calls at or after 20:00 local", () => {
    const result = checkCallWindow({
      to: "+12125551234",
      now: NINE_PM_ET,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.localHour).toBe(21);
  });

  it("uses the caller-supplied timezone override when provided", () => {
    // 15:00 UTC -> 17:00 Europe/Paris (CEST, UTC+2)
    const result = checkCallWindow({
      to: "+12125551234",
      timezone: "Europe/Paris",
      now: new Date("2026-04-20T15:00:00Z"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.timezone).toBe("Europe/Paris");
  });

  it("allows a custom open/close window", () => {
    // 15:00 UTC -> 11:00 ET; restrict to 12–18 -> should block.
    const result = checkCallWindow({
      to: "+12125551234",
      now: ELEVEN_AM_ET,
      openHour: 12,
      closeHour: 18,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("outside_window");
  });

  it("returns invalid_number for unparseable phone input", () => {
    const result = checkCallWindow({ to: "not-a-number" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_number");
      expect(result.timezone).toBeNull();
    }
  });

  it("gates Caribbean counterparties in their local tz", () => {
    // 13:00 UTC -> 09:00 America/Port_of_Spain (Trinidad, UTC-4)
    const result = checkCallWindow({
      to: "+18685551234",
      now: new Date("2026-04-20T13:00:00Z"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.timezone).toBe("America/Port_of_Spain");
      expect(result.localHour).toBe(9);
    }
  });
});
