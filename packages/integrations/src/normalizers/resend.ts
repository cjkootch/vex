import { z } from "zod";
import type { NormalizerDeps, NormalizerOutcome, RawEventInput } from "./types.js";

/**
 * Resend → canonical verb mapping.
 *
 * Confidence:
 *   - opens are notoriously noisy (image-pixel based, prefetched by gateways)
 *     so we tag them `weak`.
 *   - clicks require an actual HTTP fetch by the recipient → `strong`.
 */
const VERB_MAP: Record<string, string> = {
  "email.sent": "email.sent",
  "email.delivered": "email.delivered",
  "email.opened": "email.opened",
  "email.clicked": "email.clicked",
  "email.bounced": "email.bounced",
  "email.complained": "email.complained",
};

const CONFIDENCE_BY_TYPE: Record<string, "weak" | "strong" | undefined> = {
  "email.opened": "weak",
  "email.clicked": "strong",
};

const ResendPayload = z.object({
  type: z.string(),
  created_at: z.string().optional(),
  data: z
    .object({
      to: z.array(z.string().email()).optional(),
      from: z.string().email().optional(),
      subject: z.string().optional(),
      tags: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
      // Resend's stable id for the outbound message — same value the
      // executor stamps on `approval.executor.applied`'s metadata at
      // send-time, so it's the linkage key for delivery follow-ups.
      email_id: z.string().optional(),
      click: z
        .object({
          link: z.string().url(),
          ipAddress: z.string().optional(),
          userAgent: z.string().optional(),
          timestamp: z.string().optional(),
        })
        .optional(),
      bounce: z.object({ type: z.string() }).optional(),
    })
    .passthrough(),
});

function svixId(headers: Record<string, unknown>): string | undefined {
  const direct = headers["svix-id"];
  if (typeof direct === "string") return direct;
  const lower = headers["Svix-Id"];
  if (typeof lower === "string") return lower;
  return undefined;
}

function findCampaignFromTags(
  tags?: { name: string; value: string }[],
): string | null {
  if (!tags) return null;
  const tag = tags.find((t) => t.name === "campaign_id");
  return tag?.value ?? null;
}

export class ResendNormalizer {
  constructor(private readonly deps: NormalizerDeps) {}

  async normalize(raw: RawEventInput): Promise<NormalizerOutcome> {
    const parsed = ResendPayload.safeParse(raw.payload);
    if (!parsed.success) {
      throw new Error(`Resend payload failed validation: ${parsed.error.message}`);
    }
    const payload = parsed.data;
    const verb = VERB_MAP[payload.type];
    if (!verb) {
      return { status: "skipped", reason: `unknown resend event type: ${payload.type}` };
    }

    const id = svixId(raw.headers);
    if (!id) {
      throw new Error("Resend webhook missing svix-id header");
    }

    const recipient = payload.data.to?.[0];
    const contact = recipient
      ? await this.deps.contacts.findByEmail(this.deps.tx, recipient)
      : null;

    const campaignId = findCampaignFromTags(payload.data.tags);
    const occurredAt = payload.created_at ? new Date(payload.created_at) : raw.receivedAt;

    const metadata: Record<string, unknown> = {};
    const confidence = CONFIDENCE_BY_TYPE[payload.type];
    if (confidence) metadata["confidence"] = confidence;
    if (payload.data.click?.link) metadata["url"] = payload.data.click.link;
    if (payload.data.bounce?.type) metadata["bounce_type"] = payload.data.bounce.type;
    if (payload.data.subject) metadata["subject"] = payload.data.subject;
    if (payload.data.email_id) metadata["provider_message_id"] = payload.data.email_id;

    await this.deps.touchpoints.insert(this.deps.tx, raw.tenantId, {
      channel: "email",
      actor: "resend",
      occurredAt,
      campaignId,
      contactId: contact?.id ?? null,
      orgId: contact?.orgId ?? null,
      metadata: { ...metadata, verb, recipient },
    });

    const { event, isNew } = await this.deps.events.insertIfNotExists(
      this.deps.tx,
      raw.tenantId,
      {
        verb,
        subjectType: "contact",
        subjectId: contact?.id ?? recipient ?? raw.providerEventId,
        actorType: "campaign",
        actorId: campaignId,
        objectType: "email",
        objectId: id,
        occurredAt,
        idempotencyKey: `resend:${id}`,
        metadata,
      },
    );

    // When delivery confirms an approval-driven outbound, mirror the
    // signal onto the originating approval row so the chat chip can
    // flip from "applied" → "delivered". Lookup is keyed on Resend's
    // stable email_id, which the executor stamped on
    // `approval.executor.applied` at send-time. Fail-soft: a missing
    // apply event (orphan webhook, replay across schema cuts) just
    // means we skip the linkage — the contact-timeline event still
    // lands.
    if (verb === "email.delivered" && payload.data.email_id) {
      const apply = await this.deps.events.findApplyByProviderMessageId(
        this.deps.tx,
        payload.data.email_id,
      );
      if (apply) {
        await this.deps.events.insertIfNotExists(
          this.deps.tx,
          raw.tenantId,
          {
            verb: "approval.executor.delivered",
            subjectType: "approval",
            subjectId: apply.subjectId,
            actorType: "system",
            actorId: "resend_webhook",
            objectType: "approval",
            objectId: apply.subjectId,
            occurredAt,
            idempotencyKey: `approval.executor.delivered:${apply.subjectId}:${id}`,
            metadata: {
              action_type: "email.send",
              provider_message_id: payload.data.email_id,
              ...(recipient ? { recipient } : {}),
            },
          },
        );
      }
    }

    return { status: "ok", eventId: event.id, isNewEvent: isNew };
  }
}
