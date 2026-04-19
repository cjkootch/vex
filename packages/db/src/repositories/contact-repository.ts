import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Tx } from "../client.js";
import { contacts, type Contact } from "../schema/contacts.js";
import { contactOrgMemberships } from "../schema/contact-org-memberships.js";

export interface ContactCreateInput {
  id: string;
  orgId: string;
  fullName: string;
  title?: string | null;
  emails?: string[];
  phones?: string[];
  timezone?: string | null;
}

/** Stateless. Caller must wrap in `withTenant` so RLS scopes the queries. */
export class ContactRepository {
  async findById(tx: Tx, id: string): Promise<Contact | null> {
    const [row] = await tx.select().from(contacts).where(eq(contacts.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * Dedupe-aware create. Walks the supplied emails against existing
   * contacts and short-circuits if any match, so both the direct API
   * path and the approval executor get the same collision behavior.
   * Returns a tagged result — caller decides whether to throw (direct)
   * or mark-applied + emit a replay event (executor).
   */
  async createWithDedupeCheck(
    tx: Tx,
    tenantId: string,
    input: ContactCreateInput,
  ): Promise<
    | { kind: "created"; contact: Contact }
    | { kind: "duplicate"; contact: Contact; matchedEmail: string }
  > {
    for (const email of input.emails ?? []) {
      const duplicate = await this.findByEmail(tx, email);
      if (duplicate) {
        return { kind: "duplicate", contact: duplicate, matchedEmail: email };
      }
    }
    const contact = await this.create(tx, tenantId, input);
    return { kind: "created", contact };
  }

  /**
   * Plain create — used by the UI-driven `POST /contacts` endpoint.
   * The ingestion path continues to use `upsertByExternalKey` equivalents
   * so dedupe logic stays out of the hand-entry path.
   */
  async create(tx: Tx, tenantId: string, input: ContactCreateInput): Promise<Contact> {
    const [row] = await tx
      .insert(contacts)
      .values({
        id: input.id,
        tenantId,
        orgId: input.orgId,
        fullName: input.fullName,
        title: input.title ?? null,
        emails: input.emails ?? [],
        phones: input.phones ?? [],
        externalKeys: {},
        fieldConfidence: {},
        status: "active",
        timezone: input.timezone ?? null,
      })
      .returning();
    if (!row) throw new Error("contact insert returned no row");
    return row;
  }

  async findByEmail(tx: Tx, email: string): Promise<Contact | null> {
    const rows = await tx.select().from(contacts);
    const lower = email.toLowerCase();
    return (
      rows.find((row) =>
        row.emails.some((e) => typeof e === "string" && e.toLowerCase() === lower),
      ) ?? null
    );
  }

  async findByOrgId(tx: Tx, orgId: string): Promise<Contact[]> {
    return tx.select().from(contacts).where(eq(contacts.orgId, orgId));
  }

  /**
   * Authoritative lookup for a contact's primary org. Reads from the
   * m:n \`contact_org_memberships\` table (where \`is_primary\` is the
   * one-at-a-time flag enforced by a partial unique index) and falls
   * back to the legacy \`contacts.org_id\` column when no membership
   * row exists — e.g. for contacts created before Sprint 14's
   * backfill or by an ingestion path that never wrote memberships.
   *
   * Readers that currently reach for \`contact.orgId\` directly should
   * migrate to this helper so we can eventually drop the column.
   */
  async getPrimaryOrgId(tx: Tx, contactId: string): Promise<string | null> {
    const [row] = await tx
      .select({ orgId: contactOrgMemberships.orgId })
      .from(contactOrgMemberships)
      .where(
        and(
          eq(contactOrgMemberships.contactId, contactId),
          eq(contactOrgMemberships.isPrimary, true),
        ),
      )
      .limit(1);
    if (row) return row.orgId;
    // Fallback: no membership row yet — read the legacy denormalised
    // column so callers never observe a null when a primary actually
    // exists. Once every writer routes through the memberships table
    // this fallback becomes unreachable and the column can be dropped.
    const contact = await this.findById(tx, contactId);
    return contact?.orgId ?? null;
  }

  /**
   * Mark a contact as opted out. Sprint 12 suppression-list primitive
   * consumed by the `checkSuppression` Temporal activity; the call
   * workflow refuses to dial once this is set. Idempotent — a second
   * call with the same reason overwrites the timestamp so the audit
   * trail on the `contact.opted_out` event reflects the latest action.
   */
  async setOptOut(tx: Tx, id: string, reason: string, at: Date = new Date()): Promise<Contact> {
    const [row] = await tx
      .update(contacts)
      .set({
        optOutAt: at,
        optOutReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, id))
      .returning();
    if (!row) throw new Error(`contact ${id} not found`);
    return row;
  }

  /**
   * Clear the opt-out flag. Gated behind a separate endpoint so it
   * leaves a distinct audit event from setOptOut.
   */
  async clearOptOut(tx: Tx, id: string): Promise<Contact> {
    const [row] = await tx
      .update(contacts)
      .set({
        optOutAt: null,
        optOutReason: null,
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, id))
      .returning();
    if (!row) throw new Error(`contact ${id} not found`);
    return row;
  }

  /**
   * List every contact in the tenant that currently has opt_out_at set.
   * Sorted by most recent opt-out first — the admin UI surfaces this as
   * a table so a reviewer can see recent additions at the top.
   */
  async listSuppressed(tx: Tx, limit = 200): Promise<Contact[]> {
    return tx
      .select()
      .from(contacts)
      .where(isNotNull(contacts.optOutAt))
      .orderBy(desc(contacts.optOutAt))
      .limit(limit);
  }

  /** Alphabetical list of active contacts for admin / picker UIs. */
  async listActive(tx: Tx, limit = 100): Promise<Contact[]> {
    return tx
      .select()
      .from(contacts)
      .where(eq(contacts.status, "active"))
      .orderBy(asc(contacts.fullName))
      .limit(limit);
  }

  /**
   * Sprint O — append a tag (no-op if it's already on the row). Uses
   * Postgres's jsonb `||` + a distinct-by-value filter so concurrent
   * writers can't produce duplicates.
   */
  async appendTag(tx: Tx, id: string, tag: string): Promise<Contact> {
    const [row] = await tx
      .update(contacts)
      .set({
        tags: sql`(SELECT jsonb_agg(DISTINCT t) FROM jsonb_array_elements_text(${contacts.tags} || ${JSON.stringify([tag])}::jsonb) AS t)`,
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, id))
      .returning();
    if (!row) throw new Error(`contact ${id} not found`);
    return row;
  }

  /** Sprint O — remove a tag (no-op if it isn't on the row). */
  async removeTag(tx: Tx, id: string, tag: string): Promise<Contact> {
    const [row] = await tx
      .update(contacts)
      .set({
        tags: sql`COALESCE((SELECT jsonb_agg(t) FROM jsonb_array_elements_text(${contacts.tags}) AS t WHERE t <> ${tag}), '[]'::jsonb)`,
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, id))
      .returning();
    if (!row) throw new Error(`contact ${id} not found`);
    return row;
  }
}

/**
 * Merge one contact into another. Repoints every FK referencing the
 * source (touchpoints, memberships, fuel_deals.buyer_contact_id,
 * leads, campaign_enrollments) to the target, unions the emails +
 * phones arrays, then archives the source (opt_out_at now,
 * opt_out_reason = "merged_into:<id>") so the row stays queryable but
 * won't be messaged again.
 *
 * Unique-index collisions on join tables are handled DELETE-first.
 * Caller runs inside {@link withTenant} so RLS is active and is
 * responsible for emitting the audit event.
 */
export async function mergeContactInto(
  tx: Tx,
  sourceId: string,
  targetId: string,
): Promise<{
  touchpoints: number;
  memberships: number;
  deals: number;
  leads: number;
  enrollments: number;
}> {
  if (sourceId === targetId) {
    throw new Error("cannot merge a contact into itself");
  }

  // touchpoints — no unique constraint, straight repoint.
  const tpRes = (await tx.execute(sql`
    update touchpoints set contact_id = ${targetId} where contact_id = ${sourceId}
  `)) as unknown as { rowCount?: number };

  // contact_org_memberships — PK is (contact_id, org_id). Drop source
  // rows that would collide with existing target rows before repointing.
  await tx.execute(sql`
    delete from contact_org_memberships
    where contact_id = ${sourceId}
      and org_id in (
        select org_id from contact_org_memberships where contact_id = ${targetId}
      )
  `);
  const memRes = (await tx.execute(sql`
    update contact_org_memberships set contact_id = ${targetId} where contact_id = ${sourceId}
  `)) as unknown as { rowCount?: number };

  // fuel_deals.buyer_contact_id — no uniqueness, straight repoint.
  const dealRes = (await tx.execute(sql`
    update fuel_deals set buyer_contact_id = ${targetId} where buyer_contact_id = ${sourceId}
  `)) as unknown as { rowCount?: number };

  // leads.contact_id — no unique constraint.
  const leadRes = (await tx.execute(sql`
    update leads set contact_id = ${targetId} where contact_id = ${sourceId}
  `)) as unknown as { rowCount?: number };

  // campaign_enrollments — unique (tenant_id, campaign_id, contact_id).
  // Drop source enrollments for campaigns that already have the target
  // enrolled, then repoint the rest.
  await tx.execute(sql`
    delete from campaign_enrollments
    where contact_id = ${sourceId}
      and campaign_id in (
        select campaign_id from campaign_enrollments where contact_id = ${targetId}
      )
  `);
  const enrRes = (await tx.execute(sql`
    update campaign_enrollments set contact_id = ${targetId} where contact_id = ${sourceId}
  `)) as unknown as { rowCount?: number };

  // Union emails + phones onto the target, dedup while preserving order.
  await tx.execute(sql`
    update contacts t
    set emails = coalesce((
          select jsonb_agg(distinct x order by x)
          from (
            select jsonb_array_elements_text(t.emails) as x
            union
            select jsonb_array_elements_text(s.emails) as x from contacts s where s.id = ${sourceId}
          ) u
        ), t.emails),
        phones = coalesce((
          select jsonb_agg(distinct x order by x)
          from (
            select jsonb_array_elements_text(t.phones) as x
            union
            select jsonb_array_elements_text(s.phones) as x from contacts s where s.id = ${sourceId}
          ) u
        ), t.phones),
        updated_at = now()
    where t.id = ${targetId}
  `);

  // Soft-archive the source. Keeps the row around for historical lookups
  // but flags it so Vex never re-messages it.
  await tx.execute(sql`
    update contacts
    set opt_out_at = coalesce(opt_out_at, now()),
        opt_out_reason = ${`merged_into:${targetId}`},
        status = 'archived',
        updated_at = now()
    where id = ${sourceId}
  `);

  return {
    touchpoints: tpRes.rowCount ?? 0,
    memberships: memRes.rowCount ?? 0,
    deals: dealRes.rowCount ?? 0,
    leads: leadRes.rowCount ?? 0,
    enrollments: enrRes.rowCount ?? 0,
  };
}
