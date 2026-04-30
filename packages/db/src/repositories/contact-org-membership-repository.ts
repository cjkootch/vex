import { and, desc, eq, sql } from "drizzle-orm";
import type { Tx } from "../client.js";
import {
  contactOrgMemberships,
  type ContactOrgMembership,
} from "../schema/contact-org-memberships.js";

export interface MembershipCreateInput {
  contactId: string;
  orgId: string;
  role?: string | null;
  isPrimary?: boolean;
}

/**
 * Stateless repo for `contact_org_memberships`. All methods take a
 * `Tx` from `withTenant` so RLS scopes every read/write.
 *
 * Primary-flag contract: exactly one row per contact may have
 * `is_primary = true`. Enforced by the partial unique index shipped
 * with migration 0003. `setPrimary(...)` clears the flag on every
 * other row for the contact before it stamps the chosen one, so the
 * caller never has to manage the invariant manually.
 */
export class ContactOrgMembershipRepository {
  async create(
    tx: Tx,
    tenantId: string,
    input: MembershipCreateInput,
  ): Promise<ContactOrgMembership> {
    const [row] = await tx
      .insert(contactOrgMemberships)
      .values({
        tenantId,
        contactId: input.contactId,
        orgId: input.orgId,
        role: input.role ?? null,
        isPrimary: input.isPrimary ?? false,
      })
      .returning();
    if (!row) throw new Error("membership insert returned no row");
    return row;
  }

  /**
   * Idempotent upsert keyed on the (contact_id, org_id) primary key.
   * Returns the existing row when the membership already exists, the
   * newly-inserted row otherwise. Used by the procur ingest path so
   * pushing a contact alongside its company always lands a membership
   * row — even when the contact was dedupe-matched to an existing
   * one. Without this, contacts pushed alongside their company
   * never appeared on the org's contacts list (the org detail page
   * reads through this m:n table, not `contacts.org_id`).
   *
   * `isPrimary` is honoured ONLY when inserting a new row. Existing
   * memberships keep their flag — we don't surprise an operator who
   * already curated which org is primary for a contact.
   */
  async ensureMembership(
    tx: Tx,
    tenantId: string,
    input: MembershipCreateInput,
  ): Promise<ContactOrgMembership> {
    await tx
      .insert(contactOrgMemberships)
      .values({
        tenantId,
        contactId: input.contactId,
        orgId: input.orgId,
        role: input.role ?? null,
        isPrimary: input.isPrimary ?? false,
      })
      .onConflictDoNothing({
        target: [contactOrgMemberships.contactId, contactOrgMemberships.orgId],
      });
    const [row] = await tx
      .select()
      .from(contactOrgMemberships)
      .where(
        and(
          eq(contactOrgMemberships.contactId, input.contactId),
          eq(contactOrgMemberships.orgId, input.orgId),
        ),
      )
      .limit(1);
    if (!row) throw new Error("ensureMembership returned no row");
    return row;
  }

  async listByContact(tx: Tx, contactId: string): Promise<ContactOrgMembership[]> {
    return tx
      .select()
      .from(contactOrgMemberships)
      .where(eq(contactOrgMemberships.contactId, contactId))
      .orderBy(desc(contactOrgMemberships.isPrimary));
  }

  async listByOrg(tx: Tx, orgId: string): Promise<ContactOrgMembership[]> {
    return tx
      .select()
      .from(contactOrgMemberships)
      .where(eq(contactOrgMemberships.orgId, orgId))
      .orderBy(desc(contactOrgMemberships.isPrimary));
  }

  /** Bulk read by contact-id set — used by the contacts list view. */
  async listByContactIds(
    tx: Tx,
    contactIds: string[],
  ): Promise<ContactOrgMembership[]> {
    if (contactIds.length === 0) return [];
    return tx
      .select()
      .from(contactOrgMemberships)
      .where(
        sql`${contactOrgMemberships.contactId} IN (${sql.join(
          contactIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
  }

  async remove(tx: Tx, contactId: string, orgId: string): Promise<void> {
    await tx
      .delete(contactOrgMemberships)
      .where(
        and(
          eq(contactOrgMemberships.contactId, contactId),
          eq(contactOrgMemberships.orgId, orgId),
        ),
      );
  }

  /**
   * Atomically set a new primary org for a contact. Clears the flag
   * on every other membership first so the partial unique index never
   * fires mid-transaction, then stamps the chosen membership as
   * primary. Returns the updated row.
   */
  async setPrimary(
    tx: Tx,
    contactId: string,
    orgId: string,
  ): Promise<ContactOrgMembership> {
    await tx
      .update(contactOrgMemberships)
      .set({ isPrimary: false, updatedAt: new Date() })
      .where(
        and(
          eq(contactOrgMemberships.contactId, contactId),
          eq(contactOrgMemberships.isPrimary, true),
        ),
      );
    const [row] = await tx
      .update(contactOrgMemberships)
      .set({ isPrimary: true, updatedAt: new Date() })
      .where(
        and(
          eq(contactOrgMemberships.contactId, contactId),
          eq(contactOrgMemberships.orgId, orgId),
        ),
      )
      .returning();
    if (!row)
      throw new Error(`membership ${contactId}:${orgId} not found`);
    return row;
  }
}
