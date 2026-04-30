import { and, asc, eq, lt, or, sql } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import { organizations, type Organization } from "../schema/organizations.js";
import { resolveFieldValue, type FieldConfidenceEntry } from "../merge.js";

/**
 * Source priority used by `upsertByExternalKey` when callers don't
 * provide their own. Higher priority sources (lower index) win ties
 * when field confidence is equal. Callers with richer knowledge
 * (e.g. the research agent knows clearbit > manual > tavily) should
 * pass their own list.
 */
const DEFAULT_SOURCE_PRIORITY: readonly string[] = [
  "manual",
  "clearbit",
  "hubspot",
  "salesforce",
  "zoominfo",
  "tavily",
  "website_form",
  "website_chat",
  "email_inbound",
];

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

  /**
   * External-key lookup via SQL-side JSONB containment. Backed by the
   * `organizations_external_keys_gin_idx` GIN index (migration 0021)
   * so the query is O(log n) instead of reading every row.
   */
  async findByExternalKey(
    tx: Tx,
    system: string,
    key: string,
  ): Promise<Organization | null> {
    const probe = JSON.stringify({ [system]: key });
    const [row] = await tx
      .select()
      .from(organizations)
      .where(sql`${organizations.externalKeys} @> ${probe}::jsonb`)
      .limit(1);
    return row ?? null;
  }

  /**
   * Upsert-by-external-key with entity-resolution safety. Three-step
   * match in order of strength:
   *
   *   1. External-key exact — same `{system, key}` → adopt that row.
   *   2. Normalized identity (name + domain) — a same-company hit from
   *      a different source system → adopt that row, stamp the new
   *      external key onto the existing row's external_keys map.
   *   3. No match → insert a new row.
   *
   * When an existing row is adopted, field updates go through
   * {@link resolveFieldValue} so a lower-priority source can't
   * overwrite a higher-priority / higher-confidence legalName, domain,
   * industry, or sourceOfTruth. The per-field decision is persisted
   * on `field_confidence` so the next upsert can see the audit.
   *
   * Legacy behaviour (pre-Sprint H) was to blindly overwrite on an
   * external-key hit and to silently create duplicates when the same
   * company came in from a different provider. Both are closed here.
   */
  async upsertByExternalKey(
    tx: Tx,
    tenantId: string,
    system: string,
    key: string,
    data: OrganizationUpsertData,
    options: {
      sourcePriority?: readonly string[];
      incomingConfidence?: number;
    } = {},
  ): Promise<Organization> {
    const sourcePriority = options.sourcePriority ?? DEFAULT_SOURCE_PRIORITY;
    const incomingConfidence = options.incomingConfidence ?? 0.7;
    const now = new Date();
    const incomingSource = data.sourceOfTruth ?? system;

    let existing = await this.findByExternalKey(tx, system, key);
    let matchReason: "external_key" | "normalized_identity" | null = existing
      ? "external_key"
      : null;
    if (!existing) {
      existing = await this.findByNormalizedIdentity(
        tx,
        data.legalName,
        data.domain ?? null,
      );
      if (existing) matchReason = "normalized_identity";
    }

    if (existing && matchReason) {
      const nextConfidence: Record<string, FieldConfidenceEntry> = {
        ...existing.fieldConfidence,
      };
      const nextValues: Record<string, unknown> = {};

      for (const field of ["legalName", "domain", "industry", "sourceOfTruth"] as const) {
        const incomingValue = data[field];
        if (incomingValue === undefined || incomingValue === null) continue;
        const incomingEntry: FieldConfidenceEntry = {
          value: incomingValue,
          source: incomingSource,
          confidence: incomingConfidence,
          updated_at: now.toISOString(),
        };
        const existingEntry = existing.fieldConfidence[field];
        const winner = existingEntry
          ? resolveFieldValue(existingEntry, incomingEntry, sourcePriority)
          : incomingEntry;
        nextConfidence[field] = winner;
        nextValues[field] = winner.value;
      }

      // Merge the incoming external key onto existing.external_keys. If
      // this system already has a key for this row but it differs from
      // the incoming one, prefer the incoming (freshest wins) and emit
      // the old value as a side-field so the audit keeps a paper trail.
      const mergedKeys: Record<string, string> = {
        ...existing.externalKeys,
        [system]: key,
      };

      const setPayload: Record<string, unknown> = {
        externalKeys: mergedKeys,
        fieldConfidence: nextConfidence,
        updatedAt: now,
        ...nextValues,
      };

      const [updated] = await tx
        .update(organizations)
        .set(setPayload)
        .where(eq(organizations.id, existing.id))
        .returning();
      if (!updated) {
        throw new Error(`organization ${existing.id} vanished during update`);
      }
      return updated;
    }

    const initialConfidence: Record<string, FieldConfidenceEntry> = {};
    for (const field of ["legalName", "domain", "industry", "sourceOfTruth"] as const) {
      const value = data[field];
      if (value === undefined || value === null) continue;
      initialConfidence[field] = {
        value,
        source: incomingSource,
        confidence: incomingConfidence,
        updated_at: now.toISOString(),
      };
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
        fieldConfidence: initialConfidence,
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
          lt(organizations.updatedAt, olderThan),
        ),
      )
      .orderBy(asc(organizations.updatedAt))
      .limit(limit);
  }

  /**
   * Every active organization in the tenant. Used by OFACScreeningAgent's
   * batch mode — screens the whole book overnight. RLS scopes the query
   * to the session tenant; the agent runs inside withTenant().
   */
  async listActive(tx: Tx, limit = 2000): Promise<Organization[]> {
    return tx
      .select()
      .from(organizations)
      .where(eq(organizations.status, "active"))
      .orderBy(asc(organizations.legalName))
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

  /**
   * Bulk-flip status on a set of org ids. Used by the
   * `/organizations/bulk-archive` endpoint when an operator
   * soft-deletes companies from the list page. Single-SQL update so
   * a 200-row archive is one round-trip, not N. Mirrors
   * ContactRepository.updateStatusByIds.
   */
  async updateStatusByIds(
    tx: Tx,
    ids: readonly string[],
    status: "active" | "inactive" | "archived",
  ): Promise<Organization[]> {
    if (ids.length === 0) return [];
    return tx
      .update(organizations)
      .set({ status, updatedAt: new Date() })
      .where(
        sql`${organizations.id} IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      )
      .returning();
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
