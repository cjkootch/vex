> **IMPLEMENTATION STATUS — refreshed 2026-04-29**
>
> **Status: procur-side shipped, vex-side not yet started.**
>
> Procur-side (shipped):
> - `GET /intelligence/proximity-suppliers` — haversine-distance refinery query against `known_entities`
> - `GET /intelligence/opportunities/recent` — used by ProcurOpportunityWatcher
> - `find-suppliers-for-tender` extended with `originBias` parameter
> - `known_entities` lat/lng backfill via Wikidata (PR #244 in procur) — the prerequisite called out in §10 of this brief is done
>
> Vex-side (not yet started):
> - `tender_pursuits` schema not yet created
> - `tender_supplier_candidates` schema not yet created
> - `bid_criteria` schema not yet created
> - `ProcurOpportunityWatcher` agent not yet built
> - `SupplierSourcingAgent` agent not yet built
> - UI surfaces (tender queue, pursuit detail, bid criteria settings) not yet built
>
> **Recommendation:** the procur side is ready to feed this workflow. Once the parent integration touchpoints (especially `CampaignTargetingAgent`) are operational, the tender-sourcing addendum is the natural next workstream — same patterns, same approval-gate model, just inverted to source suppliers for tenders rather than buyers for offers.
>
> The 7-8 day estimate in §11 still applies. ~1.5 days of procur-side work is done; ~6 days of vex-side work remain.
>
> ---

# Tender-Side Supplier Sourcing — Vex × Procur Integration Addendum

**Status:** spec, not yet implemented
**Owner:** Cole
**Last updated:** 2026-04-28
**Repos:** `cjkootch/vex` (canonical) + `cjkootch/procur_dashboard` (HTTP API surface)
**Prerequisite:** The Vex × Procur integration brief (`docs/procur-integration.md`) must be partly shipped — specifically the procur HTTP API surface, the `ProcurClient` in vex, and `ProcurEnrichmentAgent`.

---

## 1. What we're building, in one paragraph

A fourth integration touchpoint that mirrors campaign targeting (§3.3 of the parent brief) but flipped — sourcing **suppliers** for a known **buyer-side opportunity** rather than buyers for a supplier offer. When a public tender is published in procur and matches VTC's bid criteria (commodity, geography, volume), vex creates a queue entry. Operator reviews the queue, approves selectively. For approved tenders, vex calls procur's `find_suppliers_for_tender` plus a new geographic proximity query, ranks results in three tiers (refineries → traders → past winners), enriches each, and proposes outreach for VTC to assemble the supply side as bidder. **VTC bids the tender as principal, sourcing supply from the surfaced counterparties.** This is the highest-leverage flow for VTC's stated business because winning a public tender is a deal-now event with known specs and a known counterparty.

---

## 2. The strategic frame

The parent integration brief covers three flows that all start with "we have a supplier offer." This addendum covers the inverse flow: **we see a buyer's tender, we want to bid, we need suppliers.** This flow has different economics:

| Demand-side flow (parent §3.3) | Supply-side flow (this addendum) |
|---|---|
| Supplier comes to us; we shop the cargo | Buyer publishes tender; we assemble bid |
| Brokerage fee (Stage-1) or back-to-back margin (Stage-2) | Tender award + spread on supply contract (Stage-2 → Stage-3) |
| Risk: cargo may not place | Risk: tender may not award; supply may not be sourceable in time |
| Velocity: as fast as supplier offers come in | Velocity: gated by tender publication + bid windows |
| Counterparty discovery is the value | Counterparty discovery + supply chain assembly is the value |

The supply-side flow is where VTC moves from broker to principal trader. You're not just placing someone else's cargo — you're winning a contract you'll fulfill from your supplier network. That requires more orchestration but generates more durable revenue (recurring tender wins create stable demand, which lets you negotiate better supplier terms, which improves your bid economics, which wins more tenders — the principal-trader flywheel).

---

## 3. The three-tier supplier discovery model

When sourcing supply for a tender, the operator wants candidates ranked by **substitutability for the actual cargo, not relevance to similar tenders.** The right ranking is tiered by counterparty role:

### Tier 1 — Proximate refineries (production capability)

Physical refineries within 500 nautical miles of the tender's destination port that produce the requested commodity. These are the *origin* of the cargo. Pricing structure: refinery gate price + freight + margin. Proximity matters because freight cost is real (a 5,000 MT diesel cargo from Houston to DR is ~$0.04/L freight; from Singapore is ~$0.18/L).

Data source: `known_entities WHERE role IN ('refiner', 'producer') AND categories @> ARRAY[<commodity>]`, filtered by haversine distance to destination port lat/lng, ordered by distance.

**Why first:** if you can buy from the refinery directly, you capture the broker margin yourself. Stage-3 principal positioning starts here.

### Tier 2 — Proximate traders (commercial inventory)

Trading houses and distributors within ~2,000 NM of destination port that have won similar tenders historically OR appear in `known_entities` as `role = 'trader'`. These hold inventory or have near-term cargo positions — they don't produce, but they can deliver faster than a refinery turnaround.

Data source: union of (a) `known_entities WHERE role = 'trader'` near the port, and (b) `external_suppliers` with awards in matching category and country, weighted by recency × volume.

**Why second:** traders cost more (refinery margin + trader margin), but they can deliver on tight laycans where Tier 1 can't. For Stage-2 back-to-back trades this is often the right tier.

### Tier 3 — Past winners (regulatory + spec familiarity)

Any supplier who has won similar tenders globally in the last 3 years, regardless of proximity. Already in `find_suppliers_for_tender` output. These suppliers know the buyer's spec requirements, payment terms, documentation expectations, and have cleared their qualification process before.

Data source: `find_suppliers_for_tender` filtered to category match, ordered by past-tender count + recency.

**Why third:** when Tiers 1-2 don't yield enough qualified options, past winners are the safety net. They may not have the best price, but they can perform on the spec.

---

## 4. Three new schema additions

### 4.1 `packages/db/src/schema/tender-pursuits.ts` (vex)

```ts
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  doublePrecision,
} from 'drizzle-orm/pg-core';

/**
 * One row per public tender VTC is evaluating for bid. Created either
 * automatically by ProcurOpportunityWatcher (when procur publishes a
 * tender matching VTC bid criteria) or manually by an operator.
 *
 * Lifecycle:
 *   queued -> reviewing -> sourcing -> bid_drafted -> bid_submitted ->
 *     {awarded | lost | withdrawn | expired}
 *
 * Tenant-scoped — different vex tenants pursue different tenders.
 */
export const tenderPursuits = pgTable(
  'tender_pursuits',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),

    /** Procur opportunity reference. Format:
        'procur:<source_portal>:<source_opportunity_id>' so the link
        survives even if procur's internal IDs change. */
    procurOpportunityRef: text('procur_opportunity_ref').notNull(),
    /** Cached at insert time so vex doesn't have to round-trip procur
        for basic display data. Refreshed when stale. */
    snapshotPayload: jsonb('snapshot_payload').$type<Record<string, unknown>>().notNull(),

    /** Lifecycle state. */
    status: text('status').notNull().default('queued'),
    /** Why this entered the queue: 'auto_match' | 'manual_add'. */
    queueSource: text('queue_source').notNull(),

    /** Free-text operator notes (why pursuing, why skipping, etc.). */
    notes: text('notes'),

    /** Timestamps for SLA tracking. */
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    bidSubmittedAt: timestamp('bid_submitted_at', { withTimezone: true }),
    decisionAt: timestamp('decision_at', { withTimezone: true }),

    /** Owner — assigned operator. */
    ownerId: text('owner_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index('tender_pursuits_tenant_idx').on(t.tenantId),
    statusIdx: index('tender_pursuits_status_idx').on(t.tenantId, t.status),
    procurRefIdx: index('tender_pursuits_procur_ref_idx').on(t.procurOpportunityRef),
  }),
);

export type TenderPursuit = typeof tenderPursuits.$inferSelect;
export type NewTenderPursuit = typeof tenderPursuits.$inferInsert;
```

### 4.2 `packages/db/src/schema/tender-supplier-candidates.ts` (vex)

```ts
import {
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  integer,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';
import { tenderPursuits } from './tender-pursuits.js';

/**
 * One row per (tender_pursuit, supplier) pair. Captures the tier,
 * proximity, fit, and outreach state for each candidate supplier
 * surfaced for a tender.
 *
 * Lifecycle:
 *   surfaced -> approved | rejected -> contacted -> responded ->
 *     {quoted | declined | unresponsive}
 *
 * Tenant-scoped.
 */
export const tenderSupplierCandidates = pgTable(
  'tender_supplier_candidates',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),

    pursuitId: text('pursuit_id')
      .notNull()
      .references(() => tenderPursuits.id, { onDelete: 'cascade' }),

    /** Vex organization the candidate maps to. Created on demand. */
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    /** 1=refinery, 2=trader, 3=past_winner. */
    tier: integer('tier').notNull(),
    /** Why this candidate landed in the tier. */
    tierRationale: text('tier_rationale').notNull(),

    /** Distance from candidate's lat/lng to tender destination, in NM.
        Null when the candidate has no canonical location. */
    distanceNm: doublePrecision('distance_nm'),

    /** Composite score 0-100, higher = better fit for this tender.
        Computed by SupplierSourcingAgent. */
    fitScore: doublePrecision('fit_score'),
    /** Score breakdown for transparency. */
    fitBreakdown: jsonb('fit_breakdown').$type<{
      proximity: number;
      capability: number;
      recency: number;
      ofac: number;
      pricing: number;
    }>(),

    /** Lifecycle state. */
    status: text('status').notNull().default('surfaced'),

    /** Procur evidence used to justify inclusion (snapshot of
        procur intelligence at candidacy time). */
    procurEvidence: jsonb('procur_evidence').$type<Record<string, unknown>>(),

    /** Outreach trail — populated as the supplier gets contacted
        through the existing campaign engine. */
    contactedAt: timestamp('contacted_at', { withTimezone: true }),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    quotedPriceUsd: doublePrecision('quoted_price_usd'),
    quotedTerms: text('quoted_terms'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index('tender_supplier_candidates_tenant_idx').on(t.tenantId),
    pursuitIdx: index('tender_supplier_candidates_pursuit_idx').on(t.pursuitId),
    orgIdx: index('tender_supplier_candidates_org_idx').on(t.orgId),
    tierStatusIdx: index('tender_supplier_candidates_tier_status_idx').on(
      t.pursuitId, t.tier, t.status,
    ),
  }),
);

export type TenderSupplierCandidate = typeof tenderSupplierCandidates.$inferSelect;
export type NewTenderSupplierCandidate = typeof tenderSupplierCandidates.$inferInsert;
```

### 4.3 `packages/db/src/schema/bid-criteria.ts` (vex)

```ts
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  doublePrecision,
  boolean,
} from 'drizzle-orm/pg-core';

/**
 * VTC's bid criteria — the rules that determine which procur tenders
 * auto-fire into the queue. One row per active criterion. Multiple
 * rows compose with OR.
 *
 * Examples:
 *   { categoryTags: ['diesel'], destinationCountries: ['DO','JM','TT'],
 *     volumeMtMin: 1000, volumeMtMax: 50000, active: true }
 *   { categoryTags: ['gasoline','jet-fuel'],
 *     destinationCountries: ['DO'], volumeMtMin: 500, active: true }
 *
 * Tenant-scoped.
 */
export const bidCriteria = pgTable(
  'bid_criteria',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),

    /** Free-text label for the operator. */
    name: text('name').notNull(),

    /** Filter conditions. NULL = no constraint on that dimension. */
    categoryTags: text('category_tags').array(),
    destinationCountries: text('destination_countries').array(),
    sourcePortals: text('source_portals').array(),
    volumeMtMin: doublePrecision('volume_mt_min'),
    volumeMtMax: doublePrecision('volume_mt_max'),
    contractValueUsdMin: doublePrecision('contract_value_usd_min'),
    contractValueUsdMax: doublePrecision('contract_value_usd_max'),

    active: boolean('active').notNull().default(true),

    /** Free-form notes — why this criterion exists, who owns it. */
    notes: text('notes'),
    /** Where additional config goes — e.g. exclude specific buyers,
        require specific incoterm, etc. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantActiveIdx: index('bid_criteria_tenant_active_idx').on(t.tenantId, t.active),
  }),
);

export type BidCriterion = typeof bidCriteria.$inferSelect;
export type NewBidCriterion = typeof bidCriteria.$inferInsert;
```

---

## 5. New procur HTTP endpoints (one new, one extension)

### 5.1 NEW: `GET /intelligence/proximity-suppliers`

Wraps a new procur query function `findSuppliersByProximity`. Used for Tier 1 + Tier 2 of the three-tier ranking.

**Query params:**
- `category_tag` (required) — internal commodity tag
- `destination_lat`, `destination_lon` (required) — port coordinates
- `radius_nm` (default: 500 for refineries, 2000 for traders)
- `roles` (default: `producer,refiner,trader`) — comma-separated
- `categories_filter` (optional) — additional category constraint
- `limit` (default: 30)

**Response shape:**
```json
{
  "candidates": [
    {
      "knownEntityId": "uuid",
      "slug": "eni-sannazzaro-refinery",
      "name": "Eni Sannazzaro Refinery",
      "country": "IT",
      "role": "refiner",
      "categories": ["diesel","gasoline","jet-fuel"],
      "tags": ["mediterranean-refiner","sweet-crude-runner"],
      "latitude": 45.0904,
      "longitude": 8.9183,
      "distanceNm": 312.5,
      "notes": "...",
      "contactEntity": "...",
      "matchReason": "refiner-within-500nm-with-diesel-capability"
    }
  ],
  "totalCount": 18,
  "query": {
    "destinationLat": 18.4361,
    "destinationLon": -69.6181,
    "radiusNm": 500,
    "roles": ["producer","refiner"],
    "categoryTag": "diesel"
  }
}
```

**Implementation in procur** (new file `packages/catalog/src/queries/proximity-suppliers.ts`):

```ts
export interface ProximitySuppliersSpec {
  categoryTag: string;
  destinationLat: number;
  destinationLon: number;
  radiusNm?: number;
  roles?: ('producer' | 'refiner' | 'trader' | 'buyer' | 'seller')[];
  categoriesFilter?: string[];
  limit?: number;
}

export async function findSuppliersByProximity(
  spec: ProximitySuppliersSpec,
): Promise<ProximityCandidate[]> {
  /*
   * Implementation uses haversine distance via the standard
   * formula. PostgreSQL has no native haversine but the math is:
   *
   * 3440.065 * acos(
   *   cos(radians(dest_lat)) * cos(radians(lat)) *
   *   cos(radians(lon) - radians(dest_lon)) +
   *   sin(radians(dest_lat)) * sin(radians(lat))
   * )
   *
   * (3440.065 is Earth's radius in nautical miles)
   *
   * Using a CTE:
   *   WITH candidates_with_distance AS (
   *     SELECT *,
   *       3440.065 * acos(
   *         cos(radians(:destLat)) * cos(radians(latitude)) *
   *         cos(radians(longitude) - radians(:destLon)) +
   *         sin(radians(:destLat)) * sin(radians(latitude))
   *       ) AS distance_nm
   *     FROM known_entities
   *     WHERE role = ANY(:roles)
   *       AND :categoryTag = ANY(categories)
   *       AND latitude IS NOT NULL
   *       AND longitude IS NOT NULL
   *   )
   *   SELECT * FROM candidates_with_distance
   *   WHERE distance_nm <= :radiusNm
   *   ORDER BY distance_nm
   *   LIMIT :limit
   *
   * Note: this is a full table scan, but known_entities is small
   * (likely <10K rows for years). If it grows past 100K, add a
   * PostGIS GIST index on a geography column.
   */
}
```

### 5.2 EXTENSION: existing `find_suppliers_for_tender` adds an `originBias` parameter

The existing tool returns past winners globally. Add an optional `originBias: { lat, lon, weightFactor }` parameter that boosts candidates whose `external_suppliers.country` resolves to a country with low freight distance to the bias point. Implementation: country centroids in a lookup table, haversine to bias, multiply ranking score by `(1 - distance / max_distance) * weightFactor`.

This is for Tier 3 ranking — past winners get scored higher when they're proximate to the destination, but still surface even when far away because the spec familiarity matters.

---

## 6. New vex agents (three)

### 6.1 `ProcurOpportunityWatcher` — auto-queue agent (T1)

```ts
import type { IAgent, AgentContext, AgentOutput } from './types.js';

export interface ProcurOpportunityWatcherInput {
  /** Look back this many minutes for new procur opportunities.
      Default 60 (assumes the agent runs every 30-60 minutes). */
  lookbackMinutes?: number;
}

export class ProcurOpportunityWatcher implements IAgent {
  readonly name = 'procur-opportunity-watcher';
  readonly tier = 'T1' as const;  // T1 internal writes only — creates
                                   // queue entries; doesn't contact anyone

  constructor(private readonly input: ProcurOpportunityWatcherInput) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    /*
     * 1. Load active bid_criteria for this tenant
     * 2. Call procur GET /intelligence/opportunities/recent
     *    (NEW endpoint — see §6.4 below) with lookbackMinutes
     *    and a flat union of all categoryTags / countries / volume
     *    bounds across criteria
     * 3. Procur returns matching opportunities (deduplicated)
     * 4. For each, evaluate against each individual bid_criterion;
     *    if any matches, create a tender_pursuit with status=queued,
     *    queueSource=auto_match
     * 5. Skip if a tender_pursuit already exists for the
     *    procur_opportunity_ref (idempotent)
     * 6. Emit a signal for the operator on each new queue entry
     */
  }
}
```

Scheduled via existing AgentScanner pattern, every 30 min during business hours.

### 6.2 `SupplierSourcingAgent` — tier-ranked discovery + enrollment (T2)

```ts
import type { IAgent, AgentContext, AgentOutput } from './types.js';

export interface SupplierSourcingInput {
  pursuitId: string;
  /** Operator selection — which tiers to source. Empty = all 3. */
  tierFilter?: number[];
  /** Operator selection — which counterparty roles to include. */
  roleFilter?: string[];
  /** Max candidates per tier to surface. Default 10. */
  maxPerTier?: number;
  /** Initiating operator — used for approval routing. */
  initiatedBy: string;
}

export class SupplierSourcingAgent implements IAgent {
  readonly name = 'supplier-sourcing';
  readonly tier = 'T2' as const;  // T2 because it leads to outbound
                                   // contact — requires approval gate

  constructor(private readonly input: SupplierSourcingInput) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    /*
     * 1. Load tender_pursuit + procur opportunity snapshot
     * 2. Resolve tender's destination port lat/lng (from procur
     *    opportunity snapshot, or by joining against
     *    procur known_entities for named ports)
     * 3. Resolve tender's primary commodity to internal category_tag
     *
     * --- TIER 1: refineries within 500nm ---
     * 4. Call procur GET /intelligence/proximity-suppliers with
     *    roles=producer,refiner, radius=500
     * 5. For each result, resolve to a vex organization (existing
     *    upsert pattern). Schedule ProcurEnrichmentAgent.
     *    Schedule OfacScreeningAgent.
     * 6. Compute fit score (proximity, capability, recency, OFAC,
     *    historical pricing). Insert tender_supplier_candidates
     *    with tier=1.
     *
     * --- TIER 2: traders within 2000nm ---
     * 7. Call procur GET /intelligence/proximity-suppliers with
     *    roles=trader, radius=2000
     * 8. Same enrichment + scoring loop. Insert with tier=2.
     *
     * --- TIER 3: past tender winners (any geography) ---
     * 9. Call procur POST /intelligence/find-suppliers-for-tender
     *    with the opportunity ID, originBias set to destination
     *    lat/lng.
     * 10. Same enrichment + scoring loop. Insert with tier=3.
     *
     * --- DEDUP + APPROVAL ---
     * 11. If a candidate org appears in multiple tiers, keep the
     *     lowest tier (closer to source) and merge tierRationale.
     * 12. Emit a single approval-gate action with all surfaced
     *     candidates grouped by tier. Operator reviews per-tier.
     *     Approval approves a subset for outreach.
     * 13. On approval: enroll approved candidates in the tender
     *     outreach campaign (using existing campaign engine).
     */
  }
}
```

### 6.3 `TenderBidEvaluatorAgent` — assemble bid from quotes (T1, optional v1.5)

```ts
/**
 * After supplier outreach surfaces 1+ quotes, this agent assembles
 * a recommended VTC bid: aggregates quotes by best-price + risk
 * tier, computes implied VTC margin, surfaces fit vs tender deadline.
 *
 * Triggered on operator request after multiple
 * tender_supplier_candidates have status='quoted'.
 *
 * Out of scope for v1 — defer until Stage-2 deals are flowing.
 * Listed here for completeness so it's not forgotten.
 */
```

### 6.4 EXTENSION: new procur endpoint `GET /intelligence/opportunities/recent`

New procur HTTP route consumed by ProcurOpportunityWatcher:

```
GET /intelligence/opportunities/recent
  ?since=<iso8601>
  &category_tags=<comma-list>
  &beneficiary_countries=<comma-list>
  &volume_mt_min=<num>&volume_mt_max=<num>
  &limit=<num>
```

Wraps a thin SQL query against the existing `opportunities` table:

```sql
SELECT id, source_portal, source_opportunity_id, title,
       beneficiary_country, category_tags, volume_mt,
       contract_value_usd, deadline_at, published_at, ...
FROM opportunities
WHERE published_at >= $1
  AND ($2 IS NULL OR category_tags && $2)
  AND ($3 IS NULL OR beneficiary_country = ANY($3))
  AND ($4 IS NULL OR volume_mt >= $4)
  AND ($5 IS NULL OR volume_mt <= $5)
ORDER BY published_at DESC
LIMIT $6;
```

---

## 7. Surface in vex API and chat

### 7.1 New API routes

```
GET    /api/tender-pursuits                       -> list queue
GET    /api/tender-pursuits/:id                   -> single pursuit + candidates
POST   /api/tender-pursuits                       -> manual add
PATCH  /api/tender-pursuits/:id                   -> update status, owner, notes
POST   /api/tender-pursuits/:id/source-suppliers  -> trigger SupplierSourcingAgent

GET    /api/bid-criteria                          -> list active criteria
POST   /api/bid-criteria                          -> add new criterion
PATCH  /api/bid-criteria/:id                      -> update / activate / deactivate

GET    /api/tender-supplier-candidates?pursuitId=...&tier=...
PATCH  /api/tender-supplier-candidates/:id        -> approve / reject / record quote
```

### 7.2 Chat surface

| Operator says | Result |
|---|---|
| "Show me the tender queue" | Lists all `tender_pursuits` with status=queued or reviewing |
| "Pursue [tender title]" | Updates pursuit status to `sourcing`; triggers `SupplierSourcingAgent` |
| "Source refineries only for [tender]" | Same agent with `tierFilter=[1]` |
| "Skip / decline [tender]" | Status to `withdrawn` with operator note |
| "Add bid criteria for diesel CIF Caribbean 1000-50000 MT" | Creates a new `bid_criteria` row |
| "Show candidates for [tender]" | Lists `tender_supplier_candidates` grouped by tier |
| "Approve all tier 1 candidates for [tender]" | Bulk-approves; triggers campaign enrollment |
| "Record quote: [supplier] $0.62/L USG, ULSD 50ppm, FOB Houston" | Updates a candidate row with quoted data |

### 7.3 UI surface (apps/web)

Three new components:

- **Tender Queue page** — table of pursuits, filterable by status/owner/category. Each row shows commodity, buyer, country, volume, deadline, source portal, current state. Action buttons: "Pursue," "Skip," "View."
- **Tender Pursuit detail page** — opportunity snapshot at top, three-tier candidate columns (refineries / traders / past winners), each candidate shows distance + fit + procur summary + OFAC status. Approve checkboxes per tier; bulk-approve button.
- **Bid Criteria settings page** — list of active criteria, add/edit/disable.

---

## 8. Outbound messaging — supply-side cold email

The outbound emails are different from the demand-side flow because the message *frames the supplier as the seller VTC wants to buy from*, not the buyer VTC wants to introduce a cargo to.

Updated prompt template (extends the parent brief's §7):

```
You are drafting a cold-outreach email to [supplier contact] at [supplier org].

Context: VTC is bidding on a public tender (buyer: [agency], country:
[country], commodity: [commodity], volume: [volume], laycan: [laycan],
incoterm: [incoterm], deadline: [bid_deadline]).

Procur intelligence about this supplier:
- Role: [refiner | trader | past winner]
- Recent activity: [N awards, $X total in last M months]
- Capability: [categories, vessel size capacity if known]
- Geographic position: [distance from tender destination, NM]
- Distress signal: [yes/no, with details if yes]

Procur intelligence about the buyer:
- Historical pricing pattern: typical Caribbean diesel award averages
  +X% over NY Harbor ULSD (n=Y, σ=Z)
- Buyer's average contract size: $X
- Buyer's payment terms history: [if known]

Draft a 5-sentence email that:
1. Opens with VTC's specific bid context (not "we're a Houston-based
   commodity trader" — that's noise)
2. Names the tender concretely (buyer + commodity + volume + laycan)
3. References something specific from the procur intelligence about
   the supplier — their recent activity, their geographic position,
   or a recent capability fact
4. Asks a concrete question that invites a quote (price, laycan
   feasibility, terms)
5. Specifies the bid deadline (this creates urgency — the supplier
   knows VTC is on the clock)

Tone: professional, time-sensitive, peer-level. Not a request for
relationship-building — VTC has a specific deal in front of them and
needs a quote to compose a bid.

NEVER mention Cuba, NEVER mention Vector Antilles routing, NEVER imply
the bid is for a sanctioned-market customer. The supplier sees only
the bid mechanics.
```

The result reads like:

> Subject: Diesel quote — DR Min Defense tender, 12,000 MT CIF Caucedo, bid deadline May 15
>
> [Contact] —
>
> VTC is bidding on the DR Ministry of Defense diesel tender published 28 Apr (12,000 MT, ULSD 50ppm, CIF Caucedo, laycan 1-15 June). Your operation has averaged 8,400 MT diesel awards in the DR/Caribbean over the last 12 months from facilities ~340 NM from Caucedo — natural fit for this cargo's economics.
>
> Could you quote FOB origin price + freight to Caucedo for ULSD meeting DR spec, with payment terms LC at sight or 30-day open account against confirmed BL? Bid materials are due 15 May, so a Friday quote would let us include you in the responsive supplier list.
>
> Happy to send the full tender package and discuss volume tolerance / laycan flexibility.
>
> [Operator] / Vector Trade Capital

That's grounded ("you've averaged 8,400 MT in DR/Caribbean over 12 months from facilities ~340 NM"), specific (the actual tender), and time-bound (deadline is real). Worlds different from generic supplier outreach.

---

## 9. Approval gates

This workflow has more approval surfaces than the demand-side because more contact points fan out to more counterparties:

| Stage | Tier | Approval needed? |
|---|---|---|
| Auto-queue from procur opportunity | T1 | No — internal write only |
| Manual queue add | T1 | No — operator initiated |
| Pursue decision (queued → sourcing) | T1 | No — operator initiated |
| Run SupplierSourcingAgent | T2 | **Yes** — surfaces candidates for outreach |
| Enroll approved candidates in campaign | T2 | **Yes** — triggers email send |
| Record quote response | T1 | No — operator data entry |

Both approval steps land in the existing approval-gate UI. The operator sees the proposed candidate list (per tier, with procur summaries) and the proposed campaign enrollments (with email previews).

---

## 10. Implementation order

1. **Procur-side schema confirmation** — verify `known_entities` has lat/lng populated for the entity universe relevant to VTC's bid criteria. Currently 0/0 unknown. May need a backfill pass (research script + manual curation). ~1 day.
2. **Procur HTTP endpoint: `proximity-suppliers`** — wraps the new query function. ~0.5 day.
3. **Procur HTTP endpoint: `opportunities/recent`** — wraps existing `opportunities` table. ~0.25 day.
4. **Procur extension: `find_suppliers_for_tender` originBias** — add the parameter. ~0.5 day.
5. **Vex schema: 3 new tables (`tender_pursuits`, `tender_supplier_candidates`, `bid_criteria`)** — hand-author migrations. ~0.5 day.
6. **Vex client: extend `ProcurClient` with `findSuppliersByProximity` and `getRecentOpportunities`** — straight wrap. ~0.25 day.
7. **`ProcurOpportunityWatcher` agent** — daily cron, auto-queue. ~0.5 day.
8. **`SupplierSourcingAgent` agent** — the orchestrator, three-tier discovery. ~1 day.
9. **API routes (3)** — pursuits, candidates, bid criteria. ~0.5 day.
10. **UI components (3 pages)** — tender queue, pursuit detail, bid criteria settings. ~1.5 days.
11. **Prompt template** — supply-side cold email. ~0.25 day.
12. **Tests** — fixtures for both flows, integration test for full pursuit lifecycle. ~1 day.

**Total: ~7-8 days.** Most is in vex; ~1.5 days in procur. Can ship alongside or after the parent integration brief.

---

## 11. The end-to-end playbook this enables

Concrete walkthrough.

**Trigger (auto):** Tuesday morning. Procur publishes 4 new opportunities matching VTC bid criteria. ProcurOpportunityWatcher runs, creates 4 `tender_pursuits` with status=queued, emits 4 signals.

**Operator (Wednesday morning):** Opens vex, sees the queue. 4 entries:

1. *DR Min Defense — 12,000 MT diesel CIF Caucedo, deadline May 15*
2. *Jamaica Public Service — 8,000 MT HFO CIF Kingston, deadline May 12*
3. *Bahamas Power — 4,000 MT diesel CIF Freeport, deadline May 10*
4. *T&T Petrotrin replacement entity — 25,000 MT gasoline FOB Pointe-à-Pierre, deadline May 20*

Reviews. Decides:
- DR Defense → pursue (good fit, large volume)
- Jamaica HFO → pursue (margin opportunity in HFO)
- Bahamas → skip (too small to bid)
- Trinidad → defer (FOB at Pointe-à-Pierre is a complex sourcing puzzle)

**Operator (action):** "Pursue DR Defense — source all tiers."

**SupplierSourcingAgent runs** (Wednesday afternoon):

- Tier 1 (refineries within 500 NM of Caucedo): finds 3 candidates — Petrojam Refinery (Jamaica, 412 NM), Refidomsa San Pedro (DR, 145 NM), TotalEnergies Pointe-à-Pierre (T&T, 487 NM). Refidomsa is *the* DR refinery. Petrojam handles HFO mostly. TotalEnergies handles regional supply.
- Tier 2 (traders within 2,000 NM): finds 12 candidates — Trafigura Houston, Vitol Houston, Mercuria Houston, Glencore Stamford, P66 Houston, several Caribbean-based traders.
- Tier 3 (past winners of similar Caribbean diesel tenders): finds 18 candidates with the originBias scoring boosting Houston-based and Caribbean traders.

After dedup, ~28 unique candidates surface. SupplierSourcingAgent enriches each via procur, OFAC-screens each, fit-scores each. Surfaces approval gate.

**Operator (Wednesday end-of-day):** Reviews approval gate. Approves all 3 Tier 1 (refineries always go in), 4 Tier 2 (Trafigura, Vitol, Mercuria, P66), 6 Tier 3 (past winners with strong recent activity). Total: 13 outbound emails.

**Vex campaign engine fires.** Each email is personalized using procur intelligence — refinery emails reference proximity, trader emails reference recent volume, past-winner emails reference past tender wins.

**Thursday + Friday:** 9 of 13 contacts respond. 6 send quotes (2 refineries, 3 traders, 1 past winner). 3 decline (capacity, OFAC concern, deadline too tight).

**Operator (Friday):** Reviews quotes in vex. Records each quote in `tender_supplier_candidates`. The lowest cost-stack option is Refidomsa direct (FOB San Pedro) at $0.58/L + small barge to Caucedo. Trafigura Houston at $0.62/L FOB + freight to DR comes in second.

**Operator (Monday):** Drafts the bid using the cost-stack data. VTC bids at $0.71/L CIF Caucedo (Refidomsa cost + freight + margin). DealMarketContextAgent fires on the draft bid → procur evaluates: NY Harbor ULSD spot $0.62/L, historical Caribbean diesel premium 25%, this bid at +14% over benchmark adjusted for Caribbean delta, z-score = -0.8 → verdict: `competitive`.

**Operator submits the bid.** Tender awards in 2 weeks. If VTC wins, the supplier candidates whose quotes were used get marked as `won`; their `supplier_signals` table starts populating with realized counterparty behavior data.

**Total elapsed time, supplier discovery to bid submission:** 7 days. Without this workflow, the same exercise would take 3-4 weeks of manual research and cold calling, with a much smaller candidate pool.

---

## 12. What this addendum deliberately doesn't do

- **No automated bid composition.** VTC submits bids; vex assembles supplier quotes but the operator drafts the actual bid response. Automation here is premature — bid composition is too counterparty-specific.
- **No bidirectional data flow.** Quotes recorded in vex stay in vex. Procur never sees realized supplier pricing. (Future v2 may surface aggregated, anonymized quote data back into procur's `supplier_signals` — separate brief.)
- **No tender pricing prediction.** Vex doesn't forecast tender clearing prices. The DealMarketContextAgent already gives empirical context; that's enough for v1.
- **No automatic supplier disqualification.** OFAC screening alerts the operator; the operator decides. Auto-rejecting suppliers based on procur signals risks false positives that harm relationships.
- **No multi-tender bundling.** Each tender pursued independently. Bundling (bidding 3 tenders with overlapping supply) is a Stage-3 trader move — out of scope.
- **No win-rate analytics.** When tender outcomes start populating, a `bid_outcomes` analytics layer becomes useful (which suppliers contributed to wins, which campaigns converted best). v1.5 brief.

---

## 13. Source notes — the strategic upgrade this represents

This addendum is what moves VTC from broker to principal trader. Concretely:

- **Stage-1 broker** = supplier offers come in, you place them with buyers, you take a fee
- **Stage-2 back-to-back** = you take title briefly, the demand-side flow in the parent brief covers this
- **Stage-3 principal trader** = you bid on tenders, win contracts, source supply yourself, fulfill at margin

Stage-3 requires sourcing infrastructure that doesn't exist outside this brief. Without supplier-graph + proximity intelligence + tier discovery, "winning a public tender" devolves to "calling people you already know." That's how most small commodity traders stay small — they win the tenders their existing relationships can supply, and they can't grow beyond their relationship reach. With this infrastructure, every public tender becomes an opportunity to expand the supplier network *while* winning a contract. Each win creates relationships. Each relationship feeds future bids. The flywheel for principal trading is here.

---

End of brief.
