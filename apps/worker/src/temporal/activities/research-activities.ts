import { TenantId, type EvidenceItem, type EvidencePack } from "@vex/domain";
import { RESEARCH_SYSTEM_PROMPT } from "@vex/agents";
import {
  withTenant,
  type AgentRunRepository,
  type Db,
  type EventRepository,
  type OrganizationRepository,
  type SummaryRepository,
  type TouchpointRepository,
} from "@vex/db";
import type { AnthropicAdapter } from "@vex/integrations";
import type { CostLedger } from "@vex/telemetry";
import { withSpan, createLogger } from "@vex/telemetry";

const log = createLogger("worker.research");

const TOUCHPOINT_LOOKBACK_DAYS = 30;
const SCRAPE_TIMEOUT_MS = 15_000;
const SCRAPE_MAX_BYTES = 256 * 1024;

export interface ResearchActivitiesDeps {
  db: Db;
  organizations: OrganizationRepository;
  touchpoints: TouchpointRepository;
  summaries: SummaryRepository;
  events: EventRepository;
  agentRuns: AgentRunRepository;
  anthropic: AnthropicAdapter;
  costLedger: CostLedger;
  /** Optional fetch override for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

export interface OrgData {
  id: string;
  legalName: string;
  domain: string | null;
  industry: string | null;
  fitScore: number | null;
  touchpoints: Array<{
    id: string;
    channel: string;
    occurredAt: string;
    metadata: Record<string, unknown>;
  }>;
}

export interface ResearchResults {
  fitScore: number | null;
  confidence: number;
  rationale: string;
  briefText: string;
  costUsd: number;
}

/** Activity bundle for the research workflow. Idempotent on retry. */
export function buildResearchActivities(deps: ResearchActivitiesDeps) {
  const fetcher = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return {
    async fetchOrgData(input: { tenantId: string; orgId: string }): Promise<OrgData | null> {
      return withSpan(
        "temporal.activity.fetchOrgData",
        { tenant_id: input.tenantId, org_id: input.orgId },
        async () => {
          return withTenant(deps.db, input.tenantId, async (tx) => {
            const org = await deps.organizations.findById(tx, input.orgId);
            if (!org) return null;
            const since = new Date(Date.now() - TOUCHPOINT_LOOKBACK_DAYS * 86_400_000);
            const tps = await deps.touchpoints.listForOrgSince(tx, org.id, since, 30);
            return {
              id: org.id,
              legalName: org.legalName,
              domain: org.domain,
              industry: org.industry,
              fitScore: org.fitScore,
              touchpoints: tps.map((t) => ({
                id: t.id,
                channel: t.channel,
                occurredAt: t.occurredAt.toISOString(),
                metadata: t.metadata,
              })),
            };
          });
        },
      );
    },

    /**
     * Best-effort website scrape. Returns the extracted text or `null` on
     * any failure — the workflow continues without it. Bounded to
     * SCRAPE_TIMEOUT_MS and SCRAPE_MAX_BYTES so a slow page can't stall
     * the whole research pipeline.
     */
    async scrapeOrgWebsite(input: {
      tenantId: string;
      orgId: string;
      domain: string | null;
    }): Promise<{ text: string; url: string } | null> {
      return withSpan(
        "temporal.activity.scrapeOrgWebsite",
        {
          tenant_id: input.tenantId,
          org_id: input.orgId,
          domain: input.domain ?? "",
        },
        async () => {
          if (!input.domain) return null;
          const url = `https://${input.domain.replace(/^https?:\/\//, "")}`;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);
          try {
            const response = await fetcher(url, {
              signal: controller.signal,
              redirect: "follow",
              headers: { "user-agent": "vex-research/1.0 (+https://vexhq.ai/bot)" },
            });
            if (!response.ok) {
              log.warn("scrape: non-2xx", { url, status: response.status });
              return null;
            }
            const buffer = await response.arrayBuffer();
            const truncated = buffer.byteLength > SCRAPE_MAX_BYTES
              ? buffer.slice(0, SCRAPE_MAX_BYTES)
              : buffer;
            const html = new TextDecoder().decode(truncated);
            return { text: extractText(html), url };
          } catch (err) {
            log.warn("scrape: failed", { url, error: (err as Error).message });
            return null;
          } finally {
            clearTimeout(timer);
          }
        },
      );
    },

    async generateResearchBrief(input: {
      tenantId: string;
      agentRunId: string;
      orgData: OrgData;
      scrapedText?: string;
    }): Promise<ResearchResults> {
      return withSpan(
        "temporal.activity.generateResearchBrief",
        { tenant_id: input.tenantId, org_id: input.orgData.id },
        async () => {
          const pack = buildPack(input.orgData, input.scrapedText);
          const result = await deps.anthropic.query({
            tenantId: TenantId(input.tenantId),
            idempotencyKey: `research:${input.agentRunId}`,
            systemPrompt: RESEARCH_SYSTEM_PROMPT,
            evidencePack: pack,
            userMessage: `Research org ${input.orgData.legalName} (${input.orgData.id}).`,
            maxTokens: 1500,
          });

          const fitAction = result.proposedActions.find(
            (a) => a.kind === "research.fit_score",
          );
          const fitScore = numberField(fitAction?.payload, "fit_score");
          const confidence = numberField(fitAction?.payload, "confidence") ?? 0;
          const rationale = stringField(fitAction?.payload, "rationale");
          return {
            fitScore,
            confidence,
            rationale,
            briefText: result.answer,
            costUsd: result.costUsd,
          };
        },
      );
    },

    async writeResearchSummary(input: {
      tenantId: string;
      orgId: string;
      briefText: string;
    }): Promise<{ summaryId: string }> {
      return withSpan(
        "temporal.activity.writeResearchSummary",
        { tenant_id: input.tenantId, org_id: input.orgId },
        async () => {
          return withTenant(deps.db, input.tenantId, async (tx) => {
            const summary = await deps.summaries.upsert(tx, input.tenantId, {
              subjectType: "organization",
              subjectId: input.orgId,
              summaryType: "research_brief",
              content: input.briefText,
            });
            return { summaryId: summary.id };
          });
        },
      );
    },

    async updateFieldConfidence(input: {
      tenantId: string;
      orgId: string;
      results: ResearchResults;
    }): Promise<{ applied: boolean }> {
      return withSpan(
        "temporal.activity.updateFieldConfidence",
        { tenant_id: input.tenantId, org_id: input.orgId },
        async () => {
          if (input.results.fitScore == null || input.results.confidence < 0.4) {
            return { applied: false };
          }
          await withTenant(deps.db, input.tenantId, async (tx) => {
            await deps.organizations.updateFieldConfidence(
              tx,
              input.orgId,
              "fit_score",
              input.results.fitScore,
              "agent.research",
              input.results.confidence,
            );
          });
          return { applied: true };
        },
      );
    },

    async emitCostSummary(input: {
      tenantId: string;
      agentRunId: string;
      costUsd: number;
      summaryId: string;
      orgId: string;
    }): Promise<void> {
      return withSpan(
        "temporal.activity.emitCostSummary",
        { tenant_id: input.tenantId, agent_run_id: input.agentRunId },
        async () => {
          await withTenant(deps.db, input.tenantId, async (tx) => {
            await deps.agentRuns.complete(tx, input.agentRunId, {
              status: "completed",
              costUsd: input.costUsd,
              outputRefs: { summary_id: input.summaryId, org_id: input.orgId },
            });
            await deps.events.insertIfNotExists(tx, input.tenantId, {
              verb: "agent.completed",
              subjectType: "agent_run",
              subjectId: input.agentRunId,
              actorType: "system",
              actorId: "research_workflow",
              objectType: "agent",
              objectId: "research",
              occurredAt: new Date(),
              idempotencyKey: `agent.completed:${input.agentRunId}`,
              metadata: { cost_usd: input.costUsd },
            });
          });
        },
      );
    },
  };
}

function buildPack(org: OrgData, scrapedText?: string): EvidencePack {
  const now = Date.now();
  const summaries: EvidenceItem[] = [
    {
      chunk_id: org.id,
      object_type: "organization",
      object_id: org.id,
      chunk_text: `${org.legalName} (industry=${org.industry ?? "unknown"}, fit_score=${org.fitScore ?? "unset"})`,
      source_ref: `organization ${org.id}`,
      source_type: "summary",
      occurred_at: new Date(),
      freshness_hours: 0,
      confidence_score: 1,
      corroborated_by_count: 0,
      permission_scope: "workspace",
      raw_event_ref: null,
      summary_version: 0,
    },
  ];
  if (scrapedText) {
    summaries.push({
      chunk_id: `${org.id}:scrape`,
      object_type: "document",
      object_id: org.id,
      chunk_text: scrapedText.slice(0, 6000),
      source_ref: `org website ${org.domain ?? ""}`,
      source_type: "document",
      occurred_at: new Date(),
      freshness_hours: 0,
      confidence_score: 0.7,
      corroborated_by_count: 0,
      permission_scope: "workspace",
      raw_event_ref: null,
      summary_version: 0,
    });
  }
  const items: EvidenceItem[] = org.touchpoints.map((t) => {
    const occurred = new Date(t.occurredAt);
    return {
      chunk_id: t.id,
      object_type: "touchpoint",
      object_id: t.id,
      chunk_text: `${t.channel} at ${t.occurredAt} ${JSON.stringify(t.metadata)}`,
      source_ref: `touchpoint ${t.id}`,
      source_type: "event",
      occurred_at: occurred,
      freshness_hours: Math.max(0, (now - occurred.getTime()) / 3600_000),
      confidence_score: 0.7,
      corroborated_by_count: 0,
      permission_scope: "workspace",
      raw_event_ref: null,
      summary_version: null,
    };
  });
  return {
    summaries,
    items,
    estimated_tokens: summaries.length * 100 + items.length * 30,
  };
}

/** Strip HTML tags + collapse whitespace. Good enough for the model — we
 *  intentionally don't pull in a full HTML parser here. */
function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function numberField(payload: Record<string, unknown> | undefined, key: string): number | null {
  if (!payload) return null;
  const v = payload[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function stringField(payload: Record<string, unknown> | undefined, key: string): string {
  if (!payload) return "";
  const v = payload[key];
  return typeof v === "string" ? v : "";
}

export type ResearchActivities = ReturnType<typeof buildResearchActivities>;
