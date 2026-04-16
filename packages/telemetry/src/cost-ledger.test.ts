import { describe, expect, it } from "vitest";
import { TenantId } from "@vex/domain";
import { InMemoryCostLedger } from "./cost-ledger.js";

const tenant = TenantId("3f5b3c4e-2a8d-4f11-8a8b-1a2b3c4d5e6f");

describe("InMemoryCostLedger", () => {
  it("records entries idempotently by key", async () => {
    const ledger = new InMemoryCostLedger();
    const entry = {
      idempotencyKey: "req-1",
      tenantId: tenant,
      operation: "llm.completion" as const,
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      units: 1200,
      unitKind: "input_tokens",
      costUsdMicros: 3600,
      occurredAt: new Date(),
    };

    await ledger.record(entry);
    await ledger.record(entry); // duplicate

    expect(ledger.snapshot()).toHaveLength(1);
    expect(ledger.totalMicros()).toBe(3600);
  });

  it("sums distinct entries", async () => {
    const ledger = new InMemoryCostLedger();
    await ledger.record({
      idempotencyKey: "a",
      tenantId: tenant,
      operation: "llm.completion",
      provider: "anthropic",
      units: 100,
      unitKind: "input_tokens",
      costUsdMicros: 300,
      occurredAt: new Date(),
    });
    await ledger.record({
      idempotencyKey: "b",
      tenantId: tenant,
      operation: "llm.embedding",
      provider: "openai",
      units: 500,
      unitKind: "input_tokens",
      costUsdMicros: 50,
      occurredAt: new Date(),
    });

    expect(ledger.totalMicros()).toBe(350);
  });
});
