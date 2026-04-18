import { asc, desc, eq, isNotNull } from "drizzle-orm";
import type { Tx } from "../client.js";
import { contacts, type Contact } from "../schema/contacts.js";

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
}
