import { describe, expect, it, vi } from "vitest";
import type { sql } from "drizzle-orm";
import type { Db, Tx } from "./client.js";
import { withTenant } from "./with-tenant.js";

/**
 * Build a fake Db whose `transaction` invokes the callback synchronously and
 * records every `tx.execute` call. Counters live on a shared `state` object
 * so callers see updates after the closure runs.
 */
function makeFakeDb() {
  const state = {
    executes: [] as unknown[],
    commits: 0,
    rollbacks: 0,
  };
  const tx = {
    execute: vi.fn(async (q: unknown) => {
      state.executes.push(q);
      return undefined;
    }),
  } as unknown as Tx;
  const db = {
    transaction: async <T>(cb: (t: Tx) => Promise<T>) => {
      try {
        const result = await cb(tx);
        state.commits++;
        return result;
      } catch (err) {
        state.rollbacks++;
        throw err;
      }
    },
  } as unknown as Db;
  return { db, state, tx };
}

describe("withTenant", () => {
  it("opens a transaction and sets app.tenant_id locally before the callback", async () => {
    const { db, state } = makeFakeDb();
    let tenantSeenInsideCallback: string | undefined;

    await withTenant(db, "01HSEEDWRK0000000000000001", async () => {
      tenantSeenInsideCallback = "captured";
    });

    expect(state.executes).toHaveLength(1);
    const stmt = state.executes[0] as ReturnType<typeof sql>;
    const stringified = JSON.stringify(stmt);
    expect(stringified).toContain("set_config");
    expect(stringified).toContain("app.tenant_id");
    expect(tenantSeenInsideCallback).toBe("captured");
  });

  it("returns the callback's return value", async () => {
    const { db } = makeFakeDb();
    const result = await withTenant(db, "tenant-1", async () => 42);
    expect(result).toBe(42);
  });

  it("rolls back the transaction when the callback throws", async () => {
    const { db, state } = makeFakeDb();
    await expect(
      withTenant(db, "tenant-1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(state.rollbacks).toBe(1);
    expect(state.commits).toBe(0);
  });

  it("never exposes the parent Db to the callback", async () => {
    const { db, tx } = makeFakeDb();
    await withTenant(db, "tenant-1", async (received) => {
      expect(received).toBe(tx);
      expect(received).not.toBe(db);
    });
  });
});
