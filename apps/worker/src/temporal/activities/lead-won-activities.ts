import {
  withTenant,
  type Db,
  type EventRepository,
  type LeadRepository,
} from "@vex/db";
import type { GoogleAdsAdapter } from "@vex/integrations";
import { createLogger, withSpan } from "@vex/telemetry";

const log = createLogger("worker.lead-won");

export interface LeadWonActivitiesDeps {
  db: Db;
  leads: LeadRepository;
  events: EventRepository;
  /** Optional — when null, the activity logs and skips (dev / test). */
  ads: GoogleAdsAdapter | null;
  /** Conversion action resource name from workspace config or env. */
  defaultConversionActionName: string | null;
  /** Customer (Ads) account id resolved from workspace settings or env. */
  defaultCustomerId: string | null;
}

export interface LeadLookup {
  leadId: string;
  orgId: string;
  status: string;
  gclid: string | null;
  conversionValueUsd: number;
}

export function buildLeadWonActivities(deps: LeadWonActivitiesDeps) {
  return {
    /**
     * Read the lead row, return its key fields + the gclid extracted from
     * `external_keys` (key `google_ads.gclid` per Sprint 8 convention).
     * Returns `null` when the lead is missing or not in `won` status —
     * the workflow short-circuits in that case.
     */
    async lookupLead(input: { tenantId: string; leadId: string }): Promise<LeadLookup | null> {
      return withSpan(
        "temporal.activity.lead_won.lookupLead",
        { tenant_id: input.tenantId, lead_id: input.leadId },
        async () => {
          return withTenant(deps.db, input.tenantId, async (tx) => {
            const lead = await deps.leads.findById(tx, input.leadId);
            if (!lead) return null;
            if (lead.status !== "won") return null;
            const ek = lead.externalKeys as Record<string, unknown>;
            const gclid =
              typeof ek["google_ads.gclid"] === "string"
                ? (ek["google_ads.gclid"] as string)
                : null;
            const conversionValueUsd =
              typeof ek["conversion_value_usd"] === "number"
                ? (ek["conversion_value_usd"] as number)
                : 0;
            return {
              leadId: lead.id,
              orgId: lead.orgId,
              status: lead.status,
              gclid,
              conversionValueUsd,
            } satisfies LeadLookup;
          });
        },
      );
    },

    /**
     * Send the offline conversion to Google Ads. Returns `{ sent: false }`
     * when the adapter or required config is missing — the workflow keeps
     * going to the audit step so we still record what happened.
     */
    async sendOfflineConversion(input: {
      tenantId: string;
      leadId: string;
      gclid: string;
      conversionValueUsd: number;
      occurredAtIso: string;
    }): Promise<{ sent: boolean; reason?: string }> {
      return withSpan(
        "temporal.activity.lead_won.sendOfflineConversion",
        { tenant_id: input.tenantId, lead_id: input.leadId },
        async () => {
          if (!deps.ads) {
            log.warn("ads adapter not configured; skipping offline conversion", {
              lead_id: input.leadId,
            });
            return { sent: false, reason: "adapter_unconfigured" };
          }
          if (!deps.defaultConversionActionName || !deps.defaultCustomerId) {
            log.warn("conversion action / customer id not configured; skipping", {
              lead_id: input.leadId,
            });
            return { sent: false, reason: "conversion_action_unconfigured" };
          }
          await deps.ads.sendOfflineConversion({
            customerId: deps.defaultCustomerId,
            conversionActionName: deps.defaultConversionActionName,
            gclid: input.gclid,
            conversionDateTime: input.occurredAtIso,
            conversionValue: input.conversionValueUsd,
            currencyCode: "USD",
          });
          return { sent: true };
        },
      );
    },

    async emitAuditEvent(input: {
      tenantId: string;
      leadId: string;
      orgId: string;
      sent: boolean;
      reason?: string;
    }): Promise<void> {
      return withSpan(
        "temporal.activity.lead_won.emitAuditEvent",
        { tenant_id: input.tenantId, lead_id: input.leadId },
        async () => {
          await withTenant(deps.db, input.tenantId, async (tx) => {
            await deps.events.insertIfNotExists(tx, input.tenantId, {
              verb: "lead.conversion_synced",
              subjectType: "lead",
              subjectId: input.leadId,
              actorType: "system",
              actorId: "lead_won_workflow",
              objectType: "organization",
              objectId: input.orgId,
              occurredAt: new Date(),
              idempotencyKey: `lead.conversion_synced:${input.leadId}`,
              metadata: {
                sent: input.sent,
                ...(input.reason ? { reason: input.reason } : {}),
              },
            });
          });
        },
      );
    },
  };
}

export type LeadWonActivities = ReturnType<typeof buildLeadWonActivities>;
