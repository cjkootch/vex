import type { Job, Queue } from "bullmq";
import { withTenant, type Db, type RawEventRepository } from "@vex/db";
import {
  EmailInboundNormalizer,
  FormFillNormalizer,
  ResendNormalizer,
  TwilioNormalizer,
  WebsiteChatNormalizer,
  type NormalizerOutcome,
  type RawEventInput,
} from "@vex/integrations";
import type {
  ActivityRepository,
  ContactOrgMembershipRepository,
  ContactRepository,
  DocumentRepository,
  EventRepository,
  LeadRepository,
  OrganizationRepository,
  TouchpointRepository,
} from "@vex/db";
import { addAgentJob } from "../queues.js";
import type { AgentJobData, NormalizationJobData } from "../queues.js";

export interface NormalizationProcessorDeps {
  db: Db;
  rawEvents: RawEventRepository;
  contacts: ContactRepository;
  touchpoints: TouchpointRepository;
  activities: ActivityRepository;
  events: EventRepository;
  /** Present when the website-chat normalizer needs to be served. */
  organizations?: OrganizationRepository;
  memberships?: ContactOrgMembershipRepository;
  leads?: LeadRepository;
  documents?: DocumentRepository;
  /**
   * Optional agents queue. When provided, a successful website_chat
   * `conversation.ended` normalization enqueues a `lead_qualification`
   * agent job so Claude can extract structured fields from the
   * transcript. Omit in tests that don't care about the follow-up.
   */
  agentsQueue?: Queue<AgentJobData>;
}

/**
 * Build a BullMQ processor that fetches the raw_event row, dispatches it to
 * the right provider normalizer, and updates the raw_event status.
 *
 * Tenant isolation:
 *   - The job payload MUST carry a `tenant_id`. A missing value fails the
 *     job immediately with no retries (BullMQ won't reschedule).
 *   - All DB work happens inside `withTenant(db, tenantId, ...)` so RLS
 *     scopes every read and write to the right tenant.
 *
 * On thrown errors the row is *not* marked failed here — that's the DLQ
 * processor's job, after BullMQ has exhausted retries.
 */
export function buildNormalizationProcessor(deps: NormalizationProcessorDeps) {
  return async function normalize(
    job: Job<NormalizationJobData>,
  ): Promise<NormalizerOutcome> {
    const tenantId = job.data.tenant_id;
    if (!tenantId) {
      // Discard immediately — BullMQ does not retry when the processor
      // throws an UnrecoverableError (a sentinel; we use a plain Error
      // here and rely on the DLQ to capture it without retrying via
      // attempts:1 reuse — but missing tenant is a programming error,
      // not a data problem).
      throw new Error(
        `normalization: missing tenant_id on job ${job.id ?? "unknown"} — refusing to process`,
      );
    }

    return withTenant(deps.db, tenantId, async (tx) => {
      const raw = await deps.rawEvents.findById(tx, job.data.raw_event_id);
      if (!raw) {
        throw new Error(`raw_event ${job.data.raw_event_id} not found`);
      }

      const input: RawEventInput = {
        id: raw.id,
        tenantId: raw.tenantId,
        provider: raw.provider,
        providerEventId: raw.providerEventId,
        receivedAt: raw.receivedAt,
        headers: raw.headers,
        payload: raw.payload,
      };

      const normalizerDeps = {
        tx,
        contacts: deps.contacts,
        touchpoints: deps.touchpoints,
        activities: deps.activities,
        events: deps.events,
        ...(deps.organizations ? { organizations: deps.organizations } : {}),
        ...(deps.memberships ? { memberships: deps.memberships } : {}),
        ...(deps.leads ? { leads: deps.leads } : {}),
        ...(deps.documents ? { documents: deps.documents } : {}),
      } as const;

      let outcome: NormalizerOutcome;
      switch (raw.provider) {
        case "resend":
          outcome = await new ResendNormalizer(normalizerDeps).normalize(input);
          break;
        case "twilio":
          outcome = await new TwilioNormalizer(normalizerDeps).normalize(input);
          break;
        case "website_chat":
          outcome = await new WebsiteChatNormalizer(normalizerDeps).normalize(
            input,
          );
          break;
        case "website_form":
          outcome = await new FormFillNormalizer(normalizerDeps).normalize(
            input,
          );
          break;
        case "email_inbound":
          outcome = await new EmailInboundNormalizer(
            normalizerDeps,
          ).normalize(input);
          break;
        default:
          throw new Error(`unsupported provider: ${raw.provider}`);
      }

      await deps.rawEvents.updateStatus(tx, raw.id, "processed");

      // Fan-out hook: a successful lead-capture normalization queues
      // the LeadQualificationAgent so Claude extracts {product, volume,
      // destination, timeline, urgency, intent} from whatever the
      // caller provided. Runs outside the tx so an agents-queue hiccup
      // can't roll back the normalization.
      //
      // Two triggers:
      //   - website_chat + `conversation.ended`   → by conversation_id
      //   - website_form + fresh lead on outcome  → by lead_id (form
      //     submissions have no "ended" moment — the single HTTP POST
      //     is the whole signal)
      if (deps.agentsQueue && outcome.status === "ok") {
        if (
          raw.provider === "website_chat" &&
          (raw.payload as { event?: unknown }).event === "conversation.ended"
        ) {
          const conversationId = (raw.payload as { conversation_id?: unknown })
            .conversation_id;
          if (typeof conversationId === "string") {
            await addAgentJob(
              deps.agentsQueue,
              {
                kind: "lead_qualification",
                workspace_id: tenantId,
                input: {
                  source: "website_chat",
                  conversation_id: conversationId,
                },
              },
              `chat:${conversationId}`,
            );
          }
        } else if (raw.provider === "website_form" && outcome.leadId) {
          await addAgentJob(
            deps.agentsQueue,
            {
              kind: "lead_qualification",
              workspace_id: tenantId,
              input: {
                source: "website_form",
                lead_id: outcome.leadId,
              },
            },
            // Include raw_event id in the dedup key so a repeat submission
            // from the same lead (different raw_event) still re-qualifies
            // against the newer touchpoint metadata.
            `form:${outcome.leadId}:${raw.id}`,
          );
        }
      }

      return outcome;
    });
  };
}
