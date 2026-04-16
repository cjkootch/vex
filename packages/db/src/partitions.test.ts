import { describe, expect, it, vi } from "vitest";
import { createNextMonthPartitions, monthPartitionBounds, nextMonth } from "./partitions.js";

describe("monthPartitionBounds", () => {
  it("names partitions as <parent>_YYYY_MM", () => {
    const bounds = monthPartitionBounds(new Date(Date.UTC(2026, 4, 15)));
    expect(bounds.name("events")).toBe("events_2026_05");
    expect(bounds.name("raw_events")).toBe("raw_events_2026_05");
  });

  it("uses inclusive-start exclusive-end date strings", () => {
    const bounds = monthPartitionBounds(new Date(Date.UTC(2026, 11, 1)));
    expect(bounds.from).toBe("2026-12-01");
    expect(bounds.to).toBe("2027-01-01");
  });
});

describe("nextMonth", () => {
  it("advances to the first day of the following month in UTC", () => {
    const next = nextMonth(new Date(Date.UTC(2026, 3, 16, 23, 59)));
    expect(next.toISOString().slice(0, 10)).toBe("2026-05-01");
  });

  it("rolls the year over correctly", () => {
    const next = nextMonth(new Date(Date.UTC(2026, 11, 10)));
    expect(next.toISOString().slice(0, 10)).toBe("2027-01-01");
  });
});

describe("createNextMonthPartitions", () => {
  it("issues CREATE TABLE IF NOT EXISTS for both partitioned tables", async () => {
    const execute = vi.fn(async () => undefined);
    const { created } = await createNextMonthPartitions(
      { execute },
      new Date(Date.UTC(2026, 3, 16)),
    );
    expect(created).toEqual(["raw_events_2026_05", "events_2026_05"]);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
