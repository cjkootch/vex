import type { Job } from "bullmq";
import type { RawEventRepository } from "@vex/db";
import {
  ResendNormalizer,
  TwilioNormalizer,
  type NormalizerDeps,
  type NormalizerOutcome,
  type RawEventInput,
} from "@vex/integrations";
import type { NormalizationJobData } from "../queues.js";

export interface NormalizationProcessorDeps extends NormalizerDeps {
  rawEvents: RawEventRepository;
}

/**
 * Build a BullMQ processor that fetches the raw_event row, dispatches it to
 * the right provider normalizer, and updates the raw_event status.
 *
 * On thrown errors the row is *not* marked failed here — that's the DLQ
 * processor's job, after BullMQ has exhausted retries. Throwing rebubbles
 * through BullMQ so the retry/backoff logic kicks in.
 */
export function buildNormalizationProcessor(deps: NormalizationProcessorDeps) {
  const resend = new ResendNormalizer(deps);
  const twilio = new TwilioNormalizer(deps);

  return async function normalize(
    job: Job<NormalizationJobData>,
  ): Promise<NormalizerOutcome> {
    const raw = await deps.rawEvents.findById(job.data.tenant_id, job.data.raw_event_id);
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

    let outcome: NormalizerOutcome;
    switch (raw.provider) {
      case "resend":
        outcome = await resend.normalize(input);
        break;
      case "twilio":
        outcome = await twilio.normalize(input);
        break;
      default:
        throw new Error(`unsupported provider: ${raw.provider}`);
    }

    await deps.rawEvents.updateStatus(raw.tenantId, raw.id, "processed");
    return outcome;
  };
}
