import { log, proxyActivities } from "@temporalio/workflow";
import type { ResearchActivities } from "../activities/research-activities.js";

/**
 * Per-step retry/timeout policies. The scrape activity gets its own proxy
 * because we want it to fail-fast (3 attempts, 60s wall) and the workflow
 * to continue without it; everything else uses the default policy.
 */
const defaults = proxyActivities<ResearchActivities>({
  startToCloseTimeout: "90s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "1s",
    backoffCoefficient: 2,
  },
});

const scrape = proxyActivities<Pick<ResearchActivities, "scrapeOrgWebsite">>({
  startToCloseTimeout: "60s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "5s",
    backoffCoefficient: 2,
  },
});

export interface ResearchWorkflowInput {
  tenantId: string;
  agentRunId: string;
  organizationId: string;
}

export interface ResearchWorkflowResult {
  status: "completed" | "skipped";
  summaryId?: string;
  fitScoreApplied: boolean;
  scrapedFromWeb: boolean;
  costUsd: number;
}

/**
 * Per-org research pipeline:
 *   1. fetchOrgData
 *   2. scrapeOrgWebsite — best-effort. On exhausted retries the workflow
 *      keeps going with `null` for the scraped text (no website data).
 *   3. generateResearchBrief — Claude call
 *   4. writeResearchSummary
 *   5. updateFieldConfidence — only if confidence ≥ 0.4
 *   6. emitCostSummary — closes the agent_run row + writes audit event
 */
export async function researchWorkflow(
  input: ResearchWorkflowInput,
): Promise<ResearchWorkflowResult> {
  log.info("research workflow started", {
    tenant_id: input.tenantId,
    org_id: input.organizationId,
  });

  const orgData = await defaults.fetchOrgData({
    tenantId: input.tenantId,
    orgId: input.organizationId,
  });
  if (!orgData) {
    log.warn("research: org not found");
    return {
      status: "skipped",
      fitScoreApplied: false,
      scrapedFromWeb: false,
      costUsd: 0,
    };
  }

  let scrapedText: string | undefined;
  try {
    const scraped = await scrape.scrapeOrgWebsite({
      tenantId: input.tenantId,
      orgId: input.organizationId,
      domain: orgData.domain,
    });
    if (scraped) scrapedText = scraped.text;
  } catch (err) {
    log.warn("research: scrape exhausted retries, continuing without web data", {
      error: (err as Error).message,
    });
  }

  const brief = await defaults.generateResearchBrief({
    tenantId: input.tenantId,
    agentRunId: input.agentRunId,
    orgData,
    ...(scrapedText !== undefined ? { scrapedText } : {}),
  });

  const summary = await defaults.writeResearchSummary({
    tenantId: input.tenantId,
    orgId: input.organizationId,
    briefText: brief.briefText,
  });

  const applied = await defaults.updateFieldConfidence({
    tenantId: input.tenantId,
    orgId: input.organizationId,
    results: brief,
  });

  await defaults.emitCostSummary({
    tenantId: input.tenantId,
    agentRunId: input.agentRunId,
    costUsd: brief.costUsd,
    summaryId: summary.summaryId,
    orgId: input.organizationId,
  });

  return {
    status: "completed",
    summaryId: summary.summaryId,
    fitScoreApplied: applied.applied,
    scrapedFromWeb: scrapedText !== undefined,
    costUsd: brief.costUsd,
  };
}
