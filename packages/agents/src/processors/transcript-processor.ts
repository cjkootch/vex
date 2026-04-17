import type { Job } from "bullmq";
import {
  withTenant,
  type ActivityRepository,
  type ApprovalRepository,
  type Db,
  type EventRepository,
  type SummaryRepository,
  type TouchpointRepository,
} from "@vex/db";
import {
  TenantId,
  type EvidenceItem,
  type EvidencePack,
} from "@vex/domain";
import {
  transcriptObjectKey,
  type AnthropicAdapter,
  type OpenAIAdapter,
  type S3Uploader,
} from "@vex/integrations";
import { validateManifest, type ViewManifest } from "@vex/ui";
import {
  TRANSCRIPT_ACTION_ITEMS_SYSTEM_PROMPT,
  TRANSCRIPT_SUMMARY_SYSTEM_PROMPT,
} from "../prompts/voice.js";
import type { TranscriptJobData } from "../queues.js";

export interface TranscriptProcessorDeps {
  db: Db;
  s3: S3Uploader;
  anthropic: AnthropicAdapter;
  openai: OpenAIAdapter;
  activities: ActivityRepository;
  touchpoints: TouchpointRepository;
  summaries: SummaryRepository;
  approvals: ApprovalRepository;
  events: EventRepository;
}

export interface TranscriptProcessorOutcome {
  sessionId: string;
  activityId: string;
  summaryId: string;
  actionItemApprovalIds: string[];
  costUsd: number;
  transcriptRef: string;
  /** True if the job saw an existing activity and skipped (idempotent replay). */
  alreadyProcessed: boolean;
}

/**
 * BullMQ processor for voice transcripts.
 *
 * Flow (all inside `withTenant` so RLS scopes reads/writes):
 *   a. Idempotency check — if an `activity` with this session_id already
 *      exists we return success immediately. The BullMQ jobId is the same
 *      session_id so duplicate enqueue is already dedup'd, but the DB
 *      check is belt-and-braces for replays.
 *   b. Upload transcript text to S3 (tenant-prefixed key).
 *   c. Insert `activity(type='voice_call', transcript_ref, duration)`.
 *   d. Insert `touchpoint(channel='voice')`.
 *   e. Claude summary → write `summary(subject_type='activity')`.
 *   f. Claude action-item extraction → for each item, create a pending
 *      `approval` with tier=T2 and `action_type='voice_followup'`.
 *   g. Emit `voice.session.processed` audit event.
 *   h. Record any realtime audio usage to the CostLedger.
 */
export function buildTranscriptProcessor(deps: TranscriptProcessorDeps) {
  return async function process(
    job: Job<TranscriptJobData>,
  ): Promise<TranscriptProcessorOutcome> {
    const data = job.data;
    if (!data.tenant_id || !data.workspace_id || !data.session_id) {
      throw new Error("transcript job missing tenant_id/workspace_id/session_id");
    }
    if (typeof data.transcript_text !== "string") {
      throw new Error("transcript job missing transcript_text");
    }

    const tenantId = data.tenant_id;
    const idempotencyKey = `voice.transcript:${data.session_id}`;

    const realtimeCostUsd = await deps.openai.recordRealtimeUsage({
      tenantId: TenantId(tenantId),
      idempotencyKey: `voice.usage:${data.session_id}`,
      inputAudioTokens: data.input_audio_tokens ?? 0,
      outputAudioTokens: data.output_audio_tokens ?? 0,
      inputTextTokens: data.input_text_tokens ?? 0,
      outputTextTokens: data.output_text_tokens ?? 0,
    });

    return withTenant(deps.db, tenantId, async (tx) => {
      const existing = await deps.activities.findByTypeAndSessionId(
        tx,
        "voice_call",
        data.session_id,
      );
      if (existing) {
        return {
          sessionId: data.session_id,
          activityId: existing.id,
          summaryId: "",
          actionItemApprovalIds: [],
          costUsd: 0,
          transcriptRef: existing.transcriptRef ?? "",
          alreadyProcessed: true,
        };
      }

      const key = transcriptObjectKey(tenantId, data.session_id);
      await deps.s3.putText(key, data.transcript_text, "text/plain");

      const occurredAt = new Date();
      const related: Record<string, string> = {};
      if (data.org_id) related["org_id"] = data.org_id;
      if (data.contact_id) related["contact_id"] = data.contact_id;

      const activity = await deps.activities.insert(tx, tenantId, {
        type: "voice_call",
        relatedObjectIds: related,
        occurredAt,
        transcriptRef: key,
        durationSeconds: data.duration_seconds,
        metadata: {
          session_id: data.session_id,
          provider: "openai.realtime",
          workspace_id: data.workspace_id,
        },
      });

      await deps.touchpoints.insert(tx, tenantId, {
        channel: "voice",
        actor: "user",
        occurredAt,
        orgId: data.org_id ?? null,
        contactId: data.contact_id ?? null,
        metadata: {
          session_id: data.session_id,
          activity_id: activity.id,
          duration_seconds: data.duration_seconds,
        },
      });

      const { summaryManifest, summaryAnswer, summaryCostUsd } = await runSummary({
        deps,
        tenantId,
        sessionId: data.session_id,
        transcriptText: data.transcript_text,
        durationSeconds: data.duration_seconds,
      });
      const summary = await deps.summaries.upsert(tx, tenantId, {
        subjectType: "activity",
        subjectId: activity.id,
        summaryType: "call_summary",
        content: JSON.stringify({
          answer: summaryAnswer,
          manifest: summaryManifest,
          session_id: data.session_id,
        }),
      });

      const { actionItems, actionCostUsd } = await runActionItems({
        deps,
        tenantId,
        sessionId: data.session_id,
        transcriptText: data.transcript_text,
      });
      const approvalIds: string[] = [];
      for (let i = 0; i < actionItems.length; i += 1) {
        const item = actionItems[i]!;
        const approval = await deps.approvals.create(tx, tenantId, {
          actionType: "voice_followup",
          proposedPayload: {
            title: item.title,
            owner: item.owner,
            due_hint: item.due_hint ?? null,
            rationale: item.rationale,
            tier: "T2",
            activity_id: activity.id,
            session_id: data.session_id,
            org_id: data.org_id ?? null,
            contact_id: data.contact_id ?? null,
          },
        });
        approvalIds.push(approval.id);

        await deps.events.insertIfNotExists(tx, tenantId, {
          verb: "voice.action_item.created",
          subjectType: "approval",
          subjectId: approval.id,
          actorType: "system",
          actorId: "transcript_processor",
          objectType: "approval",
          objectId: approval.id,
          occurredAt,
          idempotencyKey: `voice.action_item:${data.session_id}:${i}`,
          metadata: { session_id: data.session_id, activity_id: activity.id },
        });
      }

      await deps.events.insertIfNotExists(tx, tenantId, {
        verb: "voice.session.processed",
        subjectType: "activity",
        subjectId: activity.id,
        actorType: "system",
        actorId: "transcript_processor",
        objectType: "activity",
        objectId: activity.id,
        occurredAt,
        idempotencyKey,
        metadata: {
          session_id: data.session_id,
          duration_seconds: data.duration_seconds,
          action_items: approvalIds.length,
          transcript_ref: key,
        },
      });

      return {
        sessionId: data.session_id,
        activityId: activity.id,
        summaryId: summary.id,
        actionItemApprovalIds: approvalIds,
        costUsd: realtimeCostUsd + summaryCostUsd + actionCostUsd,
        transcriptRef: key,
        alreadyProcessed: false,
      };
    });
  };
}

async function runSummary(args: {
  deps: TranscriptProcessorDeps;
  tenantId: string;
  sessionId: string;
  transcriptText: string;
  durationSeconds: number;
}): Promise<{
  summaryManifest: ViewManifest;
  summaryAnswer: string;
  summaryCostUsd: number;
}> {
  const pack = buildTranscriptPack(args.transcriptText, args.durationSeconds);
  const result = await args.deps.anthropic.query({
    tenantId: TenantId(args.tenantId),
    idempotencyKey: `voice.summary:${args.sessionId}`,
    systemPrompt: TRANSCRIPT_SUMMARY_SYSTEM_PROMPT,
    evidencePack: pack,
    userMessage: "Summarise the voice call transcript above.",
    maxTokens: 1200,
  });
  const validation = validateManifest(result.viewManifest);
  const manifest = validation.success ? validation.manifest : validation.fallback;
  return {
    summaryManifest: manifest,
    summaryAnswer: result.answer,
    summaryCostUsd: result.costUsd,
  };
}

async function runActionItems(args: {
  deps: TranscriptProcessorDeps;
  tenantId: string;
  sessionId: string;
  transcriptText: string;
}): Promise<{
  actionItems: ActionItem[];
  actionCostUsd: number;
}> {
  const message = await args.deps.anthropic.complete({
    tenantId: TenantId(args.tenantId),
    idempotencyKey: `voice.actions:${args.sessionId}`,
    system: TRANSCRIPT_ACTION_ITEMS_SYSTEM_PROMPT,
    maxTokens: 1200,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Extract explicit commitments from this call transcript. Return the JSON shape defined in the system prompt.\n\n" +
              `# Transcript\n${args.transcriptText}`,
          },
        ],
      },
    ],
  });

  const text = message.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n");
  const items = extractActionItems(text);
  // Cost is already recorded by AnthropicAdapter.complete — we don't need to
  // double-book. Return 0 so the outer sum stays a simple additive.
  return { actionItems: items, actionCostUsd: 0 };
}

function extractActionItems(text: string): ActionItem[] {
  const fenceMatch = /```(?:json)?\s*(\{[\s\S]+?\})\s*```/m.exec(text);
  const jsonText = fenceMatch?.[1] ?? text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const rawItems = (parsed as Record<string, unknown>)["action_items"];
  if (!Array.isArray(rawItems)) return [];
  return rawItems.filter(isActionItem);
}

interface ActionItem {
  title: string;
  owner: "user" | "counterparty" | "unknown";
  due_hint?: string | null;
  rationale: string;
}

function isActionItem(x: unknown): x is ActionItem {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (typeof o["title"] !== "string") return false;
  if (typeof o["rationale"] !== "string") return false;
  const owner = o["owner"];
  if (owner !== "user" && owner !== "counterparty" && owner !== "unknown") {
    return false;
  }
  return true;
}

function buildTranscriptPack(text: string, durationSeconds: number): EvidencePack {
  const now = new Date();
  const item: EvidenceItem = {
    chunk_id: "voice_transcript",
    object_type: "activity",
    object_id: "voice_transcript",
    chunk_text: text,
    source_ref: `voice session (${durationSeconds}s)`,
    source_type: "event",
    occurred_at: now,
    freshness_hours: 0,
    confidence_score: 0.9,
    corroborated_by_count: 0,
    permission_scope: "workspace",
    raw_event_ref: null,
    summary_version: null,
  };
  return {
    summaries: [],
    items: [item],
    estimated_tokens: Math.ceil(text.length / 4),
  };
}
