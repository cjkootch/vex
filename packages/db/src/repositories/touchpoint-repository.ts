import { and, desc, eq, gte, lt, or, sql, type SQL } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import { touchpoints, type Touchpoint } from "../schema/touchpoints.js";

export interface TouchpointInsert {
  channel: string;
  actor?: string | null;
  occurredAt: Date;
  campaignId?: string | null;
  leadId?: string | null;
  contactId?: string | null;
  orgId?: string | null;
  metadata?: Record<string, unknown>;
}

export class TouchpointRepository {
  async insert(tx: Tx, tenantId: string, data: TouchpointInsert): Promise<Touchpoint> {
    const [row] = await tx
      .insert(touchpoints)
      .values({
        id: createId(),
        tenantId,
        channel: data.channel,
        actor: data.actor ?? null,
        occurredAt: data.occurredAt,
        campaignId: data.campaignId ?? null,
        leadId: data.leadId ?? null,
        contactId: data.contactId ?? null,
        orgId: data.orgId ?? null,
        metadata: data.metadata ?? {},
      })
      .returning();
    if (!row) throw new Error("touchpoint insert returned no row");
    return row;
  }

  /** Touchpoints with `occurred_at >= since`. Used by DailyBriefAgent. */
  async listSince(tx: Tx, since: Date, limit = 200): Promise<Touchpoint[]> {
    return tx
      .select()
      .from(touchpoints)
      .where(gte(touchpoints.occurredAt, since))
      .orderBy(desc(touchpoints.occurredAt))
      .limit(limit);
  }

  /** Touchpoints for a specific org since `since`. Used by ResearchAgent. */
  async listForOrgSince(
    tx: Tx,
    orgId: string,
    since: Date,
    limit = 50,
  ): Promise<Touchpoint[]> {
    return tx
      .select()
      .from(touchpoints)
      .where(and(eq(touchpoints.orgId, orgId), gte(touchpoints.occurredAt, since)))
      .orderBy(desc(touchpoints.occurredAt))
      .limit(limit);
  }

  /**
   * Touchpoints for a specific contact since `since`. Used by the
   * Sprint D CampaignEnrollmentWorkflow to hydrate the gate-eval
   * signal cache at workflow start.
   */
  async listForContactSince(
    tx: Tx,
    contactId: string,
    since: Date,
    limit = 200,
  ): Promise<Touchpoint[]> {
    return tx
      .select()
      .from(touchpoints)
      .where(
        and(
          eq(touchpoints.contactId, contactId),
          gte(touchpoints.occurredAt, since),
        ),
      )
      .orderBy(desc(touchpoints.occurredAt))
      .limit(limit);
  }

  /**
   * Sprint E — inbound touchpoints the intent classifier hasn't
   * labelled yet. Restricted to `metadata.direction = 'inbound'` so
   * the classifier only burns tokens on things a contact actually
   * said. The `metadata.intent IS NULL` check is expressed via the
   * JSONB `->>` extract so Postgres uses the column index — not a
   * table scan.
   */
  async listUnclassifiedInbound(
    tx: Tx,
    since: Date,
    limit = 50,
  ): Promise<Touchpoint[]> {
    return tx
      .select()
      .from(touchpoints)
      .where(
        and(
          gte(touchpoints.occurredAt, since),
          sql`${touchpoints.metadata} ->> 'direction' = 'inbound'`,
          sql`(${touchpoints.metadata} ->> 'intent') IS NULL`,
        ),
      )
      .orderBy(desc(touchpoints.occurredAt))
      .limit(limit);
  }

  /**
   * Sprint E — write the classifier's label back onto a touchpoint's
   * metadata. Merges with existing metadata so we don't clobber the
   * normalizer's fields (verb, direction, provider_message_id, etc.).
   * Uses Postgres's `||` JSONB concat so concurrent writers don't
   * stomp on each other — the last write wins by key.
   */
  /**
   * Unified communications-log feed. Keyset-paginated descending by
   * `occurred_at`. Filters map to the shape the /app/inbox UI needs:
   *   - `channelGroups` — a list like `["email", "sms", "whatsapp"]`
   *     that the repo expands into `channel LIKE 'email.%'` etc.
   *     Empty/undefined → no channel filter.
   *   - `direction` — matches `metadata ->> 'direction'`.
   *   - `contactId`, `campaignId` — exact-match FKs.
   *   - `before` — keyset cursor. Only rows strictly earlier than this
   *     `occurred_at` are returned (for reliable "load more" without
   *     duplicate rows at ties since the caller filters client-side).
   */
  async listFeed(
    tx: Tx,
    filters: {
      channelGroups?: readonly string[];
      direction?: "inbound" | "outbound";
      contactId?: string;
      campaignId?: string;
      before?: Date;
    },
    limit = 50,
  ): Promise<Touchpoint[]> {
    const clauses: SQL[] = [];
    if (filters.channelGroups && filters.channelGroups.length > 0) {
      const perGroup = filters.channelGroups.map(
        (g) => sql`${touchpoints.channel} LIKE ${g + ".%"}`,
      );
      const combined = perGroup.reduce<SQL | undefined>(
        (acc, cur) => (acc ? or(acc, cur) : cur),
        undefined,
      );
      if (combined) clauses.push(combined);
    }
    if (filters.direction) {
      clauses.push(
        sql`${touchpoints.metadata} ->> 'direction' = ${filters.direction}`,
      );
    }
    if (filters.contactId) {
      clauses.push(eq(touchpoints.contactId, filters.contactId));
    }
    if (filters.campaignId) {
      clauses.push(eq(touchpoints.campaignId, filters.campaignId));
    }
    if (filters.before) {
      clauses.push(lt(touchpoints.occurredAt, filters.before));
    }
    const where = clauses.length > 0 ? and(...clauses) : undefined;
    const query = tx
      .select()
      .from(touchpoints)
      .orderBy(desc(touchpoints.occurredAt))
      .limit(limit);
    return where ? query.where(where) : query;
  }

  async markIntent(
    tx: Tx,
    id: string,
    intent: string,
    confidence: number,
    reason: string,
  ): Promise<void> {
    await tx
      .update(touchpoints)
      .set({
        metadata: sql`${touchpoints.metadata} || jsonb_build_object(
          'intent', ${intent}::text,
          'intent_confidence', ${confidence}::double precision,
          'intent_reason', ${reason}::text,
          'intent_classified_at', ${new Date().toISOString()}::text
        )`,
      })
      .where(eq(touchpoints.id, id));
  }
}
