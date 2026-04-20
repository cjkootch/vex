import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { withTenant, type Db, schema } from "@vex/db";
import { LEADS_DB_CLIENT } from "./tokens.js";

export interface HotLeadRow {
  event_id: string;
  occurred_at: string;
  lead_id: string;
  lead_stage: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_emails: string[];
  org_id: string | null;
  org_name: string | null;
  buying_intent: string | null;
  urgency: string | null;
  product: string | null;
  volume: string | null;
  destination: string | null;
  timeline: string | null;
  summary: string | null;
  source: string | null;
}

/**
 * Sprint S.2 — surface qualified leads that tripped the hot signal
 * (buying_intent=intent_to_buy or urgency=immediate) so the Brief
 * page can nudge the operator.
 *
 * Source of truth is the `events` table. The LeadQualificationAgent
 * emits one `lead.hot` row with the qualification payload in
 * `metadata`. We dedup by lead_id at read time — a lead that hits
 * the signal twice (e.g. re-run after more chat) should appear once,
 * with the freshest event.
 */
@Injectable()
export class LeadsService {
  constructor(@Inject(LEADS_DB_CLIENT) private readonly db: Db) {}

  async listHotLeads(
    tenantId: string,
    since: Date,
    limit = 10,
  ): Promise<HotLeadRow[]> {
    return withTenant(this.db, tenantId, async (tx) => {
      // Pull events first, ordered newest-first, then hand-assemble
      // the joined shape. Keeps the drizzle surface small and
      // sidesteps an aggregate-JOIN that would need a distinct_on.
      const eventRows = await tx
        .select({
          id: schema.events.id,
          subjectId: schema.events.subjectId,
          occurredAt: schema.events.occurredAt,
          metadata: schema.events.metadata,
        })
        .from(schema.events)
        .where(
          and(
            eq(schema.events.verb, "lead.hot"),
            gte(schema.events.occurredAt, since),
          ),
        )
        .orderBy(desc(schema.events.occurredAt))
        .limit(limit * 4); // overfetch so dedup by lead_id can still return `limit`

      const seenLeadIds = new Set<string>();
      const leadIdsInOrder: string[] = [];
      const eventByLeadId = new Map<
        string,
        (typeof eventRows)[number]
      >();
      for (const row of eventRows) {
        if (!row.subjectId) continue;
        if (seenLeadIds.has(row.subjectId)) continue;
        seenLeadIds.add(row.subjectId);
        leadIdsInOrder.push(row.subjectId);
        eventByLeadId.set(row.subjectId, row);
        if (leadIdsInOrder.length >= limit) break;
      }
      if (leadIdsInOrder.length === 0) return [];

      const leadRows = await tx
        .select({
          id: schema.leads.id,
          stage: schema.leads.stage,
          contactId: schema.leads.contactId,
          orgId: schema.leads.orgId,
        })
        .from(schema.leads)
        .where(sql`${schema.leads.id} IN (${sql.join(leadIdsInOrder.map((id) => sql`${id}`), sql`, `)})`);

      const leadById = new Map(leadRows.map((r) => [r.id, r] as const));

      const contactIds = leadRows
        .map((r) => r.contactId)
        .filter((v): v is string => !!v);
      const contactsById = new Map<
        string,
        { id: string; fullName: string; emails: string[] }
      >();
      if (contactIds.length > 0) {
        const contactRows = await tx
          .select({
            id: schema.contacts.id,
            fullName: schema.contacts.fullName,
            emails: schema.contacts.emails,
          })
          .from(schema.contacts)
          .where(
            sql`${schema.contacts.id} IN (${sql.join(contactIds.map((id) => sql`${id}`), sql`, `)})`,
          );
        for (const c of contactRows) contactsById.set(c.id, c);
      }

      const orgIds = leadRows
        .map((r) => r.orgId)
        .filter((v): v is string => !!v);
      const orgsById = new Map<string, { id: string; legalName: string }>();
      if (orgIds.length > 0) {
        const orgRows = await tx
          .select({
            id: schema.organizations.id,
            legalName: schema.organizations.legalName,
          })
          .from(schema.organizations)
          .where(
            sql`${schema.organizations.id} IN (${sql.join(orgIds.map((id) => sql`${id}`), sql`, `)})`,
          );
        for (const o of orgRows) orgsById.set(o.id, o);
      }

      const out: HotLeadRow[] = [];
      for (const leadId of leadIdsInOrder) {
        const event = eventByLeadId.get(leadId);
        const lead = leadById.get(leadId);
        if (!event || !lead) continue;
        const contact = lead.contactId ? contactsById.get(lead.contactId) : undefined;
        const org = lead.orgId ? orgsById.get(lead.orgId) : undefined;
        const md = (event.metadata ?? {}) as Record<string, unknown>;
        out.push({
          event_id: event.id,
          occurred_at: event.occurredAt.toISOString(),
          lead_id: lead.id,
          lead_stage: lead.stage ?? null,
          contact_id: contact?.id ?? null,
          contact_name: contact?.fullName ?? null,
          contact_emails: contact?.emails ?? [],
          org_id: org?.id ?? null,
          org_name: org?.legalName ?? null,
          buying_intent: stringOrNull(md["buying_intent"]),
          urgency: stringOrNull(md["urgency"]),
          product: stringOrNull(md["product"]),
          volume: stringOrNull(md["volume"]),
          destination: stringOrNull(md["destination"]),
          timeline: stringOrNull(md["timeline"]),
          summary: stringOrNull(md["summary"]),
          source: stringOrNull(md["source"]),
        });
      }
      return out;
    });
  }
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
