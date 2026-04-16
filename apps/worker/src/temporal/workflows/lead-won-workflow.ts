import { log, proxyActivities } from "@temporalio/workflow";
import type { LeadWonActivities } from "../activities/lead-won-activities.js";

const activities = proxyActivities<LeadWonActivities>({
  startToCloseTimeout: "60s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "5s",
    backoffCoefficient: 2,
  },
});

export interface LeadWonWorkflowInput {
  tenantId: string;
  leadId: string;
}

export interface LeadWonWorkflowResult {
  status: "completed" | "skipped";
  reason?: string;
  conversionSent: boolean;
}

/**
 * Triggered when a lead's status flips to `won`. Three steps, all idempotent:
 *   1. lookupLead — fetch the lead, verify it's still `won`, extract gclid
 *   2. sendOfflineConversion — only when a gclid exists and the Ads adapter
 *      is configured; the workflow continues either way
 *   3. emitAuditEvent — `lead.conversion_synced` so the timeline shows what
 *      happened (including reason="no_gclid" / "adapter_unconfigured")
 */
export async function leadWonWorkflow(
  input: LeadWonWorkflowInput,
): Promise<LeadWonWorkflowResult> {
  log.info("lead won workflow started", {
    tenant_id: input.tenantId,
    lead_id: input.leadId,
  });

  const lead = await activities.lookupLead({
    tenantId: input.tenantId,
    leadId: input.leadId,
  });
  if (!lead) {
    log.warn("lead not found or not won; skipping");
    return { status: "skipped", reason: "lead_not_won", conversionSent: false };
  }

  let conversionSent = false;
  let reason: string | undefined;

  if (!lead.gclid) {
    reason = "no_gclid";
    log.info("lead has no gclid; skipping offline conversion");
  } else {
    const result = await activities.sendOfflineConversion({
      tenantId: input.tenantId,
      leadId: lead.leadId,
      gclid: lead.gclid,
      conversionValueUsd: lead.conversionValueUsd,
      occurredAtIso: new Date().toISOString().replace("Z", "+00:00"),
    });
    conversionSent = result.sent;
    if (!result.sent && result.reason) reason = result.reason;
  }

  await activities.emitAuditEvent({
    tenantId: input.tenantId,
    leadId: lead.leadId,
    orgId: lead.orgId,
    sent: conversionSent,
    ...(reason ? { reason } : {}),
  });

  return {
    status: "completed",
    conversionSent,
    ...(reason ? { reason } : {}),
  };
}
