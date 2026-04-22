import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Tx } from "../client.js";
import { contacts, type Contact } from "../schema/contacts.js";
import { contactOrgMemberships } from "../schema/contact-org-memberships.js";
import { touchpoints } from "../schema/touchpoints.js";
import { leads } from "../schema/leads.js";

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
   * Dedupe-aware create. Walks the supplied identifiers in order of
   * strongest to weakest signal:
   *   1. Email exact match (case-insensitive)
   *   2. Phone exact match (E.164-normalized)
   *   3. Full-name match (trimmed, case-insensitive) scoped to the
   *      same primary org — a real dupe for "John Smith" only matters
   *      when two rows are claiming membership in the same counterparty.
   *
   * First hit wins. Returns a tagged result so callers decide whether
   * to throw (direct API path) or mark-applied + emit a replay event
   * (approval executor). Sprint 7 shipped email-only; broadened here
   * because changing-email contacts and phone-first contacts were
   * producing duplicate rows that had to be merged by hand.
   */
  async createWithDedupeCheck(
    tx: Tx,
    tenantId: string,
    input: ContactCreateInput,
  ): Promise<
    | { kind: "created"; contact: Contact }
    | {
        kind: "duplicate";
        contact: Contact;
        reason: "email" | "phone" | "name_and_org";
        matchedValue: string;
      }
  > {
    for (const email of input.emails ?? []) {
      const duplicate = await this.findByEmail(tx, email);
      if (duplicate) {
        return {
          kind: "duplicate",
          contact: duplicate,
          reason: "email",
          matchedValue: email,
        };
      }
    }
    for (const phone of input.phones ?? []) {
      const normalized = normalizePhone(phone);
      if (!normalized) continue;
      const duplicate = await this.findByPhone(tx, normalized);
      if (duplicate) {
        return {
          kind: "duplicate",
          contact: duplicate,
          reason: "phone",
          matchedValue: normalized,
        };
      }
    }
    if (input.fullName && input.orgId) {
      const duplicate = await this.findByNameAndOrg(
        tx,
        input.fullName,
        input.orgId,
      );
      if (duplicate) {
        return {
          kind: "duplicate",
          contact: duplicate,
          reason: "name_and_org",
          matchedValue: `${input.fullName}@${input.orgId}`,
        };
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

  /**
   * Email match via SQL-side JSONB containment. Backed by the
   * `contacts_emails_gin_idx` GIN index (migration 0021) so the
   * lookup is O(log n) instead of the N-row scan the old in-memory
   * filter had to do.
   *
   * Case-insensitivity is enforced by lower-casing on both sides:
   * every stored value goes through `LOWER()` inside the containment
   * check, and the input is lower-cased before the JSONB literal is
   * built.
   */
  async findByEmail(tx: Tx, email: string): Promise<Contact | null> {
    const lower = email.trim().toLowerCase();
    if (!lower) return null;
    const [row] = await tx
      .select()
      .from(contacts)
      .where(
        sql`(
          SELECT bool_or(lower(v.value) = ${lower})
          FROM jsonb_array_elements_text(${contacts.emails}) AS v(value)
        )`,
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Phone match via SQL-side JSONB containment. The input should be
   * E.164-normalized (use `normalizePhone` below) — stored phones
   * are expected to match the E.164 shape, and normalizing both
   * sides means `+1 (832) 492-7169` collides with `+18324927169`.
   */
  async findByPhone(tx: Tx, phoneE164: string): Promise<Contact | null> {
    const normalized = normalizePhone(phoneE164);
    if (!normalized) return null;
    // Normalize both sides: strip every non-digit-or-plus from each
    // stored value, then compare. That absorbs legacy rows that
    // stored the original formatting.
    const [row] = await tx
      .select()
      .from(contacts)
      .where(
        sql`(
          SELECT bool_or(regexp_replace(v.value, '[^0-9+]', '', 'g') = ${normalized})
          FROM jsonb_array_elements_text(${contacts.phones}) AS v(value)
        )`,
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Case-insensitive full-name match scoped to an org. Last-resort
   * dedupe signal: two "John Smith" rows are only really the same
   * person when they're both associated with the same counterparty.
   */
  async findByNameAndOrg(
    tx: Tx,
    fullName: string,
    orgId: string,
  ): Promise<Contact | null> {
    const normalized = fullName.trim().toLowerCase();
    if (!normalized) return null;
    const [row] = await tx
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.orgId, orgId),
          sql`lower(trim(${contacts.fullName})) = ${normalized}`,
        ),
      )
      .limit(1);
    return row ?? null;
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
   * Batch set `status` on a list of contacts. Used by the bulk-archive
   * flow — operator selects N rows on `/app/contacts`, confirms, every
   * row flips to `status='archived'` and vanishes from the active
   * list. Returns the rows actually updated so the caller knows the
   * effective count (some ids may have been invisible to the tenant
   * or already at the target status — both collapse to "no row
   * touched" and drop out of the result).
   *
   * Kept single-SQL (one UPDATE with WHERE id IN (...)) so a 200-row
   * archive is one round-trip, not N.
   */
  async updateStatusByIds(
    tx: Tx,
    ids: readonly string[],
    status: "active" | "inactive" | "archived",
  ): Promise<Contact[]> {
    if (ids.length === 0) return [];
    return tx
      .update(contacts)
      .set({ status, updatedAt: new Date() })
      .where(
        sql`${contacts.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`,
      )
      .returning();
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

  /**
   * Patch an existing contact. Caller supplies a partial Contact —
   * only fields present on the object get written. `null` in a
   * nullable field (title, timezone) clears it; `undefined` leaves
   * the existing value alone. Arrays (emails / phones / tags) are
   * full replacements, NOT appends.
   *
   * Throws if the contact doesn't exist — the executor turns that
   * into a clean approval.executor.failed audit event.
   */
  async updatePatch(
    tx: Tx,
    id: string,
    patch: {
      fullName?: string;
      title?: string | null;
      emails?: string[];
      phones?: string[];
      timezone?: string | null;
      tags?: string[];
    },
  ): Promise<Contact> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.fullName !== undefined) set["fullName"] = patch.fullName;
    if (patch.title !== undefined) set["title"] = patch.title;
    if (patch.emails !== undefined) set["emails"] = patch.emails;
    if (patch.phones !== undefined) set["phones"] = patch.phones;
    if (patch.timezone !== undefined) set["timezone"] = patch.timezone;
    if (patch.tags !== undefined) set["tags"] = patch.tags;
    const [row] = await tx
      .update(contacts)
      .set(set)
      .where(eq(contacts.id, id))
      .returning();
    if (!row) throw new Error(`contact ${id} not found`);
    return row;
  }

  /**
   * Merge `sourceId` into `targetId`. Inside one transaction:
   *   1. Move FK-owning rows (touchpoints, activities, leads) from
   *      source → target so the target's timeline inherits the
   *      source's history.
   *   2. Move contact_org_memberships — with ON CONFLICT DO NOTHING
   *      so the target keeps its memberships when the source was
   *      already a member of the same org.
   *   3. Union emails + phones on the target (de-duped, case-
   *      insensitive for emails).
   *   4. Mark the source `status='archived'` +
   *      `merged_into_contact_id=target` so /app/contacts and chat
   *      retrieval can hop to the canonical row.
   *
   * Idempotent: if `sourceId` is already merged into the same target,
   * returns without re-running. Throws if either contact is missing
   * or if the source is merged into a DIFFERENT target (operator
   * must un-merge first — not wired yet).
   */
  async mergeInto(
    tx: Tx,
    sourceId: string,
    targetId: string,
  ): Promise<{ target: Contact; source: Contact }> {
    if (sourceId === targetId) {
      throw new Error("merge source and target are the same contact");
    }
    const source = await this.findById(tx, sourceId);
    if (!source) throw new Error(`contact ${sourceId} (source) not found`);
    const target = await this.findById(tx, targetId);
    if (!target) throw new Error(`contact ${targetId} (target) not found`);

    if (source.mergedIntoContactId === targetId) {
      // Already merged — idempotent no-op.
      return { target, source };
    }
    if (source.mergedIntoContactId && source.mergedIntoContactId !== targetId) {
      throw new Error(
        `contact ${sourceId} already merged into ${source.mergedIntoContactId}; un-merge first`,
      );
    }

    // 1. Re-point child rows. Activities don't have a direct
    //    contact_id — they reference via relatedObjectIds JSONB — so
    //    the query path that renders a contact's activity timeline
    //    already falls back to a hop through touchpoints. Defer a
    //    JSONB rewrite for activities to a follow-up.
    await tx
      .update(touchpoints)
      .set({ contactId: targetId })
      .where(eq(touchpoints.contactId, sourceId));
    await tx
      .update(leads)
      .set({ contactId: targetId })
      .where(eq(leads.contactId, sourceId));

    // 2. Re-point memberships, skipping any (target, org) pair that
    //    already exists so we don't violate the unique constraint.
    await tx.execute(sql`
      UPDATE ${contactOrgMemberships}
      SET contact_id = ${targetId}
      WHERE contact_id = ${sourceId}
        AND NOT EXISTS (
          SELECT 1 FROM ${contactOrgMemberships} t
          WHERE t.contact_id = ${targetId}
            AND t.org_id = ${contactOrgMemberships.orgId}
        )
    `);
    // Anything left on the source is now a duplicate → delete.
    await tx
      .delete(contactOrgMemberships)
      .where(eq(contactOrgMemberships.contactId, sourceId));

    // 3. Union contact data onto the target.
    const mergedEmails = dedupeCaseInsensitive([
      ...(target.emails ?? []),
      ...(source.emails ?? []),
    ]);
    const mergedPhones = Array.from(
      new Set([...(target.phones ?? []), ...(source.phones ?? [])]),
    );
    const mergedTags = Array.from(
      new Set([...(target.tags ?? []), ...(source.tags ?? [])]),
    );
    const [updatedTarget] = await tx
      .update(contacts)
      .set({
        emails: mergedEmails,
        phones: mergedPhones,
        tags: mergedTags,
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, targetId))
      .returning();
    if (!updatedTarget) throw new Error(`contact ${targetId} vanished mid-merge`);

    // 4. Tombstone the source.
    const [updatedSource] = await tx
      .update(contacts)
      .set({
        status: "archived",
        mergedIntoContactId: targetId,
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, sourceId))
      .returning();
    if (!updatedSource) throw new Error(`contact ${sourceId} vanished mid-merge`);

    return { target: updatedTarget, source: updatedSource };
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

function dedupeCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * Reduce a phone string to its E.164-ish canonical form by stripping
 * every character that isn't a digit or a leading `+`. Returns null
 * when the result is too short to be a real number (fewer than 7
 * digits). Deliberately lenient — this is a dedupe helper, not a
 * validation helper; Zod schemas elsewhere enforce the stricter
 * `/^\+[1-9]\d{7,14}$/` on user-facing inputs.
 */
export function normalizePhone(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[^0-9+]/g, "");
  if (cleaned.replace(/\D/g, "").length < 7) return null;
  return cleaned;
}
