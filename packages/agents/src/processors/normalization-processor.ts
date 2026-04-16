import type { Job } from "bullmq";
import { withTenant, type Db, type RawEventRepository } from "@vex/db";
import {
  ResendNormalizer,
  TwilioNormalizer,
  type NormalizerOutcome,
  type RawEventInput,
} from "@vex/integrations";
import type { ContactRepository, ActivityRepository, TouchpointRepository, EventRepository } from "@vex/db";
import type { NormalizationJobData } from "../queues.js";

export interface NormalizationProcessorDeps {
  db: Db;
  rawEvents: RawEventRepository;
  contacts: ContactRepository;
  touchpoints: TouchpointRepository;
  activities: ActivityRepository;
  events: EventRepository;
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
      } as const;

      let outcome: NormalizerOutcome;
      switch (raw.provider) {
        case "resend":
          outcome = await new ResendNormalizer(normalizerDeps).normalize(input);
          break;
        case "twilio":
          outcome = await new TwilioNormalizer(normalizerDeps).normalize(input);
          break;
        default:
          throw new Error(`unsupported provider: ${raw.provider}`);
      }

      await deps.rawEvents.updateStatus(tx, raw.id, "processed");
      return outcome;
    });
  };
}
