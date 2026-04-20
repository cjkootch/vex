import { z } from "zod";
import { createId } from "@vex/domain";
import type { NormalizerDeps, NormalizerOutcome, RawEventInput } from "./types.js";

/**
 * Website form-fill normalizer. Handles the single `form.submitted` event
 * posted by the VTC marketing site's #lead-form.
 *
 * Pipeline mirrors the website-chat started-event path:
 *   1. Org: find-or-create by email domain.
 *   2. Contact: find-or-create by email, stash phone + sms_consent.
 *   3. Lead: find-or-create by (form_id, email) external key so a repeat
 *      submission from the same person updates the same lead.
 *   4. Touchpoint with channel `web_form`.
 *   5. Event `lead.captured` with a 5-minute bucketed idempotency key
 *      so a double-click that slips past webhook-layer dedup still
 *      collapses into one audit row.
 *
 * Honeypot: if `fields._gotcha` is non-empty, short-circuit to a
 * `bot.form_rejected` audit event and return `status: skipped`. No
 * contact, lead, or touchpoint is created.
 */

const Lead = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(200),
  phone: z.string().max(50).nullish(),
  sms_consent: z.boolean().nullish(),
});

const Page = z
  .object({
    url: z.string().nullish(),
    referrer: z.string().nullish(),
    utm: z.record(z.string()).nullish(),
  })
  .nullish();

// `fields` is a free-form record from the form; the normalizer only
// treats `_gotcha`, `message`, `country`, `product_interest` specially.
// Any other string fields ride through in touchpoint metadata.
const Fields = z
  .record(z.union([z.string(), z.boolean(), z.number(), z.null()]))
  .nullish();

const Payload = z.object({
  event: z.literal("form.submitted"),
  form_id: z.string().min(1).max(100),
  form_name: z.string().max(200).nullish(),
  timestamp: z.string().nullish(),
  website_version: z.string().nullish(),
  lead: Lead,
  fields: Fields,
  page: Page,
});

const FIVE_MIN_MS = 5 * 60 * 1000;

export class FormFillNormalizer {
  constructor(private readonly deps: NormalizerDeps) {}

  async normalize(raw: RawEventInput): Promise<NormalizerOutcome> {
    const parsed = Payload.safeParse(raw.payload);
    if (!parsed.success) {
      throw new Error(
        `website_form payload failed validation: ${parsed.error.message}`,
      );
    }
    const payload = parsed.data;
    requireRepos(this.deps);

    const occurredAt = payload.timestamp
      ? new Date(payload.timestamp)
      : raw.receivedAt;

    const honeypot = extractHoneypot(payload.fields);
    if (honeypot) {
      const { event, isNew } = await this.deps.events.insertIfNotExists(
        this.deps.tx,
        raw.tenantId,
        {
          verb: "bot.form_rejected",
          subjectType: "raw_event",
          subjectId: raw.id,
          actorType: "website",
          actorId: null,
          objectType: "raw_event",
          objectId: raw.id,
          occurredAt,
          idempotencyKey: `website_form.honeypot:${raw.id}`,
          metadata: {
            source: "website_form",
            form_id: payload.form_id,
            email: payload.lead.email,
            honeypot_length: honeypot.length,
          },
        },
      );
      return { status: "skipped", reason: `honeypot:${event.id}:${isNew}` };
    }

    const { orgId, contactId } = await this.resolveOrgAndContact(
      raw.tenantId,
      payload.lead,
    );

    const externalKey = `website_form.form_id:${payload.form_id}:${payload.lead.email}`;
    const existing = await this.deps.leads!.findByExternalKey(
      this.deps.tx,
      "website_form.form_email",
      externalKey,
    );
    const lead =
      existing ??
      (await this.deps.leads!.create(this.deps.tx, raw.tenantId, {
        orgId,
        contactId,
        status: "new",
        stage: "form_fill_submitted",
        externalKeys: {
          "website_form.form_email": externalKey,
          "website_form.form_id": payload.form_id,
          ...(payload.website_version
            ? { "website_form.version": payload.website_version }
            : {}),
        },
      }));

    const fields = payload.fields ?? {};
    const message = typeof fields["message"] === "string"
      ? (fields["message"] as string)
      : null;
    const country = typeof fields["country"] === "string"
      ? (fields["country"] as string)
      : null;
    const productInterest = typeof fields["product_interest"] === "string"
      ? (fields["product_interest"] as string)
      : null;

    await this.deps.touchpoints.insert(this.deps.tx, raw.tenantId, {
      channel: "web_form",
      actor: "website",
      occurredAt,
      leadId: lead.id,
      contactId,
      orgId,
      metadata: {
        form_id: payload.form_id,
        form_name: payload.form_name ?? null,
        country,
        product_interest: productInterest,
        message,
        sms_consent: payload.lead.sms_consent ?? null,
        phone: payload.lead.phone ?? null,
        page_url: payload.page?.url ?? null,
        referrer: payload.page?.referrer ?? null,
        utm: payload.page?.utm ?? null,
      },
    });

    const bucket = Math.floor(occurredAt.getTime() / FIVE_MIN_MS) * FIVE_MIN_MS;
    const idempotencyKey = `website_form.captured:${payload.form_id}:${payload.lead.email}:${bucket}`;

    const { event, isNew } = await this.deps.events.insertIfNotExists(
      this.deps.tx,
      raw.tenantId,
      {
        verb: "lead.captured",
        subjectType: "lead",
        subjectId: lead.id,
        actorType: "website",
        actorId: null,
        objectType: "contact",
        objectId: contactId,
        occurredAt,
        idempotencyKey,
        metadata: {
          source: "website_form",
          form_id: payload.form_id,
          form_name: payload.form_name ?? null,
          country,
          product_interest: productInterest,
          message,
          sms_consent: payload.lead.sms_consent ?? null,
          page_url: payload.page?.url ?? null,
          referrer: payload.page?.referrer ?? null,
          utm: payload.page?.utm ?? null,
          website_version: payload.website_version ?? null,
        },
      },
    );

    return { status: "ok", eventId: event.id, isNewEvent: isNew, leadId: lead.id };
  }

  private async resolveOrgAndContact(
    tenantId: string,
    lead: z.infer<typeof Lead>,
  ): Promise<{ orgId: string; contactId: string }> {
    const domain = extractDomain(lead.email);

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

    let contact = await this.deps.contacts.findByEmail(this.deps.tx, lead.email);
    if (!contact) {
      contact = await this.deps.contacts.create(this.deps.tx, tenantId, {
        id: createId(),
        orgId: org.id,
        fullName: lead.name,
        emails: [lead.email],
        phones: lead.phone ? [lead.phone] : [],
      });
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
  if (missing.length > 0) {
    throw new Error(
      `website_form normalizer requires repos: ${missing.join(", ")}`,
    );
  }
}

function extractDomain(email: string): string {
  const at = email.lastIndexOf("@");
  if (at === -1) return "unknown";
  return email.slice(at + 1).trim().toLowerCase();
}

function extractHoneypot(
  fields: z.infer<typeof Fields>,
): string | null {
  if (!fields) return null;
  const v = fields["_gotcha"];
  if (typeof v === "string" && v.trim().length > 0) return v;
  return null;
}
