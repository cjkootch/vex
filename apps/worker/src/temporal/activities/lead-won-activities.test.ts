import { describe, expect, it, vi } from "vitest";
import { buildLeadWonActivities } from "./lead-won-activities.js";

function buildDeps(overrides: { lead?: unknown; ads?: unknown } = {}) {
  const tx = { execute: vi.fn(async () => undefined) } as never;
  const eventsInserted: { verb: string; idempotencyKey: string; metadata: unknown }[] = [];
  return {
    tx,
    eventsInserted,
    deps: {
      db: {
        transaction: async <T,>(cb: (t: unknown) => Promise<T>) => cb(tx),
      } as never,
      leads: {
        findById: vi.fn(async () => overrides.lead ?? null),
      } as never,
      events: {
        insertIfNotExists: vi.fn(
          async (
            _tx: unknown,
            _t: unknown,
            data: { verb: string; idempotencyKey: string; metadata: unknown },
          ) => {
            eventsInserted.push({
              verb: data.verb,
              idempotencyKey: data.idempotencyKey,
              metadata: data.metadata,
            });
            return { event: { id: "e" }, isNew: true };
          },
        ),
      } as never,
      ads: (overrides.ads ?? null) as never,
      defaultConversionActionName: "customers/123/conversionActions/456",
      defaultCustomerId: "1234567890",
    },
  };
}

describe("LeadWonActivities", () => {
  it("lookupLead returns null when lead is not won", async () => {
    const { deps } = buildDeps({
      lead: { id: "l-1", orgId: "o-1", status: "qualified", externalKeys: {} },
    });
    const acts = buildLeadWonActivities(deps);
    const result = await acts.lookupLead({ tenantId: "t", leadId: "l-1" });
    expect(result).toBeNull();
  });

  it("lookupLead extracts gclid + conversion value from external_keys", async () => {
    const { deps } = buildDeps({
      lead: {
        id: "l-1",
        orgId: "o-1",
        status: "won",
        externalKeys: {
          "google_ads.gclid": "abc",
          conversion_value_usd: 5000,
        },
      },
    });
    const acts = buildLeadWonActivities(deps);
    const result = await acts.lookupLead({ tenantId: "t", leadId: "l-1" });
    expect(result).toEqual({
      leadId: "l-1",
      orgId: "o-1",
      status: "won",
      gclid: "abc",
      conversionValueUsd: 5000,
    });
  });

  it("sendOfflineConversion calls the Ads adapter with correct payload", async () => {
    const sendSpy = vi.fn(async () => ({ results: [] }));
    const { deps } = buildDeps({ ads: { sendOfflineConversion: sendSpy } });
    const acts = buildLeadWonActivities(deps);
    const result = await acts.sendOfflineConversion({
      tenantId: "t",
      leadId: "l-1",
      gclid: "abc",
      conversionValueUsd: 5000,
      occurredAtIso: "2026-08-09T12:00:00+00:00",
    });
    expect(result.sent).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith({
      customerId: "1234567890",
      conversionActionName: "customers/123/conversionActions/456",
      gclid: "abc",
      conversionDateTime: "2026-08-09T12:00:00+00:00",
      conversionValue: 5000,
      currencyCode: "USD",
    });
  });

  it("sendOfflineConversion skips when adapter is missing", async () => {
    const { deps } = buildDeps({ ads: null });
    const acts = buildLeadWonActivities(deps);
    const result = await acts.sendOfflineConversion({
      tenantId: "t",
      leadId: "l-1",
      gclid: "abc",
      conversionValueUsd: 0,
      occurredAtIso: "2026-08-09T00:00:00+00:00",
    });
    expect(result).toEqual({ sent: false, reason: "adapter_unconfigured" });
  });

  it("emitAuditEvent writes lead.conversion_synced with the right metadata", async () => {
    const { deps, eventsInserted } = buildDeps();
    const acts = buildLeadWonActivities(deps);
    await acts.emitAuditEvent({
      tenantId: "t",
      leadId: "l-1",
      orgId: "o-1",
      sent: true,
    });
    expect(eventsInserted[0]?.verb).toBe("lead.conversion_synced");
    expect(eventsInserted[0]?.idempotencyKey).toBe("lead.conversion_synced:l-1");
    expect((eventsInserted[0]?.metadata as { sent: boolean }).sent).toBe(true);
  });
});
