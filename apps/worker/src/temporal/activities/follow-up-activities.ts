import { TenantId, type EvidenceItem, type EvidencePack } from "@vex/domain";
import { FOLLOW_UP_SYSTEM_PROMPT } from "@vex/agents";
import {
  withTenant,
  type ApprovalRepository,
  type Db,
  type EventRepository,
  type LeadRepository,
  type ThreadRepository,
} from "@vex/db";
import type { AnthropicAdapter, ProposedAction } from "@vex/integrations";
import { withSpan, createLogger } from "@vex/telemetry";

const log = createLogger("worker.follow-up");

const STALE_THREAD_HOURS = 48;
const STALE_LEAD_DAYS = 7;

export interface FollowUpActivitiesDeps {
  db: Db;
  threads: ThreadRepository;
  leads: LeadRepository;
  approvals: ApprovalRepository;
  events: EventRepository;
  anthropic: AnthropicAdapter;
}

export interface StaleItem {
  kind: "thread" | "lead";
  id: string;
  occurredAt: string;
  metadata: Record<string, unknown>;
}

export interface DraftSuggestion {
  subject_id: string;
  subject_type: "thread" | "lead";
  subject_line: string;
  opening_line: string;
  rationale: string;
}

/**
 * Build the activities object Temporal exposes to workflows. Returning a
 * plain object (not a class) keeps the activity surface easy for the
 * Worker.create({ activities }) call to consume.
 *
 * Every activity is idempotent — they may be invoked more than once when
 * a worker dies between attempt + completion record.
 */
export function buildFollowUpActivities(deps: FollowUpActivitiesDeps) {
  return {
    async queryStaleItems(input: { tenantId: string }): Promise<StaleItem[]> {
      return withSpan(
        "temporal.activity.queryStaleItems",
        { tenant_id: input.tenantId },
        async () => {
          const threadCutoff = new Date(Date.now() - STALE_THREAD_HOURS * 3600_000);
          const leadCutoff = new Date(Date.now() - STALE_LEAD_DAYS * 86400_000);
          return withTenant(deps.db, input.tenantId, async (tx) => {
            const [threads, leads] = await Promise.all([
              deps.threads.listStale(tx, threadCutoff, 25),
              deps.leads.listStale(tx, leadCutoff, 25),
            ]);
            const out: StaleItem[] = [];
            for (const t of threads) {
              out.push({
                kind: "thread",
                id: t.id,
                occurredAt: (t.lastMessageAt ?? new Date(0)).toISOString(),
                metadata: { channel: t.channel, subject: t.subject },
              });
            }
            for (const l of leads) {
              out.push({
                kind: "lead",
                id: l.id,
                occurredAt: l.updatedAt.toISOString(),
                metadata: { status: l.status },
              });
            }
            return out;
          });
        },
      );
    },

    async generateFollowUpDrafts(input: {
      tenantId: string;
      agentRunId: string;
      staleItems: StaleItem[];
    }): Promise<DraftSuggestion[]> {
      return withSpan(
        "temporal.activity.generateFollowUpDrafts",
        { tenant_id: input.tenantId, items: input.staleItems.length },
        async () => {
          if (input.staleItems.length === 0) return [];
          const pack = packFromStaleItems(input.staleItems);
          const result = await deps.anthropic.query({
            tenantId: TenantId(input.tenantId),
            idempotencyKey: `follow_up:${input.agentRunId}`,
            systemPrompt: FOLLOW_UP_SYSTEM_PROMPT,
            evidencePack: pack,
            userMessage:
              "Draft up to one follow-up suggestion per stale item. Output proposed_actions only.",
            maxTokens: 2000,
          });
          return mapToSuggestions(result.proposedActions);
        },
      );
    },

    async createApprovalRows(input: {
      tenantId: string;
      agentRunId: string;
      drafts: DraftSuggestion[];
    }): Promise<{ approvalId: string; subjectId: string }[]> {
      return withSpan(
        "temporal.activity.createApprovalRows",
        { tenant_id: input.tenantId, drafts: input.drafts.length },
        async () => {
          if (input.drafts.length === 0) return [];
          return withTenant(deps.db, input.tenantId, async (tx) => {
            const created: { approvalId: string; subjectId: string }[] = [];
            for (const d of input.drafts) {
              const approval = await deps.approvals.create(tx, input.tenantId, {
                agentRunId: input.agentRunId,
                actionType: "follow_up.suggestion",
                proposedPayload: {
                  subject_type: d.subject_type,
                  subject_id: d.subject_id,
                  subject_line: d.subject_line,
                  opening_line: d.opening_line,
                  rationale: d.rationale,
                  channel: "email",
                  tier: "T1",
                },
              });
              await deps.events.insertIfNotExists(tx, input.tenantId, {
                verb: "approval.created",
                subjectType: "approval",
                subjectId: approval.id,
                actorType: "system",
                actorId: "follow_up_workflow",
                objectType: "approval",
                objectId: approval.id,
                occurredAt: new Date(),
                idempotencyKey: `approval.created:${approval.id}`,
                metadata: { agent_run_id: input.agentRunId, subject_id: d.subject_id },
              });
              created.push({ approvalId: approval.id, subjectId: d.subject_id });
            }
            return created;
          });
        },
      );
    },

    async markDraftReady(input: {
      tenantId: string;
      approvalId: string;
    }): Promise<void> {
      return withSpan(
        "temporal.activity.markDraftReady",
        { tenant_id: input.tenantId, approval_id: input.approvalId },
        async () => {
          await withTenant(deps.db, input.tenantId, async (tx) => {
            await deps.events.insertIfNotExists(tx, input.tenantId, {
              verb: "follow_up.draft_ready",
              subjectType: "approval",
              subjectId: input.approvalId,
              actorType: "system",
              actorId: "follow_up_workflow",
              objectType: "approval",
              objectId: input.approvalId,
              occurredAt: new Date(),
              idempotencyKey: `follow_up.draft_ready:${input.approvalId}`,
              metadata: {},
            });
          });
          log.info("follow_up draft marked ready", { approval_id: input.approvalId });
        },
      );
    },

    async logRejection(input: {
      tenantId: string;
      approvalId: string;
      reason: string;
    }): Promise<void> {
      return withSpan(
        "temporal.activity.logRejection",
        { tenant_id: input.tenantId, approval_id: input.approvalId },
        async () => {
          await withTenant(deps.db, input.tenantId, async (tx) => {
            await deps.events.insertIfNotExists(tx, input.tenantId, {
              verb: "follow_up.rejected",
              subjectType: "approval",
              subjectId: input.approvalId,
              actorType: "system",
              actorId: "follow_up_workflow",
              objectType: "approval",
              objectId: input.approvalId,
              occurredAt: new Date(),
              idempotencyKey: `follow_up.rejected:${input.approvalId}`,
              metadata: { reason: input.reason },
            });
          });
          log.info("follow_up rejected", { approval_id: input.approvalId });
        },
      );
    },

    async expireApproval(input: {
      tenantId: string;
      approvalId: string;
    }): Promise<void> {
      return withSpan(
        "temporal.activity.expireApproval",
        { tenant_id: input.tenantId, approval_id: input.approvalId },
        async () => {
          await withTenant(deps.db, input.tenantId, async (tx) => {
            await deps.events.insertIfNotExists(tx, input.tenantId, {
              verb: "approval.expired",
              subjectType: "approval",
              subjectId: input.approvalId,
              actorType: "system",
              actorId: "follow_up_workflow",
              objectType: "approval",
              objectId: input.approvalId,
              occurredAt: new Date(),
              idempotencyKey: `approval.expired:${input.approvalId}`,
              metadata: { reason: "72h_timeout" },
            });
          });
          log.warn("follow_up approval expired", { approval_id: input.approvalId });
        },
      );
    },
  };
}

function mapToSuggestions(actions: ProposedAction[]): DraftSuggestion[] {
  return actions
    .filter((a) => a.kind === "follow_up.suggestion" && a.tier === "T1")
    .map((a) => ({
      subject_type: stringField(a.payload, "subject_type") as "thread" | "lead",
      subject_id: stringField(a.payload, "subject_id"),
      subject_line: stringField(a.payload, "subject_line"),
      opening_line: stringField(a.payload, "opening_line"),
      rationale: typeof a.rationale === "string" ? a.rationale : "",
    }))
    .filter((s) => s.subject_id && (s.subject_type === "thread" || s.subject_type === "lead"));
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  return typeof v === "string" ? v : "";
}

function packFromStaleItems(items: StaleItem[]): EvidencePack {
  const now = Date.now();
  const evidenceItems: EvidenceItem[] = items.map((item) => {
    const occurredAt = new Date(item.occurredAt);
    return {
      chunk_id: item.id,
      object_type: item.kind,
      object_id: item.id,
      chunk_text: `${item.kind} ${item.id} ${JSON.stringify(item.metadata)}`,
      source_ref: `${item.kind} ${item.id}`,
      source_type: "summary",
      occurred_at: occurredAt,
      freshness_hours: Math.max(0, (now - occurredAt.getTime()) / 3600_000),
      confidence_score: 0.8,
      corroborated_by_count: 0,
      permission_scope: "workspace",
      raw_event_ref: null,
      summary_version: 0,
    };
  });
  return {
    summaries: [],
    items: evidenceItems,
    estimated_tokens: evidenceItems.length * 30,
  };
}

export type FollowUpActivities = ReturnType<typeof buildFollowUpActivities>;
