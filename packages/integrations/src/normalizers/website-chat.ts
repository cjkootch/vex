import { z } from "zod";
import { createId } from "@vex/domain";
import type { NormalizerDeps, NormalizerOutcome, RawEventInput } from "./types.js";

/**
 * Website-chat normalizer. Two event kinds flow through here:
 *
 *   conversation.started
 *     Fires when the chat's gate captures {name, email} — before the
 *     first message. Creates (or attaches to) an Organization keyed on
 *     email domain, a Contact keyed on email, and a Lead row whose
 *     externalKeys map back to the conversation_id.
 *
 *   conversation.ended
 *     Fires on idle or page unload. Carries the full transcript. We
 *     attach the transcript as a Document against the Contact, record
 *     a touchpoint, and emit a `lead.transcript_received` event that
 *     downstream workers can pick up to run qualification parsing.
 *
 * The normalizer is deliberately idempotent at every step:
 *   - Org + Contact dedupe on normalized identity (legal name / email)
 *   - Lead lookup by conversation_id before creation
 *   - Events use deterministic idempotency keys
 *
 * If the caller's NormalizerDeps doesn't include `organizations`,
 * `memberships`, `leads`, or `documents`, this normalizer throws — the
 * website-chat path requires all four.
 */

const Lead = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(200),
});

const Page = z
  .object({
    url: z.string().nullish(),
    referrer: z.string().nullish(),
    utm: z.record(z.string()).nullish(),
  })
  .nullish();

const Message = z.object({
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  ts: z.string().nullish(),
});

const Started = z.object({
  event: z.literal("conversation.started"),
  conversation_id: z.string().min(1),
  website_version: z.string().nullish(),
  timestamp: z.string().nullish(),
  lead: Lead,
  page: Page,
});

const Ended = z.object({
  event: z.literal("conversation.ended"),
  conversation_id: z.string().min(1),
  website_version: z.string().nullish(),
  timestamp: z.string().nullish(),
  lead: Lead,
  page: Page,
  messages: z.array(Message).min(1),
});

const Payload = z.discriminatedUnion("event", [Started, Ended]);

export class WebsiteChatNormalizer {
  constructor(private readonly deps: NormalizerDeps) {}

  async normalize(raw: RawEventInput): Promise<NormalizerOutcome> {
    const parsed = Payload.safeParse(raw.payload);
    if (!parsed.success) {
      throw new Error(
        `website_chat payload failed validation: ${parsed.error.message}`,
      );
    }
    const payload = parsed.data;
    requireRepos(this.deps);

    const occurredAt = payload.timestamp
      ? new Date(payload.timestamp)
      : raw.receivedAt;

    if (payload.event === "conversation.started") {
      return this.handleStarted(raw, payload, occurredAt);
    }
    return this.handleEnded(raw, payload, occurredAt);
  }

  private async handleStarted(
    raw: RawEventInput,
    payload: z.infer<typeof Started>,
    occurredAt: Date,
  ): Promise<NormalizerOutcome> {
    const { tenantId } = raw;
    const { orgId, contactId } = await this.resolveOrgAndContact(
      tenantId,
      payload.lead,
    );

    // Reuse the lead if the same conversation already landed (retry).
    const existing = await this.deps.leads!.findByExternalKey(
      this.deps.tx,
      "website_chat.conversation_id",
      payload.conversation_id,
    );
    const lead =
      existing ??
      (await this.deps.leads!.create(this.deps.tx, tenantId, {
        orgId,
        contactId,
        status: "new",
        stage: "website_chat_started",
        externalKeys: {
          "website_chat.conversation_id": payload.conversation_id,
          ...(payload.website_version
            ? { "website_chat.version": payload.website_version }
            : {}),
        },
      }));

    await this.deps.touchpoints.insert(this.deps.tx, tenantId, {
      channel: "website_chat.gate",
      actor: "website",
      occurredAt,
      leadId: lead.id,
      contactId,
      orgId,
      metadata: {
        conversation_id: payload.conversation_id,
        page_url: payload.page?.url ?? null,
        referrer: payload.page?.referrer ?? null,
        utm: payload.page?.utm ?? null,
      },
    });

    const { event, isNew } = await this.deps.events.insertIfNotExists(
      this.deps.tx,
      tenantId,
      {
        verb: "lead.captured",
        subjectType: "lead",
        subjectId: lead.id,
        actorType: "website",
        actorId: null,
        objectType: "contact",
        objectId: contactId,
        occurredAt,
        idempotencyKey: `website_chat.started:${payload.conversation_id}`,
        metadata: {
          source: "website_chat",
          conversation_id: payload.conversation_id,
          page_url: payload.page?.url ?? null,
          referrer: payload.page?.referrer ?? null,
          utm: payload.page?.utm ?? null,
          website_version: payload.website_version ?? null,
        },
      },
    );

    return { status: "ok", eventId: event.id, isNewEvent: isNew };
  }

  private async handleEnded(
    raw: RawEventInput,
    payload: z.infer<typeof Ended>,
    occurredAt: Date,
  ): Promise<NormalizerOutcome> {
    const { tenantId } = raw;
    const { orgId, contactId } = await this.resolveOrgAndContact(
      tenantId,
      payload.lead,
    );

    // If conversation.started was missed, lazily create the lead so
    // downstream workers still have something to hang off of.
    let lead = await this.deps.leads!.findByExternalKey(
      this.deps.tx,
      "website_chat.conversation_id",
      payload.conversation_id,
    );
    if (!lead) {
      lead = await this.deps.leads!.create(this.deps.tx, tenantId, {
        orgId,
        contactId,
        status: "new",
        stage: "website_chat_ended",
        externalKeys: {
          "website_chat.conversation_id": payload.conversation_id,
          ...(payload.website_version
            ? { "website_chat.version": payload.website_version }
            : {}),
        },
      });
    }

    const transcriptText = renderTranscript(payload.messages);
    const storageKey = `website-chat/${payload.conversation_id}.txt`;
    const document = await this.deps.documents!.insert(this.deps.tx, tenantId, {
      subjectType: "contact",
      subjectId: contactId,
      orgId,
      title: `Website chat transcript — ${formatShortDate(occurredAt)}`,
      filename: `chat-${payload.conversation_id}.txt`,
      mimeType: "text/plain",
      sizeBytes: Buffer.byteLength(transcriptText, "utf8"),
      documentType: "chat_transcript",
      storageKey,
      extractedText: transcriptText,
      uploadedBy: null,
    });

    await this.deps.touchpoints.insert(this.deps.tx, tenantId, {
      channel: "website_chat.ended",
      actor: "website",
      occurredAt,
      leadId: lead.id,
      contactId,
      orgId,
      metadata: {
        conversation_id: payload.conversation_id,
        message_count: payload.messages.length,
        document_id: document.id,
      },
    });

    const { event, isNew } = await this.deps.events.insertIfNotExists(
      this.deps.tx,
      tenantId,
      {
        verb: "lead.transcript_received",
        subjectType: "lead",
        subjectId: lead.id,
        actorType: "website",
        actorId: null,
        objectType: "document",
        objectId: document.id,
        occurredAt,
        idempotencyKey: `website_chat.ended:${payload.conversation_id}`,
        metadata: {
          source: "website_chat",
          conversation_id: payload.conversation_id,
          message_count: payload.messages.length,
          document_id: document.id,
          website_version: payload.website_version ?? null,
        },
      },
    );

    return { status: "ok", eventId: event.id, isNewEvent: isNew };
  }

  private async resolveOrgAndContact(
    tenantId: string,
    lead: { name: string; email: string },
  ): Promise<{ orgId: string; contactId: string }> {
    const domain = extractDomain(lead.email);

    // Org: find by domain (via normalized identity) or create with the
    // domain as the legal name stand-in until a human cleans it up.
    let org = await this.deps.organizations!.findByNormalizedIdentity(
      this.deps.tx,
      domain,
      domain,
    );
    if (!org) {
      org = await this.deps.organizations!.create(this.deps.tx, tenantId, {
        id: createId(),
        legalName: domain,
        domain,
      });
    }

    // Contact: find by email or create attached to the resolved org.
    let contact = await this.deps.contacts.findByEmail(
      this.deps.tx,
      lead.email,
    );
    if (!contact) {
      contact = await this.deps.contacts.create(this.deps.tx, tenantId, {
        id: createId(),
        orgId: org.id,
        fullName: lead.name,
        emails: [lead.email],
      });
      // Sprint-14 memberships table. Keep in sync so the m:n readers
      // see this contact on the org's detail page.
      await this.deps.memberships!.create(this.deps.tx, tenantId, {
        contactId: contact.id,
        orgId: org.id,
        role: null,
        isPrimary: true,
      });
    }
    return { orgId: org.id, contactId: contact.id };
  }
}

function requireRepos(deps: NormalizerDeps): void {
  const missing: string[] = [];
  if (!deps.organizations) missing.push("organizations");
  if (!deps.memberships) missing.push("memberships");
  if (!deps.leads) missing.push("leads");
  if (!deps.documents) missing.push("documents");
  if (missing.length > 0) {
    throw new Error(
      `website_chat normalizer requires repos: ${missing.join(", ")}`,
    );
  }
}

function extractDomain(email: string): string {
  const at = email.lastIndexOf("@");
  if (at === -1) return "unknown";
  return email.slice(at + 1).trim().toLowerCase();
}

function renderTranscript(
  messages: Array<{ role: string; text: string; ts?: string | null | undefined }>,
): string {
  return messages
    .map((m) => {
      const stamp = m.ts ? `[${m.ts}] ` : "";
      const who = m.role === "user" ? "Visitor" : m.role === "assistant" ? "Vex" : m.role;
      return `${stamp}${who}: ${m.text}`;
    })
    .join("\n\n");
}

function formatShortDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
