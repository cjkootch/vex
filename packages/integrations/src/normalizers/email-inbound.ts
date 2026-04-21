import { z } from "zod";
import type { NormalizerDeps, NormalizerOutcome, RawEventInput } from "./types.js";

/**
 * Provider-agnostic inbound-email normalizer. Accepts a canonical JSON
 * payload any inbound-email service can POST to `/webhooks/email-inbound`
 * after a thin translation shim:
 *   - Resend Inbound (email.received event)
 *   - SendGrid Inbound Parse
 *   - Postmark Inbound
 *   - Mailgun Routes
 *   - AWS SES → Lambda
 *
 * What it does (v1):
 *   1. Match `from` address to an existing contact. If none matches, we
 *      still write the touchpoint but leave `contact_id` null so the
 *      operator can dedupe / triage in the inbox.
 *   2. Write an `email` channel touchpoint with direction=inbound +
 *      threading metadata (message_id, in_reply_to, subject, preview).
 *   3. Emit an `email.received` audit event keyed on the inbound
 *      Message-ID so retries of the same webhook collapse cleanly.
 *
 * What it does NOT do yet (Phase 2):
 *   - Parse the body for deal terms / propose a `deal.update_supplier_terms`
 *     approval. That's the LLM-driven follow-on once an RFQ-match is wired.
 */

const EmailInboundPayload = z.object({
  event: z.literal("email.received"),
  from: z.string().email(),
  to: z.array(z.string().email()).min(1),
  subject: z.string().max(500).optional().nullable(),
  text: z.string().max(200_000).optional().nullable(),
  html: z.string().max(500_000).optional().nullable(),
  message_id: z.string().min(1).max(500),
  in_reply_to: z.string().max(500).optional().nullable(),
  received_at: z.string().optional().nullable(),
});

/** First-N chars of the plain-text body, used for list views. */
const PREVIEW_CHARS = 240;
/**
 * Cap on the stored body copy inside touchpoint metadata. Full,
 * un-truncated bodies remain in raw_events.payload; this copy is a
 * convenience for the inbox drill-in render path so it doesn't need
 * a second query. 64KB covers >99% of real email bodies; anything
 * longer is truncated with a visible `…` marker on the reader side.
 */
const BODY_CAP = 64_000;

export class EmailInboundNormalizer {
  constructor(private readonly deps: NormalizerDeps) {}

  async normalize(raw: RawEventInput): Promise<NormalizerOutcome> {
    const parsed = EmailInboundPayload.safeParse(raw.payload);
    if (!parsed.success) {
      throw new Error(
        `email_inbound payload failed validation: ${parsed.error.message}`,
      );
    }
    const payload = parsed.data;

    const fromAddress = payload.from.toLowerCase().trim();
    const contact = await this.deps.contacts.findByEmail(this.deps.tx, fromAddress);

    const body = payload.text ?? payload.html ?? "";
    const preview = body.slice(0, PREVIEW_CHARS).trim();
    // Cap the stored body at BODY_CAP to keep touchpoint rows sane —
    // the full body lives in raw_events.payload anyway; this copy is
    // for the inbox drill-in render without a raw_events fetch.
    const bodyText = payload.text ? payload.text.slice(0, BODY_CAP) : null;
    const bodyHtml = payload.html ? payload.html.slice(0, BODY_CAP) : null;
    const occurredAt = payload.received_at
      ? new Date(payload.received_at)
      : raw.receivedAt;

    const metadata: Record<string, unknown> = {
      direction: "inbound",
      verb: "email.received",
      from: fromAddress,
      to: payload.to,
      message_id: payload.message_id,
      ...(payload.in_reply_to ? { in_reply_to: payload.in_reply_to } : {}),
      ...(payload.subject ? { subject: payload.subject } : {}),
      ...(preview ? { preview } : {}),
      ...(bodyText ? { body_text: bodyText } : {}),
      ...(bodyHtml ? { body_html: bodyHtml } : {}),
    };

    await this.deps.touchpoints.insert(this.deps.tx, raw.tenantId, {
      // Mirror the outbound naming (`email.sent`) so the Inbox
      // channelGroupFor classifier and timeline status-badge split
      // work identically on inbound + outbound rows. A bare "email"
      // fell through to `channelGroup = "other"` in the inbox UI
      // because the classifier keys off `startsWith("email.")`.
      channel: "email.received",
      actor: "email_inbound",
      occurredAt,
      contactId: contact?.id ?? null,
      orgId: contact?.orgId ?? null,
      metadata,
    });

    const { event, isNew } = await this.deps.events.insertIfNotExists(
      this.deps.tx,
      raw.tenantId,
      {
        verb: "email.received",
        subjectType: "contact",
        subjectId: contact?.id ?? fromAddress,
        actorType: "contact",
        actorId: contact?.id ?? null,
        objectType: "email",
        objectId: payload.message_id,
        occurredAt,
        idempotencyKey: `email.received:${payload.message_id}`,
        // preview + from land in the event metadata so the contact
        // Activity tab can render subject/preview/from inline without
        // a separate touchpoint fetch — the ActivityTimeline only
        // reads events, not touchpoints.
        metadata: {
          from: fromAddress,
          ...(payload.in_reply_to ? { in_reply_to: payload.in_reply_to } : {}),
          ...(payload.subject ? { subject: payload.subject } : {}),
          ...(preview ? { preview } : {}),
          matched_contact: contact?.id ?? null,
        },
      },
    );

    return { status: "ok", eventId: event.id, isNewEvent: isNew };
  }
}
