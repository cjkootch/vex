import type { Client as TemporalClient } from "@temporalio/client";
import { TenantId } from "@vex/domain";
import {
  withTenant,
  type CampaignEnrollmentRepository,
  type Db,
  type EventRepository,
  type TouchpointRepository,
} from "@vex/db";
import { INTENT_CLASSIFIER_SYSTEM_PROMPT } from "@vex/agents";
import type { AnthropicAdapter } from "@vex/integrations";
import { WorkflowId } from "@vex/integrations";
import { createLogger, withSpan } from "@vex/telemetry";

const log = createLogger("worker.intent-classifier");

export interface IntentClassifierJobDeps {
  db: Db;
  touchpoints: TouchpointRepository;
  enrollments: CampaignEnrollmentRepository;
  events: EventRepository;
  anthropic: AnthropicAdapter;
  /** Optional — when null, classification still runs but no workflow
   *  signals are dispatched. Enrollments pick up the labels on their
   *  next gate evaluation via the touchpoint metadata. */
  temporal: TemporalClient | null;
  /** Clock override for tests. */
  now?: () => Date;
}

export interface IntentClassifierRunInput {
  tenantId: string;
  /** Lookback window — default 24h. */
  lookbackHours?: number;
  /** Max touchpoints to classify per run. Default 25. */
  maxBatch?: number;
}

export interface IntentClassifierRunResult {
  scanned: number;
  classified: number;
  unsubscribes: number;
  signalsSent: number;
  skipped: string[];
}

/**
 * Canonical intent labels — must match the gate DSL's `intent` /
 * `intent_in` operands. Treating the label set as a const object
 * keeps downstream code honest about what the classifier will ever
 * produce; rejecting anything else at the activity boundary is
 * cheaper than debugging a silent branch miss.
 */
export const INTENT_LABELS = [
  "interested",
  "objection",
  "unsubscribe",
  "out_of_office",
  "confused",
  "neutral",
] as const;
export type IntentLabel = (typeof INTENT_LABELS)[number];

const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_MAX_BATCH = 25;
const MIN_CONFIDENCE = 0.5;

/**
 * One tick of the classifier: scan unclassified inbound touchpoints
 * in the lookback window, ask Claude to label them, write back the
 * label + confidence + reason, then (when Temporal is configured)
 * signal every active enrollment the contact participates in.
 *
 * Unsubscribe is handled as a hard safety rail: the classifier
 * AND a keyword sweep both trigger an `enrollment.control` signal
 * with action=unsubscribe. The belt-and-suspenders is deliberate —
 * false negatives on unsubscribe are a compliance issue.
 */
export async function runIntentClassifierTick(
  deps: IntentClassifierJobDeps,
  input: IntentClassifierRunInput,
): Promise<IntentClassifierRunResult> {
  return withSpan(
    "worker.intent_classifier.tick",
    { tenant_id: input.tenantId },
    async () => {
      const clock = deps.now ?? (() => new Date());
      const lookbackHours = input.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
      const maxBatch = input.maxBatch ?? DEFAULT_MAX_BATCH;
      const since = new Date(clock().getTime() - lookbackHours * 3_600_000);

      const candidates = await withTenant(deps.db, input.tenantId, async (tx) =>
        deps.touchpoints.listUnclassifiedInbound(tx, since, maxBatch),
      );

      if (candidates.length === 0) {
        return {
          scanned: 0,
          classified: 0,
          unsubscribes: 0,
          signalsSent: 0,
          skipped: [],
        };
      }

      // Fast-path: obvious unsubscribe phrases get labelled without
      // a Claude call. Covers the regulated baseline without burning
      // tokens on clear cases.
      const classifications: Array<{
        id: string;
        intent: IntentLabel;
        confidence: number;
        reason: string;
      }> = [];
      const skipped: string[] = [];
      const forLlm: typeof candidates = [];
      for (const tp of candidates) {
        const text = extractReplyText(tp.metadata);
        if (!text) {
          skipped.push(tp.id);
          continue;
        }
        const keyword = keywordUnsubscribe(text);
        if (keyword) {
          classifications.push({
            id: tp.id,
            intent: "unsubscribe",
            confidence: 0.98,
            reason: `keyword match: "${keyword}"`,
          });
          continue;
        }
        forLlm.push(tp);
      }

      if (forLlm.length > 0) {
        const llmClassifications = await classifyViaClaude(deps, input.tenantId, forLlm);
        classifications.push(...llmClassifications);
        // Record anything the LLM didn't label as skipped so we
        // don't silently re-query them next tick forever.
        const covered = new Set(llmClassifications.map((c) => c.id));
        for (const tp of forLlm) {
          if (!covered.has(tp.id)) skipped.push(tp.id);
        }
      }

      // Persist labels + audit events + signals.
      let classified = 0;
      let unsubscribes = 0;
      let signalsSent = 0;
      for (const c of classifications) {
        if (c.confidence < MIN_CONFIDENCE && c.intent !== "unsubscribe") {
          // Below-threshold labels get written at `neutral` so the
          // gate DSL still has something to evaluate, but we note the
          // actual label + confidence for audit.
          await withTenant(deps.db, input.tenantId, async (tx) => {
            await deps.touchpoints.markIntent(
              tx,
              c.id,
              "neutral",
              c.confidence,
              `low-confidence ${c.intent} (${c.confidence.toFixed(2)}) → neutral: ${c.reason}`,
            );
          });
          classified += 1;
          continue;
        }

        await withTenant(deps.db, input.tenantId, async (tx) => {
          await deps.touchpoints.markIntent(
            tx,
            c.id,
            c.intent,
            c.confidence,
            c.reason,
          );
          await deps.events.insertIfNotExists(tx, input.tenantId, {
            verb: "agent.intent_classified",
            subjectType: "touchpoint",
            subjectId: c.id,
            actorType: "system",
            actorId: "intent_classifier",
            objectType: "touchpoint",
            objectId: c.id,
            occurredAt: clock(),
            idempotencyKey: `intent.classified:${c.id}`,
            metadata: {
              intent: c.intent,
              confidence: c.confidence,
              reason: c.reason,
            },
          });
        });
        classified += 1;
        if (c.intent === "unsubscribe") unsubscribes += 1;

        // Signal every active enrollment the contact is in.
        const tp = candidates.find((t) => t.id === c.id);
        const contactId = tp?.contactId ?? null;
        if (!contactId || !deps.temporal) continue;

        const activeEnrollments = await withTenant(
          deps.db,
          input.tenantId,
          async (tx) => deps.enrollments.listActiveForContact(tx, contactId),
        );
        for (const enrollment of activeEnrollments) {
          const workflowId = WorkflowId.campaignEnrollment(enrollment.id);
          try {
            const handle = deps.temporal.workflow.getHandle(workflowId);
            await handle.signal("enrollment.touchpoint", {
              kind: "intent_classified",
              occurredAt: tp?.occurredAt.toISOString() ?? clock().toISOString(),
              intent: c.intent,
            });
            if (c.intent === "unsubscribe") {
              await handle.signal("enrollment.control", {
                action: "unsubscribe",
                note: `intent classifier: ${c.reason}`,
              });
            }
            signalsSent += 1;
          } catch (err) {
            const message = (err as Error).message ?? "";
            if (!message.toLowerCase().includes("not found")) {
              log.warn("intent classifier: signal failed", {
                workflow_id: workflowId,
                error: message,
              });
            }
          }
        }
      }

      return {
        scanned: candidates.length,
        classified,
        unsubscribes,
        signalsSent,
        skipped,
      };
    },
  );
}

async function classifyViaClaude(
  deps: IntentClassifierJobDeps,
  tenantId: string,
  items: Array<{ id: string; metadata: Record<string, unknown>; occurredAt: Date }>,
): Promise<
  Array<{ id: string; intent: IntentLabel; confidence: number; reason: string }>
> {
  const payload = {
    inputs: items.map((item) => ({
      id: item.id,
      text: extractReplyText(item.metadata) ?? "",
    })),
  };
  const response = await deps.anthropic.complete({
    tenantId: TenantId(tenantId),
    idempotencyKey: `intent.classify:${tenantId}:${items.map((i) => i.id).join(",")}`,
    system: INTENT_CLASSIFIER_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: JSON.stringify(payload),
      },
    ],
    maxTokens: 1_500,
  });

  const text = response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  let parsed: { classifications?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(stripCodeFences(text)) as typeof parsed;
  } catch {
    log.warn("intent classifier: non-JSON response", { preview: text.slice(0, 200) });
    return [];
  }
  const out: Array<{ id: string; intent: IntentLabel; confidence: number; reason: string }> = [];
  const validIds = new Set(items.map((i) => i.id));
  for (const row of parsed.classifications ?? []) {
    const id = typeof row["id"] === "string" ? (row["id"] as string) : "";
    if (!validIds.has(id)) continue;
    const intent = row["intent"];
    if (!isIntentLabel(intent)) continue;
    const confidence = typeof row["confidence"] === "number"
      ? Math.max(0, Math.min(1, row["confidence"] as number))
      : 0;
    const reason = typeof row["reason"] === "string"
      ? (row["reason"] as string).slice(0, 300)
      : "";
    out.push({ id, intent, confidence, reason });
  }
  return out;
}

function isIntentLabel(value: unknown): value is IntentLabel {
  return typeof value === "string" && (INTENT_LABELS as readonly string[]).includes(value);
}

function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced && fenced[1] ? fenced[1].trim() : text;
}

/**
 * Pull the reply body out of touchpoint metadata. The Resend
 * normalizer stores it in `metadata.text`; Twilio stores it in
 * `metadata.body`. Fall back to other common keys.
 */
function extractReplyText(metadata: Record<string, unknown>): string | null {
  const candidates = ["text", "body", "message", "content"] as const;
  for (const key of candidates) {
    const v = metadata[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

/**
 * Fast-path unsubscribe detector. Case-insensitive, whole-word match
 * on a small vocabulary. Returns the matched term when found so the
 * audit reason is specific. Intentionally narrow — anything fuzzier
 * goes through the LLM path so we can see the full reasoning.
 */
function keywordUnsubscribe(text: string): string | null {
  const lower = text.toLowerCase();
  const patterns: Array<[RegExp, string]> = [
    [/\bunsubscribe\b/, "unsubscribe"],
    [/\bopt[- ]?out\b/, "opt out"],
    [/\bremove me\b/, "remove me"],
    [/\bstop\s+(contacting|emailing|messaging|texting)\b/, "stop contacting"],
    [/\bdo\s+not\s+(contact|email|message)\b/, "do not contact"],
    [/\bdon'?t\s+contact\s+me\s+again\b/, "don't contact me again"],
    [/\bthis\s+is\s+spam\b/, "this is spam"],
  ];
  for (const [re, label] of patterns) {
    if (re.test(lower)) return label;
  }
  return null;
}
