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
