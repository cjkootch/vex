> **IMPLEMENTATION STATUS — refreshed 2026-04-29**
>
> **Status: foundation shipped, three of four touchpoints in flight.**
>
> Shipped:
> - `packages/integrations/procur.ts` ProcurClient with caching, retry, telemetry (vex Slice 1.0, PR #237)
> - `procur_intelligence_snapshots` schema (vex)
> - `fuel_deal_market_context` schema (vex)
> - `/admin/procur/healthcheck` endpoint + web proxy (Slice 1.2/1.3)
> - `POST /ingest/procur/leads` — vex receives operator pushes from procur (Slice 1.4)
> - Contact enrichments push back to procur (Slice 1.5) — *this is bidirectional flow that the brief explicitly deferred*; a constrained version was built because contact-quality data flowing both ways was found to be high-value enough to justify earlier
> - `org.update_fields` action for patching org fields from procur research
> - Procur-side: all 11 HTTP endpoints under `/api/intelligence/*` live behind `PROCUR_API_TOKEN`, Clerk bypass configured
> - Procur-side: `entity-contact-enrichments` table receives the Slice 1.5 pushback
>
> Pending:
> - **Touchpoint 1** (counterparty enrichment via `ProcurEnrichmentAgent`) — schema shipped, agent execution not yet wired into the campaign flow at the orchestration level
> - **Touchpoint 2** (deal-context evaluation via `DealMarketContextAgent`) — `fuel_deal_market_context` schema shipped, agent not yet running on draft→live transitions
> - **Touchpoint 3** (campaign targeting via `CampaignTargetingAgent`) — not yet implemented
>
> **Divergence from brief:** the bidirectional contact-enrichment flow was specifically called out in §11 of the original brief as not in v1 scope. Operational experience showed it was high-value enough to ship early. The privacy boundary called out in the original brief still holds — only contact-quality data flows back, not deal outcomes or pricing — so the architectural integrity is intact.
>
> The original 7-day estimate is on track; about 4 days of work remain to wire the three orchestration agents.
>
> ---

# Vex × Procur Intelligence Integration

**Status:** spec, not yet implemented
**Owner:** Cole
**Last updated:** 2026-04-28
**Repos:** `cjkootch/vex` (this brief lives here as `docs/procur-integration.md`) and `cjkootch/procur_dashboard` (mirror committed there for cross-team visibility)
**Prerequisite:** Procur supplier graph + intelligence layers + pricing analytics briefs must be partly shipped (specifically: `awards`, `external_suppliers`, `commodity_prices`, `award_price_deltas` materialized view, and the three reverse-search assistant tools).

---

## 1. What we're building, in one paragraph

Vex stays the execution platform. Procur stays the intelligence warehouse. Three new integration agents in Vex pull procur data into the deal lifecycle at three specific moments: **counterparty enrichment** (when an org is created, hydrate it with award history + capability + distress signals), **deal evaluation** (when a fuel deal is drafted, score the offer against historical delta-vs-spot distribution), and **campaign targeting** (when a supplier offer comes in, hydrate the campaign with ranked candidate buyers from the supplier graph). The boundary is one-way: procur → vex. Vex's private behavioral data (RFQ responses, deal closes, OFAC clears) stays in vex. Procur stays multi-tenant-public-data; vex stays single-tenant-private-deal.

---

## 2. The architectural insight

Reading vex's existing schema carefully reveals that the integration is much smaller than a naive build would assume. Most of what someone would build "for outreach" is **already in vex**:

| Vex already has | Maps to / informed by procur's |
|---|---|
| `organizations` (with `kind`, `fitScore`, `tags`, `fieldConfidence`, `externalKeys`) | `external_suppliers`, `known_entities`, `entity_news_events` |
| `fuel_deal_counterparty_scores` (8-dimension risk) | award history, distress signals, ownership graph |
| `signals` (proactive alert table) | `award_price_deltas` outliers, `find_distressed_suppliers` results |
| `campaigns` + `campaign_steps` + `campaign_enrollments` | `find_buyers_for_offer`, `find_suppliers_for_tender` outputs |
| `touchpoints`, `summaries` | `entity_news_events`, `port_calls` for an entity |
| `freight_rates`, `vessels`, `ports`, `port_events` | `customs_imports`, `vessel_positions`, `port_calls` |
| `ResearchAgent` (builds evidence packs from touchpoints + LLM) | natural extension point — adds procur intelligence to evidence pack |
| `LeadQualificationAgent`, `DealEvaluatorAgent`, `FollowUpAgent` | already shaped to consume external evidence |

The integration is **not** "build a campaign engine that pulls procur data." It is "wire procur data into the existing campaign engine." The work is small, surgical, and respects vex's existing primitives.

---

## 3. The three integration touchpoints

### 3.1 Counterparty enrichment (procur intelligence as evidence)

**When:** vex creates or updates an `organizations` row, or `ResearchAgent` runs against an existing org.

**What:** vex calls procur's existing assistant tools (`analyze_supplier`, `find_recent_cargoes`, `analyze_supplier_pricing`) for the named entity, gets back structured intelligence, and writes it into:
- `organizations.tags` — e.g. `procur:fuel_supplier`, `procur:high_award_velocity`, `procur:distress_signal_2026q1`
- `organizations.fieldConfidence` — country, kind, geo updated with procur evidence
- `summaries` — new summary type `procur_intelligence_brief` with the structured payload
- `signals` — proactive alerts when procur surfaces something the operator should know

**Specifics**: The `ResearchAgent` already builds `evidencePack` from internal touchpoints. Extend it to also include a `procur` evidence section. The system prompt then instructs the LLM to produce a research brief that incorporates procur findings.

### 3.2 Deal-context evaluation (offer scoring against history)

**When:** a `fuel_deals` row transitions from `draft` to `live` (or upon explicit operator request).

**What:** vex calls procur's `evaluate_offer_against_history` with the deal's product, grade, destination country, and offered price. Gets back z-score, percentile, verdict (`aggressive | competitive | fair | high | outlier_high`), historical sample size, and rationale. Writes it into:
- A new `fuel_deal_market_context` table (this brief introduces it)
- `fuel_deal_counterparty_scores` — specifically `paymentHistoryRisk` and `creditRisk` informed by counterparty's procur history
- `signals` — proactive alert if verdict is `outlier_high` or sample size is too small for confidence

**Specifics**: This is a new agent — `DealMarketContextAgent` (T1 read + internal write, similar tier to `DealEvaluator`). Runs once per deal at draft→live transition; idempotent on re-run.

### 3.3 Campaign targeting (supplier offer → buyer rolodex → campaign enrollment)

**When:** an operator describes a supplier offer in vex chat or via API, e.g. *"5,000 MT diesel CIF Caucedo from supplier X."*

**What:** vex calls procur's `find_buyers_for_offer` with the commodity, geography, and tolerances. Gets back ranked candidate buyers. For each buyer, vex:
1. Looks up or creates an `organizations` row
2. Runs counterparty enrichment (3.1) to hydrate
3. Runs OFAC screening via existing `OfacScreeningAgent`
4. Scores fit using the existing `LeadQualificationAgent`
5. For high-fit, OFAC-clear orgs: creates a lead, enrolls in the campaign

**Specifics**: This is a new agent — `CampaignTargetingAgent` — that orchestrates the existing agents. The user-facing surface is a vex chat command or a campaign creation flow ("create campaign from procur offer"). The agent returns a list of proposed enrollments which the operator approves before campaign emails fire.

---

## 4. The procur API surface (minimal HTTP read API)

Procur currently exposes its data through assistant tools registered in `packages/catalog/src/tools.ts`. For vex consumption, we need a small **HTTP read API** that wraps those same query functions. This is *not* a new query layer; it's a thin HTTP veneer over the existing query module.

**New routes in procur, all under `apps/app/app/api/intelligence/`:**

```
GET  /intelligence/supplier/:idOrName           -> analyze_supplier output
GET  /intelligence/supplier/:idOrName/pricing   -> analyze_supplier_pricing output
GET  /intelligence/cargoes                      -> find_recent_cargoes output
GET  /intelligence/distressed-suppliers         -> find_distressed_suppliers output
POST /intelligence/find-buyers                  -> find_buyers_for_offer output
POST /intelligence/find-suppliers-for-tender    -> find_suppliers_for_tender output
POST /intelligence/evaluate-offer               -> evaluate_offer_against_history output
GET  /intelligence/buyer-pricing                -> analyze_buyer_pricing output
GET  /intelligence/entity-news/:entitySlug      -> entity_news_events for an entity
```

**Auth model**: Service-to-service via shared secret. Procur issues a long-lived API token, vex stores it as `PROCUR_API_TOKEN` env, sends as `Authorization: Bearer <token>`. Procur validates the token + rate-limits the caller.

**Why HTTP and not direct DB access**: vex and procur have different Neon databases, different deploy pipelines, different scaling profiles, and procur's data is multi-tenant-public while vex's is single-tenant-private. A clean HTTP boundary keeps both repos independently deployable. Direct DB federation would couple them in ways neither needs.

**Why not gRPC / GraphQL**: REST + JSON is sufficient at this volume (~hundreds of calls/day from vex to procur). Premature optimization to add gRPC.

**Latency budget**: each procur query returns in <200ms (materialized views are pre-computed). The integration agents are async (Temporal workflows), so a 200ms procur call is invisible.

---

## 5. New vex packages and modules

### 5.1 `packages/integrations/src/procur.ts`

A thin client wrapping the procur HTTP API. Mirrors the pattern of `anthropic.ts`, `tavily.ts`, etc.

```ts
import 'server-only';
import type { Logger } from '@vex/telemetry';

export interface ProcurClientConfig {
  baseUrl: string;
  apiToken: string;
  logger: Logger;
  timeoutMs?: number;
}

export interface SupplierAnalysisResult {
  kind: 'profile' | 'disambiguation_needed' | 'not_found';
  // ... see procur's analyze_supplier tool response shape
}

export interface RecentCargoesResult { /* ... */ }
export interface OfferEvaluationResult { /* ... */ }
export interface FindBuyersResult { /* ... */ }
// ... etc.

export class ProcurClient {
  constructor(private readonly config: ProcurClientConfig) {}

  async analyzeSupplier(args: {
    supplierId?: string;
    supplierName?: string;
    yearsLookback?: number;
  }): Promise<SupplierAnalysisResult> { /* ... */ }

  async analyzeSupplierPricing(args: {
    supplierId?: string;
    supplierName?: string;
    minConfidence?: number;
    yearsLookback?: number;
    categoryFilter?: string;
  }): Promise<SupplierPricingAnalysisResult> { /* ... */ }

  async findRecentCargoes(args: {
    destinationCountry?: string;
    destinationEntitySlug?: string;
    originCountry?: string;
    vesselCategory?: string;
    daysLookback?: number;
    minConfidence?: number;
  }): Promise<RecentCargoesResult> { /* ... */ }

  async evaluateOffer(args: {
    categoryTag: string;
    grade?: string;
    buyerCountry: string;
    offeredPriceUsd: number;
    offeredPriceUnit: string;
    evaluationDate?: string;
  }): Promise<OfferEvaluationResult> { /* ... */ }

  async findBuyersForOffer(args: {
    categoryTag: string;
    descriptionKeywords?: string[];
    buyerCountries?: string[];
    yearsLookback?: number;
    minAwards?: number;
    limit?: number;
  }): Promise<FindBuyersResult> { /* ... */ }

  async findDistressedSuppliers(args: {
    categoryTag?: string;
    countries?: string[];
    minPrevAwards?: number;
    velocityChangeMax?: number;
  }): Promise<FindDistressedSuppliersResult> { /* ... */ }

  // Caching strategy: in-memory TTL cache, 5 min for entity-scoped reads
  // (analyzeSupplier, analyzeBuyerPricing) since procur data refreshes
  // nightly. No caching on offer evaluation (always uses fresh spot price).
}
```

### 5.2 `packages/db/src/schema/procur-intelligence-snapshots.ts`

A new sidecar table. When vex retrieves procur intelligence for an org, it caches the result here so subsequent agent runs don't re-call procur unnecessarily, and so that the data is queryable from vex without a procur round-trip.

```ts
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';

/**
 * Cached procur intelligence per organization. Refreshed by the
 * ProcurEnrichmentAgent on a TTL (default 7 days) or on explicit
 * operator request.
 *
 * Each snapshot carries:
 *   - the procur tool that produced it (analyze_supplier,
 *     analyze_supplier_pricing, find_recent_cargoes, etc.)
 *   - the structured response payload
 *   - a fetched_at timestamp (for staleness checks)
 *
 * Tenant-scoped despite being public-data underneath because vex's
 * tenant boundary is the security model — different vex tenants
 * shouldn't see each other's choice of which orgs they enriched.
 */
export const procurIntelligenceSnapshots = pgTable(
  'procur_intelligence_snapshots',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    /** Which procur tool produced this snapshot. */
    procurTool: text('procur_tool').notNull(),
    /** Free-form key — typically the input args hashed. Used for
        idempotency on re-fetch. */
    queryHash: text('query_hash').notNull(),
    /** Procur's response payload, verbatim. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),

    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    /** When this snapshot should be considered stale and re-fetched. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    tenantOrgToolIdx: index('procur_snapshots_tenant_org_tool_idx').on(
      t.tenantId,
      t.orgId,
      t.procurTool,
    ),
    expiresIdx: index('procur_snapshots_expires_idx').on(t.expiresAt),
  }),
);

export type ProcurIntelligenceSnapshot = typeof procurIntelligenceSnapshots.$inferSelect;
export type NewProcurIntelligenceSnapshot = typeof procurIntelligenceSnapshots.$inferInsert;
```

### 5.3 `packages/db/src/schema/fuel-deal-market-context.ts`

A new table holding the procur-sourced market context for each deal.

```ts
import {
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { fuelDeals } from './fuel-deals.js';

/**
 * Procur-sourced market context for a fuel deal. Populated by
 * DealMarketContextAgent at draft→live transition. One row per deal.
 *
 * Distinct from fuel_market_rates (which carries operator-managed
 * pricing references). This is empirically-derived from procur's
 * award_price_deltas distribution.
 */
export const fuelDealMarketContext = pgTable(
  'fuel_deal_market_context',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    dealId: text('deal_id')
      .notNull()
      .references(() => fuelDeals.id, { onDelete: 'cascade' }),

    benchmarkCode: text('benchmark_code').notNull(),
    benchmarkSpotUsd: doublePrecision('benchmark_spot_usd'),
    effectiveBenchmarkUsd: doublePrecision('effective_benchmark_usd'),

    offerDeltaUsd: doublePrecision('offer_delta_usd'),
    offerDeltaPct: doublePrecision('offer_delta_pct'),

    historicalMeanDeltaPct: doublePrecision('historical_mean_delta_pct'),
    historicalMedianDeltaPct: doublePrecision('historical_median_delta_pct'),
    historicalStddevDeltaPct: doublePrecision('historical_stddev_delta_pct'),
    historicalSampleSize: integer('historical_sample_size'),

    zScore: doublePrecision('z_score'),
    percentile: doublePrecision('percentile'),
    /** 'aggressive' | 'competitive' | 'fair' | 'high' | 'outlier_high' */
    verdict: text('verdict').notNull(),
    rationale: text('rationale'),

    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index('fuel_deal_market_context_tenant_idx').on(t.tenantId),
    dealIdx: index('fuel_deal_market_context_deal_idx').on(t.dealId),
    verdictIdx: index('fuel_deal_market_context_verdict_idx').on(t.verdict),
  }),
);

export type FuelDealMarketContext = typeof fuelDealMarketContext.$inferSelect;
export type NewFuelDealMarketContext = typeof fuelDealMarketContext.$inferInsert;
```

### 5.4 `packages/agents/src/agents/procur-enrichment.ts`

New agent. Given an org, fetches procur intelligence, writes summary + tags + signals.

```ts
import type { IAgent, AgentContext, AgentOutput } from './types.js';

export interface ProcurEnrichmentInput {
  organizationId: string;
  /** When true, force a re-fetch even if a fresh snapshot exists. */
  force?: boolean;
}

export class ProcurEnrichmentAgent implements IAgent {
  readonly name = 'procur-enrichment';
  readonly tier = 'T1' as const;  // T0 reads + T1 internal writes

  constructor(private readonly input: ProcurEnrichmentInput) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    /*
     * 1. Fetch organization from vex
     * 2. Check procur_intelligence_snapshots for non-expired snapshots
     *    matching (orgId, procurTool='analyze_supplier'). If present
     *    and fresh, skip procur call.
     * 3. Otherwise:
     *    a. Call procur.analyzeSupplier({ supplierName: org.legalName })
     *    b. If disambiguation_needed: emit a signal, set status, exit
     *    c. If profile: persist snapshot, write summary, update tags,
     *       update fieldConfidence on country/kind, raise signals if
     *       distress signals present
     *    d. Also call procur.analyzeSupplierPricing if org.kind in
     *       ('supplier', 'broker') — gives operators a "they typically
     *       price 22% over benchmark" stat
     * 4. Return AgentOutput with internalWrites count + cost
     */
  }
}
```

### 5.5 `packages/agents/src/agents/deal-market-context.ts`

New agent. Triggered on deal draft→live; populates fuel_deal_market_context.

```ts
import type { IAgent, AgentContext, AgentOutput } from './types.js';

export interface DealMarketContextInput {
  dealId: string;
}

export class DealMarketContextAgent implements IAgent {
  readonly name = 'deal-market-context';
  readonly tier = 'T1' as const;

  constructor(private readonly input: DealMarketContextInput) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    /*
     * 1. Fetch fuel_deal by id
     * 2. Compute deal price per unit (volume_usg / quoted price)
     * 3. Map deal product + grade to procur category_tag + grade
     * 4. Call procur.evaluateOffer with destination country, price,
     *    grade
     * 5. Persist into fuel_deal_market_context
     * 6. If verdict === 'outlier_high' OR historical sample < 10:
     *    raise a signal so operator sees it on the deal
     * 7. If verdict === 'aggressive': raise an info-level signal
     *    (might be distress sale; worth checking)
     */
  }
}
```

### 5.6 `packages/agents/src/agents/campaign-targeting.ts`

New agent. Orchestrates buyer discovery for a supplier offer.

```ts
import type { IAgent, AgentContext, AgentOutput } from './types.js';

export interface CampaignTargetingInput {
  /** A description of the supplier offer to source buyers for. */
  offer: {
    categoryTag: string;
    descriptionKeywords?: string[];
    targetCountries?: string[];  // e.g. ['DO','JM','TT'] for Caribbean
    grade?: string;
    quantity?: { value: number; unit: string };
    pricePerUnitUsd?: number;
    incoterm?: string;
    laycanStart?: string;
    laycanEnd?: string;
  };
  /** Which campaign to enroll matched buyers into. */
  campaignId: string;
  /** Max number of orgs to enroll in this run. */
  maxEnrollments?: number;
  /** Operator who initiated. Used for approval routing. */
  initiatedBy: string;
}

export class CampaignTargetingAgent implements IAgent {
  readonly name = 'campaign-targeting';
  readonly tier = 'T2' as const;  // T2 because it proposes external
                                   // contact (campaign enrollment) —
                                   // requires approval gate.

  constructor(private readonly input: CampaignTargetingInput) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    /*
     * 1. Call procur.findBuyersForOffer with the offer spec
     * 2. For each candidate buyer (limit N):
     *    a. Resolve to a vex organization (lookup by legalName /
     *       externalKeys, or upsert if new)
     *    b. Schedule ProcurEnrichmentAgent for the org if not
     *       recently enriched
     *    c. Schedule OfacScreeningAgent if not recently screened
     *    d. Compute fit score using LeadQualificationAgent
     *    e. If fit >= threshold AND ofac_status === 'clear':
     *       - create a lead pointing to this org
     *       - propose campaign enrollment (queued for approval)
     * 3. Emit a single approval-required action with the proposed
     *    enrollments. Operator approves before any outbound emails
     *    fire.
     * 4. Return summary: candidates found, candidates passing fit,
     *    candidates passing OFAC, candidates proposed for enrollment.
     */
  }
}
```

---

## 6. Surface in vex API and chat

### 6.1 New API routes (vex side)

In `apps/api/src/`, add a new module:

```
apps/api/src/intelligence/
  intelligence.controller.ts
  intelligence.module.ts
  intelligence.service.ts
```

Routes:

```
GET    /api/intelligence/orgs/:orgId               -> get cached procur snapshot
POST   /api/intelligence/orgs/:orgId/refresh       -> trigger ProcurEnrichmentAgent
POST   /api/intelligence/deals/:dealId/evaluate    -> trigger DealMarketContextAgent
POST   /api/intelligence/campaigns/target          -> trigger CampaignTargetingAgent
```

All routes are tenant-scoped via the existing `JwtAuthGuard` + `TenantContextService`. Procur calls happen server-side; vex front-end never calls procur directly.

### 6.2 Chat surface

The vex chat (whatever surface owns operator-facing conversation) gets four new natural-language affordances:

| Operator says | Agent fires |
|---|---|
| "Tell me about [counterparty]" / "Research [counterparty]" | ResearchAgent (which now includes procur intelligence in its evidence pack) |
| "Evaluate this deal" / "Is the price fair on [deal]" | DealMarketContextAgent + a verbal summary of the verdict |
| "Source buyers for [offer]" / "Who would buy [commodity]" | CampaignTargetingAgent (proposes enrollments, operator approves) |
| "Show distressed suppliers in [category, country]" | A direct procur call (read-only); results displayed as a list |

### 6.3 UI surface (apps/web)

Three new components, all small:

- **Org detail page** — adds a "Procur Intelligence" tab showing the cached snapshot (capability summary, recent awards, recent cargoes, news events, distress flags). Refresh button calls the API route.
- **Deal detail page** — adds a "Market Context" panel showing the verdict, z-score, sample size, rationale. Surfaces below the existing deal economics.
- **Campaign creation flow** — adds a "Source from Procur" step where the operator describes the offer and gets back a proposed enrollment list to approve.

---

## 7. Outbound messaging — how procur intelligence shapes the email

Vex already has `EmailReplyDraftAgent`. Extend the prompt template to include procur evidence when drafting cold outreach.

The prompt structure becomes:

```
You are drafting a cold-outreach email to [contact] at [org].

Procur intelligence context (use this to make the message specific):
- They have won [N] awards for [commodity] in the last [M] months,
  averaging [$X] per [unit].
- Their typical pricing is [+Y%] over [benchmark].
- They have not won an award in [Z] days (distress signal: [yes/no]).
- Recent cargoes: [list].
- News events: [list].
- Their typical procurement cycle for this commodity is [pattern].

The offer:
[offer description]

Draft a 4-sentence email that:
1. References something specific from the procur intelligence (their
   recent activity, their stated pattern, a recent news event)
2. Explains the offer concisely
3. Proposes a concrete next step (call, email, NDA)
4. Stays compliant — no specific Cuba mention, ever

Tone: peer-to-peer, not vendor-to-buyer. They are a sophisticated
counterparty. Match that.
```

This is the lever. The procur intelligence isn't background context — it's the differentiator. Every outbound message references something specific that signals "we know who you are and what you do." That's what cuts through the firehose of generic broker outreach.

**Existing prompt files to update**: `packages/agents/src/prompts/email-reply-draft.ts`, `packages/agents/src/prompts/follow-up.ts`, `packages/agents/src/prompts/strategy-draft.ts`. Add a `procurEvidence` block to each that the LLM consumes when present.

---

## 8. Approval gates

This is critical for the `CampaignTargetingAgent` specifically. Vex already has an `approval-gate.ts` primitive. The new agent must use it correctly:

- **Counterparty enrichment** is T1 — internal writes only. No approval needed.
- **Deal market context** is T1 — internal writes to a sidecar table. No approval needed.
- **Campaign targeting** is T2 — proposes external contact (campaign enrollment that triggers emails). **Always requires operator approval before any emails fire.**

The approval surface should show:
- The proposed enrollments (org name, contact, fit score, OFAC status, procur summary)
- The campaign template that will be sent
- A preview of the email each contact will receive
- Approve / reject / edit-then-approve actions

Operators approve in batches. Once approved, the existing campaign engine takes over.

---

## 9. Operational specifics

### 9.1 Environment config

New env vars in `apps/api`, `apps/worker`, and `packages/integrations`:

```
PROCUR_API_BASE_URL=https://procur.your-domain.com/api/intelligence
PROCUR_API_TOKEN=<long-lived bearer token issued by procur>
PROCUR_TIMEOUT_MS=10000
PROCUR_CACHE_TTL_DAYS=7
```

### 9.2 Cost ledger

Procur calls are tracked in vex's existing `cost-ledger` table. Each procur API call is recorded as a cost event, even though the dollar cost is $0 (procur is internal infrastructure). This gives operators visibility into how much procur usage each agent run consumes — useful for optimization.

### 9.3 Rate limiting

Procur applies per-token rate limits (e.g. 100 requests/minute). Vex's `ProcurClient` honors these via exponential backoff on 429 responses. The cache layer (5min TTL on entity-scoped reads, 7 days for snapshots) keeps actual procur traffic low.

### 9.4 Failure modes

- **Procur down** — vex agents that need procur fail soft. ResearchAgent still produces a brief from internal touchpoints, just without procur evidence. DealMarketContextAgent fails the deal-evaluation step but leaves the deal in `live` (the operator can re-trigger when procur is back).
- **Procur returns disambiguation** — vex stores the disambiguation candidates as a signal so the operator can pick the right entity, then re-runs the agent.
- **Procur returns not_found** — vex tags the org with `procur:not_in_database` and sets `fitScore` partial confidence accordingly. Org continues through normal vex workflows; just without procur enrichment.

---

## 10. Implementation order

1. **Procur HTTP API** (procur side) — wrap the existing assistant tools in REST routes under `apps/app/app/api/intelligence/`. ~1 day.
2. **`packages/integrations/procur.ts` client** (vex side) — typed client with caching, retry, telemetry. ~0.5 day.
3. **Schema additions** (vex side) — `procur_intelligence_snapshots`, `fuel_deal_market_context`, plus repository code. ~0.5 day.
4. **`ProcurEnrichmentAgent`** — wire into AgentScanner so it runs nightly per org. Update ResearchAgent to consume procur evidence. ~1 day.
5. **`DealMarketContextAgent`** — wire to deal lifecycle hook (draft→live). ~0.5 day.
6. **`CampaignTargetingAgent`** — orchestration logic + approval-gate integration. ~1 day.
7. **API + UI** — three new API routes, three new UI panels. ~1.5 days.
8. **Prompt updates** — email-reply-draft, follow-up, strategy-draft. ~0.5 day.
9. **Tests** — unit tests for ProcurClient mocks, agent fixtures with procur evidence, integration test for full campaign-targeting flow. ~1 day.

**Total: ~7 days** of focused work. Half is in vex, half is in procur.

---

## 11. What this brief deliberately doesn't do

- **No bidirectional sync.** Vex's RFQ outcomes, deal closes, etc. stay in vex. Procur never sees private behavioral data. If we ever want procur's `supplier_signals` table to incorporate vex outcomes, that's a separate brief with explicit privacy review.
- **No federated database.** Vex and procur stay on different Neon instances with different scaling profiles. The HTTP boundary is permanent.
- **No procur tool calls from vex chat directly.** All procur access goes through agents (ProcurEnrichmentAgent, DealMarketContextAgent, CampaignTargetingAgent) so cost tracking, approval gates, and tenant isolation all work correctly.
- **No automated outbound based on procur signals.** A procur distress signal lands as a vex `signal` for the operator; the operator decides whether to action it. We are not auto-emailing distressed suppliers.
- **No procur-side caching of vex queries.** Procur is stateless from vex's perspective — every call re-runs against fresh procur data (subject to procur's own materialized-view refresh cadence).
- **No replicating procur data into vex.** The snapshot table caches *recent intelligence per org* for performance; it is not a copy of the procur warehouse. Vex queries procur fresh whenever a snapshot is stale.

---

## 12. The three-message playbook this enables

End-to-end concrete example. Operator's input is one sentence. Vex orchestrates the rest.

**Operator says (in chat):** "I have 5,000 MT diesel CIF Caucedo from Kenge at $0.85/L. Source buyers."

**Vex executes:**

1. `CampaignTargetingAgent` fires. Calls `procur.findBuyersForOffer({ categoryTag: 'diesel', buyerCountries: ['DO','JM','TT','BS','BB','HT'], descriptionKeywords: ['caucedo','cif','5000mt'], yearsLookback: 3 })`.
2. Procur returns 18 candidate buyers ranked by recency × volume. Top candidates: Sigma Petroleum (552 awards), Isla Dominicana (329 awards), Next Dominicana (486 awards), Sunix/TotalEnergies (587 awards through 2022, then dropped to 0 — flagged).
3. For each, vex resolves/creates the org, schedules `ProcurEnrichmentAgent`, `OfacScreeningAgent`, computes fit.
4. Vex calls `procur.evaluateOffer({ categoryTag: 'diesel', buyerCountry: 'DO', offeredPriceUsd: 0.85, offeredPriceUnit: 'USD/L' })` → returns: NY Harbor ULSD spot $0.62/L, historical Caribbean diesel premium 25% (n=552, σ=8%), this offer at +37%, z=+1.5, verdict=`high`. Operator sees: *"This is at the high end of historical Caribbean delta. Negotiable."*
5. For each high-fit candidate, vex drafts an email using the new prompt template. Sigma's email reads: *"Sigma — your team has averaged $0.94/L on DR diesel awards over the last 18 months. We're tracking a 5,000 MT cargo loading [origin] for Caucedo discharge in [window] at $0.85/L CIF. That's roughly 10% under your typical run-rate. If you'd like to see full specs and laycan options, reply and we'll send the offer sheet within the hour."*
6. Operator sees an approval gate with 8 proposed enrollments. Approves 5, rejects 2 (compliance), edits 1.
7. Vex's existing campaign engine handles delivery, tracking, replies. Replies route to `EmailReplyDraftAgent` for first-pass drafting; operator reviews and sends.

**This is what "intelligence-driven outreach" actually looks like.** Not a generic SaaS feature. A specific, narrow workflow where every step uses real data about real counterparties.

---

## 13. Source notes — design decisions encoded above

- **One-way data flow** preserves the multi-tenant-public vs single-tenant-private boundary cleanly. Procur is a SaaS product; vex is your private execution platform. They should not be coupled at the database layer.
- **HTTP API surface** is intentionally minimal — wraps existing assistant tools, no new query semantics. Premature to add gRPC or GraphQL at this scale.
- **Snapshot caching** balances freshness with cost — entity-scoped reads cached 7 days, market evaluation always fresh because spot prices update daily.
- **Approval gates on outbound** are non-negotiable. The platform must never send an email without operator approval, even for procur-targeted campaigns. Trust comes from this discipline.
- **Existing vex primitives** are explicitly preserved. Nothing new replaces what already works (campaigns, OfacScreeningAgent, ResearchAgent, approval-gate). New agents orchestrate existing ones; new tables are sidecars, not replacements.

---

End of brief.
