import { and, asc, eq, lt, or, sql } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import { organizations, type Organization } from "../schema/organizations.js";
import type { FieldConfidenceEntry } from "../merge.js";

/**
 * Structured data for upsertByExternalKey. Fields map directly to
 * `organizations` columns; missing fields are left alone on update.
 */
export interface OrganizationUpsertData {
  legalName: string;
  domain?: string | null;
  industry?: string | null;
  sourceOfTruth?: string | null;
}

/**
 * Stateless. Every method takes a `tx` from {@link withTenant} so RLS
 * filters by `app.tenant_id`. Inserts also take an explicit `tenantId`
 * because RLS WITH CHECK requires the column to match the session value.
 */
export class OrganizationRepository {
  async findById(tx: Tx, id: string): Promise<Organization | null> {
    const [row] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, id))
      .limit(1);
    return row ?? null;
  }

  /**
   * Dedupe-at-create helper. Returns an existing org in this tenant
   * that matches either:
   *   - the normalized legal name (case-insensitive, trimmed, stripped
   *     of legal-entity suffixes like "LLC", "Inc", "Corp"), OR
   *   - the normalized domain (case-insensitive, leading "www." stripped).
   *
   * Both are checked so "Vector Trade Capital LLC" doesn't land as a
   * second row next to "Vector Trade Capital", and a new org with a
   * different name but the same domain still collides. The lookup is
   * in the tenant's tx, so RLS scopes it automatically.
   */
  async findByNormalizedIdentity(
    tx: Tx,
    legalName: string,
    domain: string | null,
  ): Promise<Organization | null> {
    const normName = normalizeLegalName(legalName);
    const normDomain = domain ? normalizeDomain(domain) : null;
    const predicates = [
      sql`${sql.raw(
        normalizeLegalNameSql("legal_name"),
      )} = ${normName}`,
    ];
    if (normDomain) {
      predicates.push(
        sql`${sql.raw(normalizeDomainSql("domain"))} = ${normDomain}`,
      );
    }
    const [row] = await tx
      .select()
      .from(organizations)
      .where(or(...predicates))
      .limit(1);
    return row ?? null;
  }

  /**
   * Dedupe-aware create. Runs the normalized-identity lookup first and
   * returns a tagged result so the caller chooses how to react (409 on
   * the direct API path; mark-applied + replay event on the approval
   * executor). Unifies Pass B's dedupe with the approval write path.
   */
  async createWithDedupeCheck(
    tx: Tx,
    tenantId: string,
    input: {
      id: string;
      legalName: string;
      domain?: string | null;
      industry?: string | null;
    },
  ): Promise<
    | { kind: "created"; organization: Organization }
    | { kind: "duplicate"; organization: Organization }
  > {
    const existing = await this.findByNormalizedIdentity(
      tx,
      input.legalName,
      input.domain ?? null,
    );
    if (existing) {
      return { kind: "duplicate", organization: existing };
    }
    const organization = await this.create(tx, tenantId, input);
    return { kind: "created", organization };
  }

  /**
   * Plain create — used by the UI-driven `POST /organizations` endpoint.
   * Distinct from `upsertByExternalKey` because hand-entered companies
   * don't have a source-system key to dedupe against.
   */
  async create(
    tx: Tx,
    tenantId: string,
    input: {
      id: string;
      legalName: string;
      domain?: string | null;
      industry?: string | null;
    },
  ): Promise<Organization> {
    const [row] = await tx
      .insert(organizations)
      .values({
        id: input.id,
        tenantId,
        legalName: input.legalName,
        domain: input.domain ?? null,
        industry: input.industry ?? null,
        externalKeys: {},
        fieldConfidence: {},
        status: "active",
      })
      .returning();
    if (!row) throw new Error("organization insert returned no row");
    return row;
  }

  async findByExternalKey(
    tx: Tx,
    system: string,
    key: string,
  ): Promise<Organization | null> {
    const rows = await tx.select().from(organizations);
    return rows.find((row) => row.externalKeys[system] === key) ?? null;
  }

  async upsertByExternalKey(
    tx: Tx,
    tenantId: string,
    system: string,
    key: string,
    data: OrganizationUpsertData,
  ): Promise<Organization> {
    const existing = await this.findByExternalKey(tx, system, key);
    if (existing) {
      const [updated] = await tx
        .update(organizations)
        .set({
          legalName: data.legalName,
          domain: data.domain ?? existing.domain,
          industry: data.industry ?? existing.industry,
          sourceOfTruth: data.sourceOfTruth ?? existing.sourceOfTruth,
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, existing.id))
        .returning();
      if (!updated) throw new Error(`organization ${existing.id} vanished during update`);
      return updated;
    }

    const [inserted] = await tx
      .insert(organizations)
      .values({
        id: createId(),
        tenantId,
        legalName: data.legalName,
        domain: data.domain ?? null,
        industry: data.industry ?? null,
        sourceOfTruth: data.sourceOfTruth ?? null,
        externalKeys: { [system]: key },
        fieldConfidence: {},
      })
      .returning();
    if (!inserted) throw new Error("organization insert returned no row");
    return inserted;
  }

  async updateFieldConfidence(
    tx: Tx,
    id: string,
    fieldName: string,
    value: unknown,
    source: string,
    confidence: number,
  ): Promise<void> {
    const existing = await this.findById(tx, id);
    if (!existing) throw new Error(`organization ${id} not found`);
    const entry: FieldConfidenceEntry = {
      value,
      source,
      confidence,
      updated_at: new Date().toISOString(),
    };
    await tx
      .update(organizations)
      .set({
        fieldConfidence: { ...existing.fieldConfidence, [fieldName]: entry },
        updatedAt: new Date(),
      })
      .where(and(eq(organizations.id, id)));
  }

  /**
   * Active orgs that haven't been "researched" recently — used by the
   * AgentScanner to fan out ResearchAgent jobs. "Researched" is inferred
   * from `updated_at` (Sprint 7 will switch to a per-org last_research_at
   * column once we have it). Returns at most `limit` rows.
   */
  async listResearchCandidates(
    tx: Tx,
    olderThan: Date,
    limit = 10,
  ): Promise<Organization[]> {
    return tx
      .select()
      .from(organizations)
      .where(
        and(
          eq(organizations.status, "active"),
          or(lt(organizations.updatedAt, olderThan), sql`true`),
        ),
      )
      .orderBy(asc(organizations.updatedAt))
      .limit(limit);
  }

  /**
   * Sprint O — append a tag (no-op if it's already on the row). The
   * distinct filter guards against concurrent writers adding the
   * same tag twice.
   */
  async appendTag(tx: Tx, id: string, tag: string): Promise<Organization> {
    const [row] = await tx
      .update(organizations)
      .set({
        tags: sql`(SELECT jsonb_agg(DISTINCT t) FROM jsonb_array_elements_text(${organizations.tags} || ${JSON.stringify([tag])}::jsonb) AS t)`,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, id))
      .returning();
    if (!row) throw new Error(`organization ${id} not found`);
    return row;
  }

  /** Sprint O — remove a tag (no-op if it isn't on the row). */
  async removeTag(tx: Tx, id: string, tag: string): Promise<Organization> {
    const [row] = await tx
      .update(organizations)
      .set({
        tags: sql`COALESCE((SELECT jsonb_agg(t) FROM jsonb_array_elements_text(${organizations.tags}) AS t WHERE t <> ${tag}), '[]'::jsonb)`,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, id))
      .returning();
    if (!row) throw new Error(`organization ${id} not found`);
    return row;
  }
}

// ---------------------------------------------------------------------------
// Normalization helpers for dedupe lookups. Shared between application code
// (findByNormalizedIdentity above) and the inline SQL that projects the
// table column into the same normalized shape so the comparison happens in
// one expression.
// ---------------------------------------------------------------------------

// Whitespace-before-suffix. MUST stay in lockstep with the SQL
// normalizer (normalizeLegalNameSql) which uses \s+ too — a prior
// \b form stripped suffixes on punctuation boundaries in JS but
// not in SQL, so "Acme-LLC" produced "acme-" client-side vs
// "acme-llc" in the WHERE clause and the dedupe lookup missed.
const LEGAL_SUFFIX_RE = /\s+(llc|l\.l\.c|inc|incorporated|corp|corporation|co|ltd|limited|plc|gmbh|ag|sa|bv|spa)\.?$/i;

export function normalizeLegalName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[,.]/g, "")
    .replace(/\s+/g, " ")
    .replace(LEGAL_SUFFIX_RE, "")
    .trim();
}

export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^www\./, "");
}

/**
 * Merge one organization into another. Repoints every FK reference from
 * `sourceId` to `targetId`, then archives the source with a
 * `merged_into` external key so future lookups can resolve the old id.
 * Unique-index collisions on join tables are handled with DELETE-first
 * dedupe (keeps the target's row, drops the source's duplicate).
 *
 * Returns the counts of rows touched per table so the UI can show a
 * summary. Caller is responsible for emitting the audit event and for
 * running inside {@link withTenant} so RLS is active.
 */
export async function mergeOrganizationInto(
  tx: Tx,
  sourceId: string,
  targetId: string,
): Promise<{
  deals: number;
  contacts: number;
  memberships: number;
  products: number;
  relationships: number;
}> {
  if (sourceId === targetId) {
    throw new Error("cannot merge an organization into itself");
  }

  // Deals — four FKs: buyer, seller, buy-side broker, sell-side broker.
  // Column names are compile-time constants; ids flow as parameters so
  // this is safe from injection.
  let dealsTouched = 0;
  const buyerRes = (await tx.execute(sql`
    update fuel_deals set buyer_org_id = ${targetId} where buyer_org_id = ${sourceId}
  `)) as unknown as { rowCount?: number };
  dealsTouched += buyerRes.rowCount ?? 0;
  const sellerRes = (await tx.execute(sql`
    update fuel_deals set seller_org_id = ${targetId} where seller_org_id = ${sourceId}
  `)) as unknown as { rowCount?: number };
  dealsTouched += sellerRes.rowCount ?? 0;
  const buyBrokerRes = (await tx.execute(sql`
    update fuel_deals set buy_side_broker_org_id = ${targetId} where buy_side_broker_org_id = ${sourceId}
  `)) as unknown as { rowCount?: number };
  dealsTouched += buyBrokerRes.rowCount ?? 0;
  const sellBrokerRes = (await tx.execute(sql`
    update fuel_deals set sell_side_broker_org_id = ${targetId} where sell_side_broker_org_id = ${sourceId}
  `)) as unknown as { rowCount?: number };
  dealsTouched += sellBrokerRes.rowCount ?? 0;

  // contacts.org_id
  const contactRes = (await tx.execute(sql`
    update contacts set org_id = ${targetId} where org_id = ${sourceId}
  `)) as unknown as { rowCount?: number };

  // contact_org_memberships — drop source rows where the contact already
  // has a target membership, then repoint the rest.
  await tx.execute(sql`
    delete from contact_org_memberships
    where org_id = ${sourceId}
      and contact_id in (
        select contact_id from contact_org_memberships where org_id = ${targetId}
      )
  `);
  const membershipRes = (await tx.execute(sql`
    update contact_org_memberships set org_id = ${targetId} where org_id = ${sourceId}
  `)) as unknown as { rowCount?: number };

  // organization_products — dedup + repoint.
  await tx.execute(sql`
    delete from organization_products
    where org_id = ${sourceId}
      and product in (
        select product from organization_products where org_id = ${targetId}
      )
  `);
  const productRes = (await tx.execute(sql`
    update organization_products set org_id = ${targetId} where org_id = ${sourceId}
  `)) as unknown as { rowCount?: number };

  // organization_relationships — dedup both directions, drop any
  // self-edges produced by the merge, then repoint.
  await tx.execute(sql`
    delete from organization_relationships
    where (from_org_id = ${sourceId} and to_org_id = ${targetId})
       or (from_org_id = ${targetId} and to_org_id = ${sourceId})
  `);
  const relRes = (await tx.execute(sql`
    update organization_relationships
    set from_org_id = case when from_org_id = ${sourceId} then ${targetId} else from_org_id end,
        to_org_id   = case when to_org_id   = ${sourceId} then ${targetId} else to_org_id   end
    where from_org_id = ${sourceId} or to_org_id = ${sourceId}
  `)) as unknown as { rowCount?: number };

  // Archive source + record the merge pointer. Keeps historical event
  // rows addressable via the old id if any survived outside FKs.
  await tx.execute(sql`
    update organizations
    set status = 'archived',
        external_keys = coalesce(external_keys, '{}'::jsonb) || jsonb_build_object('merged_into', ${targetId}::text),
        updated_at = now()
    where id = ${sourceId}
  `);

  return {
    deals: dealsTouched,
    contacts: contactRes.rowCount ?? 0,
    memberships: membershipRes.rowCount ?? 0,
    products: productRes.rowCount ?? 0,
    relationships: relRes.rowCount ?? 0,
  };
}

/**
 * SQL-side normalization for a legal-name column. Must stay in lockstep
 * with the JS side above. Keeps the lookup in a single WHERE clause
 * instead of pulling every row into the node process.
 */
function normalizeLegalNameSql(col: string): string {
  return `regexp_replace(
    regexp_replace(
      regexp_replace(lower(trim(${col})), '[,.]', '', 'g'),
      '\\s+', ' ', 'g'
    ),
    '\\s+(llc|l\\.l\\.c|inc|incorporated|corp|corporation|co|ltd|limited|plc|gmbh|ag|sa|bv|spa)\\.?$',
    '',
    'i'
  )`;
}

function normalizeDomainSql(col: string): string {
  return `regexp_replace(lower(trim(${col})), '^www\\.', '', 'i')`;
}
