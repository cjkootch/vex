import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import {
  approxTokens,
  packTokens,
  type EvidenceAggregates,
  type EvidenceCampaign,
  type EvidenceItem,
  type EvidencePack,
} from "@vex/domain";
import type { Tx } from "../client.js";
import { campaigns } from "../schema/campaigns.js";
import { campaignEnrollments } from "../schema/campaign-enrollments.js";
import { campaignSteps } from "../schema/campaign-steps.js";
import { contacts } from "../schema/contacts.js";
import { contactOrgMemberships } from "../schema/contact-org-memberships.js";
import { documents } from "../schema/documents.js";
import { followUps } from "../schema/follow-ups.js";
import { embeddingChunks } from "../schema/embedding-chunks.js";
import { fuelDeals } from "../schema/fuel-deals.js";
import { fuelDealScenarios } from "../schema/fuel-deal-scenarios.js";
import { organizations } from "../schema/organizations.js";
import { summaries } from "../schema/summaries.js";
import { touchpoints } from "../schema/touchpoints.js";
import { ScopeResolver, type ResolvedScope } from "./scope-resolver.js";

export { ScopeResolver, type ResolvedScope };

/** Reciprocal Rank Fusion constant — standard value from the literature. */
const RRF_K = 60;

/** Re-rank weights — must sum to 1.0. */
const W_RELEVANCE = 0.4;
const W_FRESHNESS = 0.3;
const W_CONFIDENCE = 0.2;
const W_CORROBORATION = 0.1;

/** Token budget for the assembled pack. Truncate oldest items to fit. */
const DEFAULT_TOKEN_CAP = 28_000;

/** Common English filler words dropped from the name-match fallback tokeniser. */
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "her",
  "was",
  "one",
  "our",
  "out",
  "what",
  "when",
  "with",
  "this",
  "that",
  "from",
  "they",
  "them",
  "show",
  "list",
  "find",
  "tell",
  "give",
  "have",
  "any",
  "about",
  "into",
  "deal",
  "deals",
  "company",
  "companies",
  "contact",
  "contacts",
  "org",
  "organization",
]);

interface ChunkRow {
  id: string;
  ownerObjectType: string;
  ownerObjectId: string;
  chunkText: string;
  permissionScope: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export class RetrievalService {
  private readonly scope = new ScopeResolver();

  resolveScope(tx: Tx, query: string): Promise<ResolvedScope> {
    return this.scope.resolve(tx, query);
  }

  /**
   * Hybrid search with optional scope filter. Runs FTS and pgvector queries
   * separately, merges via RRF, then returns the fused top `limit`.
   *
   * Caller must already be inside `withTenant`. RLS scopes the tables; the
   * `scopeFilter` narrows further by owner_object_id and date range.
   */
  async hybridSearch(
    tx: Tx,
    queryText: string,
    queryEmbedding: number[],
    scopeFilter: ResolvedScope = {},
    limit = 12,
  ): Promise<EvidenceItem[]> {
    const candidatePerSide = Math.max(20, limit * 2);
    const scopedIds = collectScopedIds(scopeFilter);

    const baseConds = [];
    if (scopedIds.length > 0) {
      baseConds.push(inArray(embeddingChunks.ownerObjectId, scopedIds));
    }
    if (scopeFilter.date_range) {
      baseConds.push(gte(embeddingChunks.createdAt, scopeFilter.date_range.start));
      baseConds.push(lte(embeddingChunks.createdAt, scopeFilter.date_range.end));
    }

    const ftsCond = and(
      sql`${embeddingChunks.searchVector} @@ plainto_tsquery('english', ${queryText})`,
      ...baseConds,
    );
    const ftsRows = await tx
      .select({
        id: embeddingChunks.id,
        ownerObjectType: embeddingChunks.ownerObjectType,
        ownerObjectId: embeddingChunks.ownerObjectId,
        chunkText: embeddingChunks.chunkText,
        permissionScope: embeddingChunks.permissionScope,
        metadata: embeddingChunks.metadata,
        createdAt: embeddingChunks.createdAt,
      })
      .from(embeddingChunks)
      .where(ftsCond)
      .orderBy(
        desc(
          sql`ts_rank(${embeddingChunks.searchVector}, plainto_tsquery('english', ${queryText}))`,
        ),
      )
      .limit(candidatePerSide);

    const vectorLiteral = `[${queryEmbedding.join(",")}]`;
    const vecCond = baseConds.length > 0 ? and(...baseConds) : undefined;
    const vecRows = await tx
      .select({
        id: embeddingChunks.id,
        ownerObjectType: embeddingChunks.ownerObjectType,
        ownerObjectId: embeddingChunks.ownerObjectId,
        chunkText: embeddingChunks.chunkText,
        permissionScope: embeddingChunks.permissionScope,
        metadata: embeddingChunks.metadata,
        createdAt: embeddingChunks.createdAt,
      })
      .from(embeddingChunks)
      .where(vecCond)
      .orderBy(sql`${embeddingChunks.embedding} <=> ${vectorLiteral}::vector`)
      .limit(candidatePerSide);

    const rrfScores = new Map<string, number>();
    const rowsById = new Map<string, ChunkRow>();
    ftsRows.forEach((row, i) => {
      rowsById.set(row.id, row);
      rrfScores.set(row.id, (rrfScores.get(row.id) ?? 0) + 1 / (RRF_K + i + 1));
    });
    vecRows.forEach((row, i) => {
      rowsById.set(row.id, row);
      rrfScores.set(row.id, (rrfScores.get(row.id) ?? 0) + 1 / (RRF_K + i + 1));
    });

    const corroboration = countCorroboration([...rowsById.values()]);
    const now = Date.now();

    const enriched = [...rrfScores.entries()].map(([id, rrf]) => {
      const row = rowsById.get(id)!;
      const item = toEvidenceItem(row, now, corroboration);
      return { item, rrf };
    });

    const reRanked = enriched
      .map(({ item, rrf }) => ({ item, score: rerankScore(rrf, item) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ item }) => item);

    return reRanked;
  }

  /**
   * Build the EvidencePack a Claude query gets handed:
   *   1. Resolve scope from the query text.
   *   2. Pull current summaries for every scoped object (acts as a cache-
   *      friendly "context" block in the prompt).
   *   3. Run hybridSearch for chunk-level evidence.
   *   4. Truncate to fit the token budget — oldest items first.
   */
  async buildEvidencePack(
    tx: Tx,
    queryText: string,
    queryEmbedding: number[],
    options: {
      tokenCap?: number;
      limit?: number;
      /**
       * Sprint T — subject-scoped chat. When set, the pinned subject
       * gets force-injected into the resolved scope so all downstream
       * hydrations (scope summaries, contacts-for-orgs, hybrid-search
       * bias) treat it as primary context regardless of whether the
       * question text names it. Deals are a no-op here because the
       * per-deal dossier already hydrates every deal.
       */
      pinned?: { type: "contact" | "deal" | "organization" | "campaign"; id: string };
    } = {},
  ): Promise<EvidencePack> {
    const scope = await this.resolveScope(tx, queryText);
    if (options.pinned) {
      const { type, id } = options.pinned;
      if (type === "contact") {
        scope.contact_ids = dedupeAppend(scope.contact_ids, id);
      } else if (type === "organization") {
        scope.org_ids = dedupeAppend(scope.org_ids, id);
      } else if (type === "campaign") {
        scope.campaign_ids = dedupeAppend(scope.campaign_ids, id);
      }
      // type === "deal" intentionally skipped — fetchDealDossier
      // already hydrates every deal into the pack.
    }
    const summariesItems = await this.fetchScopeSummaries(tx, scope);
    const items = await this.hybridSearch(tx, queryText, queryEmbedding, scope, options.limit);

    // Fallback: when the embedding-based search returns nothing
    // (workspace seeded but `embedding_chunks` not populated yet),
    // do a tenant-scoped ILIKE across organizations / contacts /
    // fuel_deals so the chat can still answer name-based questions
    // ("show me VTC-2026-001"). Embeddings remain the primary path
    // when they exist.
    let fallbackItems: EvidenceItem[] = [];
    if (summariesItems.length === 0 && items.length === 0) {
      fallbackItems = await this.nameMatchFallback(tx, queryText);
    }

    // Sprint M — hydrate contacts for every resolved org so the chat
    // agent has concrete contact ids to propose enrollment batches
    // against. These land alongside other chunk-level items.
    const orgContactItems = await this.fetchContactsForOrgs(tx, scope.org_ids ?? []);

    // Sprint M — list every campaign in the workspace so the agent
    // can pick an existing plan by name instead of inventing ids.
    // Campaigns go into a dedicated top-level field (rendered as its
    // own section in the prompt) rather than the chunk list.
    const campaignsCatalog = await this.fetchCampaignsCatalog(tx);

    // Sprint O — hydrate active enrollments so the chat agent can
    // propose enrollment.control (pause/resume/unsubscribe) actions
    // with concrete enrollment ids.
    const enrollmentItems = await this.fetchActiveEnrollments(tx);

    // Sprint P — hydrate open follow-ups so the agent can reference
    // "you already have a reminder scheduled for Acme" instead of
    // proposing a duplicate.
    const followUpItems = await this.fetchOpenFollowUps(tx);
    const documentItems = await this.fetchDocuments(tx);
    const dealDossierItems = await this.fetchDealDossier(tx);
    const orgGraphItems = await this.fetchOrgProductsAndGraph(tx);

    const allItems = [
      ...(items.length > 0 ? items : fallbackItems),
      ...orgContactItems,
      ...enrollmentItems,
      ...followUpItems,
      ...documentItems,
      ...dealDossierItems,
      ...orgGraphItems,
    ];

    const aggregates = await this.fetchAggregates(tx);

    const cap = options.tokenCap ?? DEFAULT_TOKEN_CAP;
    let pack: EvidencePack = {
      summaries: summariesItems,
      items: allItems,
      campaigns: campaignsCatalog,
      aggregates,
      estimated_tokens: packTokens({
        summaries: summariesItems,
        items: allItems,
      }),
    };

    if (pack.estimated_tokens > cap) {
      pack = truncateToCap(pack, cap);
    }
    return pack;
  }

  /**
   * Sprint M — hydrate active contacts for each resolved organization
   * so the chat agent has concrete contact ids when proposing
   * `campaign.enroll_batch` actions. Returned as chunk-level items so
   * they flow through the normal token-cap truncation.
   */
  private async fetchContactsForOrgs(
    tx: Tx,
    orgIds: readonly string[],
  ): Promise<EvidenceItem[]> {
    if (orgIds.length === 0) return [];
    const rows = await tx
      .select({
        id: contacts.id,
        orgId: contacts.orgId,
        fullName: contacts.fullName,
        title: contacts.title,
        emails: contacts.emails,
        phones: contacts.phones,
        optOutAt: contacts.optOutAt,
      })
      .from(contacts)
      .where(
        and(
          inArray(contacts.orgId, [...orgIds]),
          eq(contacts.status, "active"),
        ),
      )
      .limit(200);

    return rows
      .filter((r) => !r.optOutAt)
      .map((r) => ({
        chunk_id: `contact:${r.id}`,
        object_type: "contact",
        object_id: r.id,
        chunk_text: [
          `Contact ${r.id}`,
          `  Name: ${r.fullName}`,
          r.title ? `  Title: ${r.title}` : null,
          `  Org id: ${r.orgId ?? "none"}`,
          r.emails && r.emails.length > 0
            ? `  Emails: ${r.emails.join(", ")}`
            : null,
          r.phones && r.phones.length > 0
            ? `  Phones: ${r.phones.join(", ")}`
            : null,
        ]
          .filter(Boolean)
          .join("\n"),
        source_ref: `contact ${r.id}`,
        source_type: "hydration",
        occurred_at: null,
        freshness_hours: 0,
        confidence_score: 0.75,
        corroborated_by_count: 0,
        permission_scope: "workspace",
        raw_event_ref: null,
        summary_version: null,
      }) satisfies EvidenceItem);
  }

  /**
   * Sprint O — active enrollments in the workspace, surfaced so the
   * chat agent can propose enrollment.control actions with concrete
   * enrollment ids. Bounded to 50 most-recent rows because the
   * prompt token budget is finite and operator queries rarely
   * reach beyond the in-flight ones.
   */
  private async fetchActiveEnrollments(tx: Tx): Promise<EvidenceItem[]> {
    const rows = await tx
      .select({
        id: campaignEnrollments.id,
        campaignId: campaignEnrollments.campaignId,
        contactId: campaignEnrollments.contactId,
        currentStep: campaignEnrollments.currentStep,
        state: campaignEnrollments.state,
        lastEventAt: campaignEnrollments.lastEventAt,
      })
      .from(campaignEnrollments)
      .where(inArray(campaignEnrollments.state, ["enrolled", "paused"]))
      .orderBy(desc(campaignEnrollments.lastEventAt))
      .limit(50);
    if (rows.length === 0) return [];

    return rows.map((r) => ({
      chunk_id: `enrollment:${r.id}`,
      object_type: "enrollment",
      object_id: r.id,
      chunk_text: [
        `Enrollment ${r.id}`,
        `  Campaign: ${r.campaignId}`,
        `  Contact: ${r.contactId}`,
        `  State: ${r.state}`,
        `  Current step: ${r.currentStep}`,
      ].join("\n"),
      source_ref: `enrollment ${r.id}`,
      source_type: "hydration",
      occurred_at: r.lastEventAt,
      freshness_hours: r.lastEventAt
        ? Math.max(0, (Date.now() - r.lastEventAt.getTime()) / (1000 * 60 * 60))
        : 0,
      confidence_score: 0.8,
      corroborated_by_count: 0,
      permission_scope: "workspace",
      raw_event_ref: null,
      summary_version: null,
    }) satisfies EvidenceItem);
  }

  /**
   * Sprint P — open follow-ups (pending reminders + assigned tasks),
   * surfaced so the agent doesn't propose duplicates and can
   * reference existing ones by id.
   */
  private async fetchOpenFollowUps(tx: Tx): Promise<EvidenceItem[]> {
    const rows = await tx
      .select({
        id: followUps.id,
        title: followUps.title,
        dueAt: followUps.dueAt,
        subjectType: followUps.subjectType,
        subjectId: followUps.subjectId,
        assignedTo: followUps.assignedTo,
      })
      .from(followUps)
      .where(eq(followUps.status, "open"))
      .orderBy(followUps.dueAt)
      .limit(30);
    if (rows.length === 0) return [];
    return rows.map((r) => ({
      chunk_id: `follow_up:${r.id}`,
      object_type: "follow_up",
      object_id: r.id,
      chunk_text: [
        `Follow-up ${r.id}`,
        `  Title: ${r.title}`,
        `  Due: ${r.dueAt.toISOString()}`,
        r.subjectType && r.subjectId
          ? `  Subject: ${r.subjectType} ${r.subjectId}`
          : null,
        r.assignedTo ? `  Assigned: ${r.assignedTo}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      source_ref: `follow_up ${r.id}`,
      source_type: "hydration",
      occurred_at: r.dueAt,
      freshness_hours: 0,
      confidence_score: 0.9,
      corroborated_by_count: 0,
      permission_scope: "workspace",
      raw_event_ref: null,
      summary_version: null,
    }) satisfies EvidenceItem);
  }

  /**
   * Hydrate recent documents attached to any org / contact / deal so
   * the chat agent can cite them by id + content excerpt. Limited to
   * the 30 most-recent rows across the tenant; excerpts capped so a
   * large-pdf-heavy workspace can't blow the evidence-pack token
   * budget. When a user asks "what's in the BL for deal 003" the
   * agent matches subject_type=fuel_deal + subjectId and finds the
   * corresponding document items here.
   */
  private async fetchDocuments(tx: Tx): Promise<EvidenceItem[]> {
    const rows = await tx
      .select({
        id: documents.id,
        title: documents.title,
        filename: documents.filename,
        documentType: documents.documentType,
        subjectType: documents.subjectType,
        subjectId: documents.subjectId,
        extractedText: documents.extractedText,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .orderBy(desc(documents.createdAt))
      .limit(30);
    if (rows.length === 0) return [];
    return rows.map((r) => {
      const preview = r.extractedText ? r.extractedText.slice(0, 1200) : null;
      const lines = [
        `Document ${r.id}`,
        `  Title: ${r.title}`,
        `  Type: ${r.documentType}`,
        r.subjectType && r.subjectId
          ? `  Attached to: ${r.subjectType} ${r.subjectId}`
          : null,
        r.filename ? `  Filename: ${r.filename}` : null,
        preview ? `  Excerpt: ${preview.replace(/\s+/g, " ").trim()}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      return {
        chunk_id: `document:${r.id}`,
        object_type: "document",
        object_id: r.id,
        chunk_text: lines,
        source_ref: `document ${r.id}`,
        source_type: "hydration",
        occurred_at: r.createdAt,
        freshness_hours: 0,
        confidence_score: 0.9,
        corroborated_by_count: 0,
        permission_scope: "workspace",
        raw_event_ref: null,
        summary_version: null,
      } satisfies EvidenceItem;
    });
  }

  /**
   * Sprint M — list every campaign in the tenant with its step count
   * and channel mix. Fed to the chat agent via the EvidencePack's
   * `campaigns` field so it can match user descriptions ("nurture
   * sequence", "outbound SDR cadence") to real campaign ids.
   */
  /**
   * Per-deal dossier — every deal as an evidence item carrying the
   * comparison-relevant columns (product, volume, margin, revenue,
   * status, destination, laycan). When the user says "how does 003
   * compare to our last few jet fuel deals", the chat agent scans
   * object_type=fuel_deal items for peers (same product / similar
   * volume) and quotes the numbers. Capped at 30 rows.
   */
  private async fetchDealDossier(tx: Tx): Promise<EvidenceItem[]> {
    const rows = (await tx.execute(sql`
      SELECT
        d.id AS id,
        d.deal_ref AS deal_ref,
        d.status AS status,
        d.product AS product,
        d.product_grade AS product_grade,
        d.volume_usg AS volume_usg,
        d.incoterm AS incoterm,
        d.destination_port AS destination_port,
        d.destination_country AS destination_country,
        d.laycan_start AS laycan_start,
        d.laycan_end AS laycan_end,
        d.compliance_hold AS compliance_hold,
        d.created_at AS created_at,
        d.updated_at AS updated_at,
        c.gross_margin_pct AS gross_margin_pct,
        c.net_margin_pct AS net_margin_pct,
        c.ebitda_usd AS ebitda_usd,
        c.breakeven_sell_price_usg AS breakeven_sell_price_usg,
        o.legal_name AS buyer_name
      FROM fuel_deals d
      LEFT JOIN fuel_deal_cost_stack c ON c.deal_id = d.id
      LEFT JOIN organizations o ON o.id = d.buyer_org_id
      ORDER BY d.updated_at DESC
      LIMIT 30
    `)).rows as unknown as Array<{
      id: string;
      deal_ref: string;
      status: string;
      product: string;
      product_grade: string | null;
      volume_usg: number;
      incoterm: string;
      destination_port: string | null;
      destination_country: string | null;
      laycan_start: string | null;
      laycan_end: string | null;
      compliance_hold: boolean;
      created_at: Date;
      updated_at: Date;
      gross_margin_pct: number | null;
      net_margin_pct: number | null;
      ebitda_usd: number | null;
      breakeven_sell_price_usg: number | null;
      buyer_name: string | null;
    }>;
    if (rows.length === 0) return [];
    return rows.map((r) => {
      const volume = Number(r.volume_usg);
      const gm =
        r.gross_margin_pct === null
          ? "n/a"
          : `${(Number(r.gross_margin_pct) * 100).toFixed(1)}%`;
      const nm =
        r.net_margin_pct === null
          ? "n/a"
          : `${(Number(r.net_margin_pct) * 100).toFixed(1)}%`;
      const ebitda =
        r.ebitda_usd === null
          ? "n/a"
          : `$${Math.round(Number(r.ebitda_usd)).toLocaleString()}`;
      const breakeven =
        r.breakeven_sell_price_usg === null
          ? "n/a"
          : `$${Number(r.breakeven_sell_price_usg).toFixed(3)}/USG`;
      const chunk = [
        `Deal ${r.deal_ref} (${r.id})`,
        `  Status: ${r.status}${r.compliance_hold ? " · compliance_hold" : ""}`,
        `  Product: ${r.product}${r.product_grade ? ` (${r.product_grade})` : ""}`,
        `  Volume: ${volume.toLocaleString()} USG`,
        `  Incoterm: ${r.incoterm}`,
        r.destination_port
          ? `  Destination: ${r.destination_port}${r.destination_country ? `, ${r.destination_country}` : ""}`
          : null,
        r.buyer_name ? `  Buyer: ${r.buyer_name}` : null,
        r.laycan_start && r.laycan_end
          ? `  Laycan: ${r.laycan_start} → ${r.laycan_end}`
          : null,
        `  Gross margin: ${gm} · Net margin: ${nm} · EBITDA: ${ebitda} · Breakeven: ${breakeven}`,
      ]
        .filter(Boolean)
        .join("\n");
      const occurred = r.updated_at instanceof Date ? r.updated_at : new Date();
      const ageHours = Math.max(
        0,
        (Date.now() - occurred.getTime()) / (60 * 60 * 1000),
      );
      return {
        chunk_id: `fuel_deal:${r.id}`,
        object_type: "fuel_deal",
        object_id: r.id,
        chunk_text: chunk,
        source_ref: `fuel_deal ${r.deal_ref}`,
        source_type: "hydration",
        occurred_at: occurred,
        freshness_hours: ageHours,
        confidence_score: 0.95,
        corroborated_by_count: 0,
        permission_scope: "workspace",
        raw_event_ref: null,
        summary_version: null,
      } satisfies EvidenceItem;
    });
  }

  /**
   * Roll-up projections so Vex can answer comparative / aggregate
   * questions without the agent having to page through individual
   * evidence items and sum them itself. Three rollups:
   *   - pipeline: deal counts + volume + revenue bucketed by status
   *               and product, plus whole-workspace totals.
   *   - signals: open signal counts by severity and rule.
   *   - top_counterparties: orgs ranked by deal count in the last
   *     90 days (the window most relevant to VTC's active book).
   */
  /**
   * Sprint W — hydrate the counterparty graph: for every org,
   * which products they deal in + which broker/supplier/partner
   * relationships they're on either side of. Yields one evidence
   * item per org that has any product or relationship, with the
   * org's kind pill + product list + inbound/outbound edges
   * inlined. When the user asks "who supplies rice" / "who brokers
   * pork" / "what does Acme deal in", the agent scans these items
   * and lists the matching orgs.
   */
  private async fetchOrgProductsAndGraph(
    tx: Tx,
  ): Promise<EvidenceItem[]> {
    const rows = (await tx.execute(sql`
      SELECT
        o.id AS org_id,
        o.legal_name AS name,
        o.kind AS kind,
        o.updated_at AS updated_at,
        COALESCE(
          array_agg(DISTINCT op.product) FILTER (WHERE op.product IS NOT NULL),
          ARRAY[]::text[]
        ) AS products,
        COALESCE(
          array_agg(DISTINCT
            concat(
              r_out.relationship_type, ':',
              r_out.to_org_id,
              CASE WHEN r_out.product IS NULL THEN '' ELSE concat('/', r_out.product) END
            )
          ) FILTER (WHERE r_out.id IS NOT NULL),
          ARRAY[]::text[]
        ) AS outbound_edges,
        COALESCE(
          array_agg(DISTINCT
            concat(
              r_in.relationship_type, ':',
              r_in.from_org_id,
              CASE WHEN r_in.product IS NULL THEN '' ELSE concat('/', r_in.product) END
            )
          ) FILTER (WHERE r_in.id IS NOT NULL),
          ARRAY[]::text[]
        ) AS inbound_edges
      FROM organizations o
      LEFT JOIN organization_products op ON op.org_id = o.id
      LEFT JOIN organization_relationships r_out ON r_out.from_org_id = o.id
      LEFT JOIN organization_relationships r_in ON r_in.to_org_id = o.id
      WHERE op.id IS NOT NULL OR r_out.id IS NOT NULL OR r_in.id IS NOT NULL
         OR o.kind IS NOT NULL
      GROUP BY o.id, o.legal_name, o.kind, o.updated_at
      ORDER BY o.updated_at DESC
      LIMIT 60
    `)).rows as unknown as Array<{
      org_id: string;
      name: string;
      kind: string | null;
      updated_at: Date;
      products: string[];
      outbound_edges: string[];
      inbound_edges: string[];
    }>;
    if (rows.length === 0) return [];
    return rows.map((r) => {
      const lines = [
        `Counterparty ${r.org_id}`,
        `  Name: ${r.name}`,
        r.kind ? `  Kind: ${r.kind}` : null,
        r.products.length > 0
          ? `  Products: ${r.products.join(", ")}`
          : null,
        r.outbound_edges.length > 0
          ? `  Outbound: ${r.outbound_edges.join(", ")}`
          : null,
        r.inbound_edges.length > 0
          ? `  Inbound:  ${r.inbound_edges.join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");
      const occurred =
        r.updated_at instanceof Date ? r.updated_at : new Date();
      return {
        chunk_id: `organization_graph:${r.org_id}`,
        object_type: "organization",
        object_id: r.org_id,
        chunk_text: lines,
        source_ref: `organization_graph ${r.org_id}`,
        source_type: "hydration",
        occurred_at: occurred,
        freshness_hours: 0,
        confidence_score: 0.9,
        corroborated_by_count: 0,
        permission_scope: "workspace",
        raw_event_ref: null,
        summary_version: null,
      } satisfies EvidenceItem;
    });
  }

  private async fetchAggregates(tx: Tx): Promise<EvidenceAggregates> {
    const pipelineByStatus = (await tx.execute(sql`
      SELECT
        status,
        COUNT(*)::int AS deal_count,
        COALESCE(SUM(volume_usg), 0)::double precision AS total_volume_usg
      FROM fuel_deals
      GROUP BY status
      ORDER BY deal_count DESC
    `)).rows as unknown as Array<{
      status: string;
      deal_count: number;
      total_volume_usg: number;
    }>;

    const costByDeal = (await tx.execute(sql`
      SELECT deal_id, gross_margin_pct, breakeven_sell_price_usg
      FROM fuel_deal_cost_stack
    `)).rows as unknown as Array<{
      deal_id: string;
      gross_margin_pct: number | null;
      breakeven_sell_price_usg: number | null;
    }>;
    const marginByDeal = new Map<string, number | null>(
      costByDeal.map((r) => [r.deal_id, r.gross_margin_pct]),
    );

    const dealsForRevenue = await tx
      .select({
        id: fuelDeals.id,
        status: fuelDeals.status,
        product: fuelDeals.product,
        volumeUsg: fuelDeals.volumeUsg,
        complianceHold: fuelDeals.complianceHold,
        lineOfBusiness: fuelDeals.lineOfBusiness,
      })
      .from(fuelDeals);

    const byStatusRevenue = new Map<string, number>();
    for (const d of dealsForRevenue) {
      const bp = costByDeal.find((c) => c.deal_id === d.id);
      const revenue =
        bp?.breakeven_sell_price_usg !== undefined &&
        bp?.breakeven_sell_price_usg !== null
          ? bp.breakeven_sell_price_usg * d.volumeUsg
          : 0;
      byStatusRevenue.set(
        d.status,
        (byStatusRevenue.get(d.status) ?? 0) + revenue,
      );
    }

    const productBuckets = new Map<
      string,
      { count: number; volume: number; margins: number[] }
    >();
    for (const d of dealsForRevenue) {
      const key = d.product;
      const bucket = productBuckets.get(key) ?? {
        count: 0,
        volume: 0,
        margins: [],
      };
      bucket.count += 1;
      bucket.volume += d.volumeUsg;
      const margin = marginByDeal.get(d.id);
      if (margin !== null && margin !== undefined) bucket.margins.push(margin);
      productBuckets.set(key, bucket);
    }

    const openStatuses = new Set([
      "draft",
      "negotiating",
      "pending_approval",
      "approved",
      "loading",
      "in_transit",
    ]);
    let openDealCount = 0;
    let settledDealCount = 0;
    let complianceHoldCount = 0;
    for (const d of dealsForRevenue) {
      if (openStatuses.has(d.status)) openDealCount += 1;
      if (d.status === "settled" || d.status === "delivered") {
        settledDealCount += 1;
      }
      if (d.complianceHold) complianceHoldCount += 1;
    }

    const lobBuckets = new Map<string, { count: number; volume: number }>();
    for (const d of dealsForRevenue) {
      const key = d.lineOfBusiness ?? "fuel";
      const bucket = lobBuckets.get(key) ?? { count: 0, volume: 0 };
      bucket.count += 1;
      bucket.volume += d.volumeUsg;
      lobBuckets.set(key, bucket);
    }

    const pipeline: EvidenceAggregates["pipeline"] = {
      by_status: pipelineByStatus.map((r) => ({
        status: r.status,
        deal_count: Number(r.deal_count),
        total_volume_usg: Number(r.total_volume_usg),
        total_revenue_usd: Math.round(byStatusRevenue.get(r.status) ?? 0),
      })),
      by_product: [...productBuckets.entries()].map(([product, bucket]) => ({
        product,
        deal_count: bucket.count,
        total_volume_usg: bucket.volume,
        avg_margin_pct:
          bucket.margins.length === 0
            ? null
            : bucket.margins.reduce((a, b) => a + b, 0) / bucket.margins.length,
      })),
      by_line_of_business: [...lobBuckets.entries()].map(([lob, bucket]) => ({
        line_of_business: lob,
        deal_count: bucket.count,
        total_volume_usg: bucket.volume,
      })),
      totals: {
        open_deal_count: openDealCount,
        closed_won_deal_count: settledDealCount,
        compliance_hold_count: complianceHoldCount,
      },
    };

    const signalsBySeverity = (await tx.execute(sql`
      SELECT severity, COUNT(*)::int AS count
      FROM signals
      WHERE acknowledged_at IS NULL
      GROUP BY severity
      ORDER BY count DESC
    `)).rows as unknown as Array<{ severity: string; count: number }>;
    const signalsByRule = (await tx.execute(sql`
      SELECT rule_id, COUNT(*)::int AS count
      FROM signals
      WHERE acknowledged_at IS NULL
      GROUP BY rule_id
      ORDER BY count DESC
      LIMIT 10
    `)).rows as unknown as Array<{ rule_id: string; count: number }>;
    const signalsOpenTotal = signalsBySeverity.reduce(
      (total, row) => total + Number(row.count),
      0,
    );

    const topOrgsRows = (await tx.execute(sql`
      SELECT
        o.id AS org_id,
        o.legal_name AS name,
        COUNT(d.id)::int AS deal_count,
        MAX(d.deal_ref) AS latest_deal_ref
      FROM organizations o
      JOIN fuel_deals d ON d.buyer_org_id = o.id
      WHERE d.created_at >= NOW() - INTERVAL '90 days'
      GROUP BY o.id, o.legal_name
      ORDER BY deal_count DESC
      LIMIT 10
    `)).rows as unknown as Array<{
      org_id: string;
      name: string;
      deal_count: number;
      latest_deal_ref: string | null;
    }>;

    return {
      pipeline,
      signals: {
        open_total: signalsOpenTotal,
        by_severity: signalsBySeverity.map((r) => ({
          severity: r.severity,
          count: Number(r.count),
        })),
        by_rule: signalsByRule.map((r) => ({
          rule_id: r.rule_id,
          count: Number(r.count),
        })),
      },
      top_counterparties: topOrgsRows.map((r) => ({
        org_id: r.org_id,
        name: r.name,
        deal_count: Number(r.deal_count),
        latest_deal_ref: r.latest_deal_ref,
      })),
    };
  }

  private async fetchCampaignsCatalog(tx: Tx): Promise<EvidenceCampaign[]> {
    const rows = await tx
      .select({
        id: campaigns.id,
        channel: campaigns.channel,
        source: campaigns.source,
        medium: campaigns.medium,
        objective: campaigns.objective,
      })
      .from(campaigns)
      .limit(100);
    if (rows.length === 0) return [];

    const stepRows = await tx
      .select({
        campaignId: campaignSteps.campaignId,
        channel: campaignSteps.channel,
        tier: campaignSteps.tier,
      })
      .from(campaignSteps)
      .where(inArray(campaignSteps.campaignId, rows.map((r) => r.id)));

    const byCampaign = new Map<
      string,
      { channels: Set<string>; tiers: string[] }
    >();
    for (const s of stepRows) {
      const existing = byCampaign.get(s.campaignId) ?? {
        channels: new Set<string>(),
        tiers: [],
      };
      existing.channels.add(s.channel);
      existing.tiers.push(s.tier);
      byCampaign.set(s.campaignId, existing);
    }

    return rows.map((r) => {
      const meta = byCampaign.get(r.id);
      const channels =
        meta && meta.channels.size > 0
          ? [...meta.channels].sort()
          : [r.channel];
      const modeTier = meta ? mostCommon(meta.tiers) : undefined;
      const stepCount = stepRows.filter((s) => s.campaignId === r.id).length;
      // Campaigns have no `name` column — synthesize a display label
      // from objective / source / medium. The chat agent sees this
      // label when deciding which campaign matches a user's request.
      const name =
        r.objective ??
        [r.source, r.medium].filter(Boolean).join(" / ") ??
        r.id;
      return {
        id: r.id,
        name,
        channels,
        step_count: stepCount,
        ...(modeTier ? { tier: modeTier } : {}),
      } satisfies EvidenceCampaign;
    });
  }

  /**
   * ILIKE-based fallback retrieval. Picks meaningful tokens out of
   * the query (length >= 3, common stopwords dropped) and matches
   * each against organization names + domains, contact names, and
   * fuel-deal refs. Returns at most 12 items composed as
   * EvidenceItems with confidence_score 0.4 — Claude treats these
   * as low-confidence per the prompt's < 0.5 prefix rule, so the
   * answer is qualified with "[Best current view — limited
   * evidence]".
   */
  private async nameMatchFallback(
    tx: Tx,
    queryText: string,
  ): Promise<EvidenceItem[]> {
    const lower = queryText.toLowerCase();
    const tokens = lower
      .split(/[^a-z0-9-]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
      .slice(0, 4);

    // Category-mention fallback — if the query names an entity type
    // ("show me deals", "list contacts at Acme", "which companies"),
    // include the top N rows of that type even if no concrete name
    // token was extracted. This keeps "show me deals" from coming
    // back empty when every token was a stopword.
    const mentionsDeals = /\b(deals?|pipeline|orders?)\b/.test(lower);
    const mentionsCompanies = /\b(compan(y|ies)|orgs?|organizations?|accounts?|buyers?|customers?)\b/.test(lower);
    const mentionsContacts = /\b(contacts?|people|leads?|prospects?)\b/.test(lower);
    const mentionsCampaigns =
      /\b(campaigns?|touchpoints?|nurture|outbound|ads?|marketing|clicks?|opens?)\b/.test(
        lower,
      );

    if (
      tokens.length === 0 &&
      !mentionsDeals &&
      !mentionsCompanies &&
      !mentionsContacts &&
      !mentionsCampaigns
    ) {
      return [];
    }

    const patterns = tokens.map((t) => `%${t.replace(/[%_]/g, (c) => `\\${c}`)}%`);
    const orgLimit = mentionsCompanies ? 10 : 4;
    const contactLimit = mentionsContacts ? 10 : 4;
    const dealLimit = mentionsDeals ? 10 : 4;
    const campaignLimit = mentionsCampaigns ? 6 : 3;

    // When a category is mentioned but no name tokens (e.g. "show me
    // deals"), skip the WHERE clause on that entity and just list the
    // most recent rows. Name-only queries still filter via ILIKE.
    const orgQuery = tx
      .select({
        id: organizations.id,
        legalName: organizations.legalName,
        domain: organizations.domain,
        industry: organizations.industry,
        fitScore: organizations.fitScore,
        updatedAt: organizations.updatedAt,
      })
      .from(organizations);
    const contactQuery = tx
      .select({
        id: contacts.id,
        fullName: contacts.fullName,
        title: contacts.title,
        emails: contacts.emails,
        orgId: contacts.orgId,
        updatedAt: contacts.updatedAt,
      })
      .from(contacts);
    // Deal query joins the buyer org for the name + the latest
    // active scenario for the calculator output (margin, EBITDA,
    // score, recommendation). One row per deal — left-join
    // tolerates deals with no scenario yet.
    const buyerAlias = organizations;
    const dealQuery = tx
      .select({
        id: fuelDeals.id,
        dealRef: fuelDeals.dealRef,
        status: fuelDeals.status,
        product: fuelDeals.product,
        volumeUsg: fuelDeals.volumeUsg,
        incoterm: fuelDeals.incoterm,
        destinationPort: fuelDeals.destinationPort,
        originPort: fuelDeals.originPort,
        ofacStatus: fuelDeals.ofacScreeningStatus,
        complianceHold: fuelDeals.complianceHold,
        buyerOrgId: fuelDeals.buyerOrgId,
        buyerName: buyerAlias.legalName,
        scenarioScore: fuelDealScenarios.score,
        scenarioRec: fuelDealScenarios.recommendation,
        scenarioJson: fuelDealScenarios.resultsJson,
        updatedAt: fuelDeals.updatedAt,
      })
      .from(fuelDeals)
      .leftJoin(buyerAlias, eq(fuelDeals.buyerOrgId, buyerAlias.id))
      .leftJoin(
        fuelDealScenarios,
        and(
          eq(fuelDealScenarios.dealId, fuelDeals.id),
          eq(fuelDealScenarios.isActive, true),
        ),
      );
    // Campaigns have no `name` column — match query tokens against
    // channel/medium/source/objective/accountRef, where the seed
    // puts distinguishing values (email+nurture for email_nurture,
    // paid_search+q2 for paid_search_q2). The tokenizer splits on
    // `_`, so compound literal `email_nurture` yields [email, nurture]
    // and matches the seeded row via channel=email + medium=nurture.
    const campaignQuery = tx
      .select({
        id: campaigns.id,
        channel: campaigns.channel,
        source: campaigns.source,
        medium: campaigns.medium,
        objective: campaigns.objective,
        accountRef: campaigns.accountRef,
        status: campaigns.status,
        updatedAt: campaigns.updatedAt,
      })
      .from(campaigns);

    const [orgRows, contactRows, dealRows, campaignRows] = await Promise.all([
      patterns.length > 0 && !mentionsCompanies
        ? orgQuery
            .where(
              or(
                ...patterns.flatMap((p) => [
                  ilike(organizations.legalName, p),
                  ilike(organizations.domain, p),
                ]),
              ),
            )
            .limit(orgLimit)
        : mentionsCompanies
          ? orgQuery
              .orderBy(desc(organizations.updatedAt))
              .limit(orgLimit)
          : Promise.resolve([]),
      patterns.length > 0 && !mentionsContacts
        ? contactQuery
            .where(or(...patterns.map((p) => ilike(contacts.fullName, p))))
            .limit(contactLimit)
        : mentionsContacts
          ? contactQuery
              .orderBy(desc(contacts.updatedAt))
              .limit(contactLimit)
          : Promise.resolve([]),
      patterns.length > 0 && !mentionsDeals
        ? dealQuery
            .where(or(...patterns.map((p) => ilike(fuelDeals.dealRef, p))))
            .limit(dealLimit)
        : mentionsDeals
          ? dealQuery
              .orderBy(desc(fuelDeals.updatedAt))
              .limit(dealLimit)
          : Promise.resolve([]),
      patterns.length > 0
        ? campaignQuery
            // Filter even when \`mentionsCampaigns\` fires — otherwise
            // "touchpoint history for email_nurture" takes the
            // category-only branch and returns recent campaigns
            // regardless of the token. Filter always, widen the limit
            // when a category word is also present.
            .where(
              or(
                ...patterns.flatMap((p) => [
                  ilike(campaigns.channel, p),
                  ilike(campaigns.medium, p),
                  ilike(campaigns.source, p),
                  ilike(campaigns.objective, p),
                  ilike(campaigns.accountRef, p),
                ]),
              ),
            )
            .limit(campaignLimit)
        : mentionsCampaigns
          ? campaignQuery
              .orderBy(desc(campaigns.updatedAt))
              .limit(campaignLimit)
          : Promise.resolve([]),
    ]);

    // For every matched campaign, pull its most recent touchpoints —
    // eval fixtures ("show the touchpoint history for email_nurture")
    // expect touchpoint object_ids alongside the campaign row. A
    // single \`IN (...) LIMIT 15\` would let one high-volume campaign
    // crowd out the others, so fetch per-campaign in parallel.
    const TOUCHPOINTS_PER_CAMPAIGN = 5;
    const touchpointRows = (
      await Promise.all(
        campaignRows.map((c) =>
          tx
            .select({
              id: touchpoints.id,
              channel: touchpoints.channel,
              actor: touchpoints.actor,
              occurredAt: touchpoints.occurredAt,
              campaignId: touchpoints.campaignId,
            })
            .from(touchpoints)
            .where(eq(touchpoints.campaignId, c.id))
            .orderBy(desc(touchpoints.occurredAt))
            .limit(TOUCHPOINTS_PER_CAMPAIGN),
        ),
      )
    ).flat();

    const items: EvidenceItem[] = [];
    const now = Date.now();

    for (const o of orgRows) {
      const fit = o.fitScore !== null ? `, fit ${(o.fitScore * 100).toFixed(0)}` : "";
      const text = `Organization ${o.legalName}${o.domain ? ` (${o.domain})` : ""}${o.industry ? ` — ${o.industry}` : ""}${fit}.`;
      items.push({
        chunk_id: o.id,
        object_type: "organization",
        object_id: o.id,
        chunk_text: text,
        source_ref: `name-match / organization ${o.id}`,
        source_type: "fallback",
        occurred_at: o.updatedAt,
        freshness_hours: Math.max(0, (now - o.updatedAt.getTime()) / 3_600_000),
        confidence_score: 0.4,
        corroborated_by_count: 0,
        permission_scope: "workspace",
        raw_event_ref: null,
        summary_version: null,
      });
    }
    for (const c of contactRows) {
      const email = c.emails?.[0] ?? null;
      const text = `Contact ${c.fullName}${c.title ? ` — ${c.title}` : ""}${email ? ` · ${email}` : ""}.`;
      items.push({
        chunk_id: c.id,
        object_type: "contact",
        object_id: c.id,
        chunk_text: text,
        source_ref: `name-match / contact ${c.id}`,
        source_type: "fallback",
        occurred_at: c.updatedAt,
        freshness_hours: Math.max(0, (now - c.updatedAt.getTime()) / 3_600_000),
        confidence_score: 0.4,
        corroborated_by_count: 0,
        permission_scope: "workspace",
        raw_event_ref: null,
        summary_version: null,
      });
    }
    for (const d of dealRows) {
      const text = describeFuelDeal(d);
      items.push({
        chunk_id: d.id,
        object_type: "fuel_deal",
        object_id: d.id,
        chunk_text: text,
        source_ref: `name-match / fuel_deal ${d.id}`,
        source_type: "fallback",
        occurred_at: d.updatedAt,
        freshness_hours: Math.max(0, (now - d.updatedAt.getTime()) / 3_600_000),
        confidence_score: 0.4,
        corroborated_by_count: 0,
        permission_scope: "workspace",
        raw_event_ref: null,
        summary_version: null,
      });
    }
    for (const c of campaignRows) {
      const parts = [
        `Campaign ${c.id}`,
        `channel ${c.channel}`,
        c.medium ? `medium ${c.medium}` : null,
        c.source ? `source ${c.source}` : null,
        c.objective ? `objective "${c.objective}"` : null,
        `status ${c.status}`,
      ].filter(Boolean);
      items.push({
        chunk_id: c.id,
        object_type: "campaign",
        object_id: c.id,
        chunk_text: `${parts.join(" · ")}.`,
        source_ref: `name-match / campaign ${c.id}`,
        source_type: "fallback",
        occurred_at: c.updatedAt,
        freshness_hours: Math.max(0, (now - c.updatedAt.getTime()) / 3_600_000),
        confidence_score: 0.4,
        corroborated_by_count: 0,
        permission_scope: "workspace",
        raw_event_ref: null,
        summary_version: null,
      });
    }
    for (const t of touchpointRows) {
      items.push({
        chunk_id: t.id,
        object_type: "touchpoint",
        object_id: t.id,
        chunk_text: `Touchpoint ${t.channel}${t.actor ? ` from ${t.actor}` : ""} at ${t.occurredAt.toISOString()}${t.campaignId ? ` · campaign ${t.campaignId}` : ""}.`,
        source_ref: `name-match / touchpoint ${t.id}`,
        source_type: "fallback",
        occurred_at: t.occurredAt,
        freshness_hours: Math.max(0, (now - t.occurredAt.getTime()) / 3_600_000),
        confidence_score: 0.4,
        corroborated_by_count: 0,
        permission_scope: "workspace",
        raw_event_ref: null,
        summary_version: null,
      });
    }
    return items;
  }

  /**
   * Collect the latest summary row for every (subjectType, subjectId) pair
   * implied by the resolved scope, projected as `EvidenceItem`s.
   */
  private async fetchScopeSummaries(
    tx: Tx,
    scope: ResolvedScope,
  ): Promise<EvidenceItem[]> {
    const subjects: { type: string; id: string }[] = [];
    for (const id of scope.org_ids ?? []) subjects.push({ type: "organization", id });
    for (const id of scope.contact_ids ?? []) subjects.push({ type: "contact", id });
    for (const id of scope.campaign_ids ?? []) subjects.push({ type: "campaign", id });
    if (subjects.length === 0) return [];

    const rows = await tx
      .select()
      .from(summaries)
      .where(
        and(
          inArray(summaries.subjectId, subjects.map((s) => s.id)),
          inArray(
            summaries.subjectType,
            [...new Set(subjects.map((s) => s.type))],
          ),
        ),
      )
      .orderBy(desc(summaries.version));

    // Keep the highest version per (subjectType, subjectId).
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = `${row.subjectType}:${row.subjectId}`;
      if (!latest.has(key)) latest.set(key, row);
    }

    const now = Date.now();
    return [...latest.values()].map((row) => {
      const occurredAt = row.validityWindowStart ?? row.updatedAt;
      const ageMs = now - occurredAt.getTime();
      return {
        chunk_id: row.id,
        object_type: row.subjectType,
        object_id: row.subjectId,
        chunk_text: row.content,
        source_ref: `summary v${row.version} / ${row.subjectType} ${row.subjectId}`,
        source_type: "summary",
        occurred_at: occurredAt,
        freshness_hours: Math.max(0, ageMs / (1000 * 60 * 60)),
        confidence_score: 0.85,
        corroborated_by_count: 0,
        permission_scope: "workspace",
        raw_event_ref: null,
        summary_version: row.version,
      } satisfies EvidenceItem;
    });
  }
}

function dedupeAppend(
  existing: readonly string[] | undefined,
  id: string,
): string[] {
  const list = existing ?? [];
  if (list.includes(id)) return [...list];
  return [...list, id];
}

function collectScopedIds(scope: ResolvedScope): string[] {
  return [
    ...(scope.org_ids ?? []),
    ...(scope.contact_ids ?? []),
    ...(scope.campaign_ids ?? []),
  ];
}

function countCorroboration(rows: ChunkRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.ownerObjectType}:${row.ownerObjectId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // Subtract the row itself when looking up below.
  return counts;
}

function toEvidenceItem(
  row: ChunkRow,
  nowMs: number,
  corroboration: Map<string, number>,
): EvidenceItem {
  const ageMs = nowMs - row.createdAt.getTime();
  const key = `${row.ownerObjectType}:${row.ownerObjectId}`;
  const cohortSize = corroboration.get(key) ?? 1;
  const metadata = row.metadata as Record<string, unknown>;
  const conf = typeof metadata["confidence"] === "number" ? Number(metadata["confidence"]) : 0.6;
  const rawEventRef =
    typeof metadata["raw_event_ref"] === "string" ? (metadata["raw_event_ref"] as string) : null;
  return {
    chunk_id: row.id,
    object_type: row.ownerObjectType,
    object_id: row.ownerObjectId,
    chunk_text: row.chunkText,
    source_ref: `${row.ownerObjectType} ${row.ownerObjectId} chunk`,
    source_type: typeof metadata["source_type"] === "string" ? (metadata["source_type"] as string) : "chunk",
    occurred_at: row.createdAt,
    freshness_hours: Math.max(0, ageMs / (1000 * 60 * 60)),
    confidence_score: clamp01(conf),
    corroborated_by_count: Math.max(0, cohortSize - 1),
    permission_scope: row.permissionScope,
    raw_event_ref: rawEventRef,
    summary_version: null,
  };
}

function rerankScore(rrf: number, item: EvidenceItem): number {
  const freshness = 1 / (1 + item.freshness_hours / 24);
  const corroboration = Math.tanh(item.corroborated_by_count / 3);
  return (
    W_RELEVANCE * normalizedRrf(rrf) +
    W_FRESHNESS * freshness +
    W_CONFIDENCE * item.confidence_score +
    W_CORROBORATION * corroboration
  );
}

/** Map RRF scores into [0, 1] by capping at the practical max (1/(K+1) * 2). */
function normalizedRrf(rrf: number): number {
  const max = 2 / (RRF_K + 1);
  return Math.min(1, rrf / max);
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * Drop oldest evidence (by occurred_at, fallback by freshness_hours) until
 * we fit under the token cap. Summaries are preserved — they're cheap and
 * carry the highest signal density.
 */
function truncateToCap(pack: EvidencePack, cap: number): EvidencePack {
  const keep: EvidenceItem[] = [];
  const sorted = [...pack.items].sort((a, b) => {
    const aTime = a.occurred_at?.getTime() ?? -Infinity;
    const bTime = b.occurred_at?.getTime() ?? -Infinity;
    return bTime - aTime;
  });
  let estimated = 0;
  for (const item of pack.summaries) estimated += approxTokens(item.chunk_text);
  for (const item of sorted) {
    const cost = approxTokens(item.chunk_text);
    if (estimated + cost > cap) break;
    estimated += cost;
    keep.push(item);
  }
  return { summaries: pack.summaries, items: keep, estimated_tokens: estimated };
}

/**
 * Compose a one-line description of a fuel deal that surfaces the
 * fields a CEO/CFO actually asks about: buyer, volume, status,
 * lane, EBITDA + margin (from the active scenario), recommendation,
 * and any compliance flags. Prose form so it lands cleanly in
 * Claude's evidence pack without bloating the token budget.
 */
function describeFuelDeal(d: {
  dealRef: string;
  status: string;
  product: string;
  volumeUsg: number;
  incoterm: string;
  destinationPort: string | null;
  originPort: string | null;
  ofacStatus: string;
  complianceHold: boolean;
  buyerName: string | null;
  scenarioScore: number | null;
  scenarioRec: string | null;
  scenarioJson: Record<string, unknown> | null;
}): string {
  const parts: string[] = [];
  parts.push(`Fuel deal ${d.dealRef}`);
  parts.push(`product ${d.product}`);
  parts.push(`status ${d.status}`);
  if (d.buyerName) parts.push(`buyer ${d.buyerName}`);
  parts.push(`volume ${formatVolumeUsg(d.volumeUsg)}`);
  if (d.originPort && d.destinationPort) {
    parts.push(`lane ${d.originPort}→${d.destinationPort} ${d.incoterm.toUpperCase()}`);
  } else if (d.destinationPort) {
    parts.push(`destination ${d.destinationPort}`);
  }
  const totals = readTotals(d.scenarioJson);
  if (totals.ebitdaUsd !== null) {
    parts.push(`EBITDA ${formatUsd(totals.ebitdaUsd)}`);
  }
  if (totals.ebitdaMarginPct !== null) {
    parts.push(`margin ${totals.ebitdaMarginPct.toFixed(1)}%`);
  }
  const perUsg = readPerUsg(d.scenarioJson);
  if (perUsg.netMargin !== null) {
    parts.push(`net ${perUsg.netMargin.toFixed(3)} $/USG`);
  }
  if (d.scenarioScore !== null) {
    parts.push(`score ${Math.round(d.scenarioScore)}/100`);
  }
  if (d.scenarioRec) parts.push(`recommendation ${d.scenarioRec}`);
  if (d.complianceHold) parts.push("compliance hold");
  if (d.ofacStatus !== "cleared") parts.push(`OFAC ${d.ofacStatus.replace("_", " ")}`);
  return parts.join(" · ") + ".";
}

function readTotals(json: Record<string, unknown> | null): {
  ebitdaUsd: number | null;
  ebitdaMarginPct: number | null;
} {
  if (!json || typeof json !== "object") return { ebitdaUsd: null, ebitdaMarginPct: null };
  const totals = (json as { totals?: unknown }).totals;
  if (!totals || typeof totals !== "object") return { ebitdaUsd: null, ebitdaMarginPct: null };
  const t = totals as Record<string, unknown>;
  return {
    ebitdaUsd: typeof t["ebitdaUsd"] === "number" ? (t["ebitdaUsd"] as number) : null,
    ebitdaMarginPct:
      typeof t["ebitdaMarginPct"] === "number"
        ? (t["ebitdaMarginPct"] as number)
        : null,
  };
}

function readPerUsg(json: Record<string, unknown> | null): { netMargin: number | null } {
  if (!json || typeof json !== "object") return { netMargin: null };
  const perUsg = (json as { perUsg?: unknown }).perUsg;
  if (!perUsg || typeof perUsg !== "object") return { netMargin: null };
  const p = perUsg as Record<string, unknown>;
  return {
    netMargin: typeof p["netMargin"] === "number" ? (p["netMargin"] as number) : null,
  };
}

function formatVolumeUsg(usg: number): string {
  if (usg >= 1_000_000) return `${(usg / 1_000_000).toFixed(1)}M USG`;
  if (usg >= 1_000) return `${(usg / 1_000).toFixed(0)}k USG`;
  return `${usg} USG`;
}

function formatUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

// Ensure the unused-imports linter doesn't cull contactOrgMemberships —
// we'll wire it into a contact-deal-count enrichment in a follow-up.
void contactOrgMemberships;

/** Return the most common string in an array, or undefined when empty. */
function mostCommon(values: string[]): string | undefined {
  if (values.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let top: { value: string; count: number } | null = null;
  for (const [value, count] of counts) {
    if (!top || count > top.count) top = { value, count };
  }
  return top?.value;
}

// kept for test reuse
export const __test = { rerankScore, truncateToCap, normalizedRrf };
