import { describe, expect, it, vi } from "vitest";
import { PostgresCostLedgerRepository } from "./cost-ledger-repository.js";
import type { Tx } from "../client.js";

function makeTxReturning(total: number | null | string) {
  const where = vi.fn().mockResolvedValue([{ total }]);
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select } as unknown as Tx;
}

describe("PostgresCostLedgerRepository.sumBetween", () => {
  const repo = new PostgresCostLedgerRepository();
  const tenant = "01HSEEDWRK0000000000000001";
  const a = new Date("2026-04-17T00:00:00Z");
  const b = new Date("2026-04-18T00:00:00Z");

  it("returns 0 when the DB reports NULL", async () => {
    const tx = makeTxReturning(null);
    const n = await repo.sumBetween(tx, tenant, a, b);
    expect(n).toBe(0);
  });

  it("coerces a numeric string total to an integer", async () => {
    const tx = makeTxReturning("123456");
    const n = await repo.sumBetween(tx, tenant, a, b);
    expect(n).toBe(123_456);
  });

  it("returns 0 on NaN / non-numeric total", async () => {
    const tx = makeTxReturning("oops");
    const n = await repo.sumBetween(tx, tenant, a, b);
    expect(n).toBe(0);
  });
});

describe("PostgresCostLedgerRepository.sumForTenantToday", () => {
  it("delegates to sumBetween with a UTC-day window", async () => {
    const repo = new PostgresCostLedgerRepository();
    const spy = vi.spyOn(repo, "sumBetween").mockResolvedValue(42);
    const now = new Date("2026-04-17T10:30:00Z");
    const n = await repo.sumForTenantToday({} as Tx, "t", now);
    expect(n).toBe(42);
    expect(spy).toHaveBeenCalledTimes(1);
    const [, , start, end] = spy.mock.calls[0]!;
    expect(start.toISOString()).toBe("2026-04-17T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-04-18T00:00:00.000Z");
  });
});
