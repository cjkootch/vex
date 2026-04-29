> **IMPLEMENTATION STATUS — refreshed 2026-04-29**
>
> **Status: not yet started.** The brief is committed but no schema or agents have shipped yet.
>
> Procur-side: no work needed (procur acts purely as signal source via existing endpoints `find_distressed_suppliers`, `find_recent_cargoes`, `analyze_supplier`, `entity_news_events` — all live).
>
> Vex-side (all pending):
> - `organizations.kind` enum extension (`origination_partner_candidate`, `origination_partner`)
> - `origination_partnerships` schema
> - `partner_deal_intros` schema
> - `partner_kyc_records` schema
> - `OriginationPartnerScoutAgent` (T1)
> - `OriginationPartnerScoringAgent` (T1)
> - Partner-facing intake surface at `/partner/*`
> - Vetting workflow UI
> - Discipline rule enforcement at the approval-gate level
>
> **Why this is deferred:** the proactive matching capstone was prioritized first, correctly. Origination partners are the next strategic-leverage workstream, but it's the most discipline-sensitive of all the briefs (see §2 — the Pattern A vs Pattern B boundary). It deserves real operator attention before code, not parallel execution while other things are landing.
>
> **Pre-execution check before starting:** the §9 discipline rules need to be operationalized before any partner is onboarded. Specifically: who reviews KYC dimensions, who approves pattern-A-adjacent edge cases, what the cooling-off period enforces in practice. The schema is straightforward; the operator culture around it is the harder problem.
>
> 7-day estimate from §11 stands.
>
> ---

# Origination Partners — Network of Capital-Constrained Deal Sources

**Status:** spec, not yet implemented
**Owner:** Cole
**Last updated:** 2026-04-28
**Repos:** `cjkootch/vex` (canonical) + `cjkootch/procur_dashboard` (signal source)
**Prerequisite:** The Vex × Procur integration brief (`docs/procur-integration.md`) must be partly shipped — specifically `ProcurClient`, `ProcurEnrichmentAgent`, and the existing OfacScreeningAgent.

---

## 1. What we're building, in one paragraph

A formalized partner-tier relationship model for smaller traders and brokers in VTC's geographies who have **deal flow but not capital**. They bring VTC live opportunities — cargoes their buyers want but their balance sheet can't fund. VTC takes principal on selected deals. They earn a referral fee per accepted deal. The system identifies candidate partners through procur's award + entity data, runs enhanced due diligence, scores partner quality over time, and enforces a hard rule: every dollar of VTC capital is committed to a specific cargo with specific collateral. No working lines, no pre-funding, no "we're good for it" arrangements. **This brief is about deal sourcing through capital-constrained intermediaries; it is explicitly NOT about VTC providing trade finance.**

---

## 2. The hard boundary — read this before anything else

There are two patterns this brief could describe. They look similar from a distance. They are very different businesses with very different risk profiles. **Pattern A is explicitly out of scope. Pattern B is what this brief implements.**

### Pattern A — Trade finance to capital-constrained traders. NOT IN SCOPE.

Providing capital (working lines, pre-funding, factoring of receivables, loans against future cargo) to brokers and traders who can't access traditional bank LCs. This is a finance business — not a trading business. It requires:

- $25-50M+ deployable capital to be credible
- Specialty trade finance underwriting capability
- Banking license or regulated lender partnership
- Trade-based money laundering screening infrastructure
- Tolerance for credit losses (not just trading losses) when borrowers default
- Legal infrastructure for collateralized lending against cargo (warehouse receipts, BLs as collateral, STF Master Agreements)

This is the business that took down Greensill Capital in 2021 ($10B in losses, Credit Suisse supply chain finance fund collapse, ongoing regulatory investigations). The collapse pattern is well-documented: trade finance to under-banked counterparties is a high-fraud, low-margin business that requires extreme operational discipline. **VTC at its current scale and structure is not equipped for Pattern A and would be at substantial risk attempting it.** If VTC ever decides to enter Pattern A, that decision requires:

- A separate legal entity (the trade-finance balance sheet should not be commingled with VTC's trading book)
- A separate capital raise specifically scoped to trade finance
- An executive with trade-finance origination experience (not commodity-trading experience — they are different skill sets)
- A separate compliance program with TBML and beneficial-ownership-chain capability
- Partnership with a regulated lender or pursuit of a banking license

None of those are this brief. This brief is Pattern B.

### Pattern B — Deal origination through capital-constrained intermediaries. IN SCOPE.

Identifying smaller brokers and traders as **origination partners** who bring VTC deals where they have a buyer-side relationship but cannot fund the cargo themselves. VTC takes principal on selected deals. The partner earns a referral fee on accepted deals. The partner stays in the deal as the operational liaison and introducer; they bear no capital risk and have no claim on VTC's trading P&L.

The deal flow direction:

```
Origination Partner          VTC                    Counterparty
─────────────────────        ────────────           ────────────────
Has buyer relationship       Takes principal        Sells cargo to VTC
                             Funds cargo
                             Bears trading risk
                             Pays referral fee      Buys cargo from VTC
                             on accepted deals
```

Pattern B is what Vitol, Trafigura, and Mercuria do in their regional independent broker networks. Real business, well-understood economics, manageable operational risk if the discipline rules are held.

### The boundary in one rule

**Every dollar of VTC capital is committed to a specific cargo with specific collateral and specific exit conditions.** No working lines extended to partners. No pre-funding of deals before a specific cargo is identified. No aggregated credit exposure to a partner. No "we're good for it" arrangements. Every deal stands alone.

This is the rule that keeps Pattern B from drifting into Pattern A. The system architecture must enforce it; the operator culture must hold it. **If at any point an origination partner is asking for capital that isn't tied to a specific cargo VTC is taking principal on, the answer is no. There are no exceptions in v1.**

---

## 3. The strategic frame — why this matters

The strategic vision document (`docs/strategic-vision.md`) describes VTC as a deal-origination engine using public-data signals nobody else is reading carefully. Origination partners are a **third source of signal** beyond public-tender data and procur's intelligence layers.

Public data captures *what has happened* (awards, customs flows, vessel arrivals) and *what is published* (tenders, RFPs). Procur's intelligence layers extract *forward-looking signals from public data* (distress patterns, procurement cadence, news events). Origination partners capture **what is privately known** — a regional broker hears that a refinery is overstocked because his cousin works there, before the customs data shows it, before the trade press reports it, before the public market sees it.

That gap — between privately-known and publicly-visible — is typically 14-90 days for the kinds of signals partners surface. **This is the same asymmetric window that drives the proactive-matching engine.** Partners aren't a separate workflow; they're an additional signal source that feeds the same engine. A partner-introduced deal joins the proactive match queue with a higher confidence weight than public-only signals because the underlying information is non-public.

Two implications follow:

**Partners are scored by signal quality, not just deal closing rate.** A partner whose introductions consistently surface real opportunities earns priority access (faster review, better fees, ongoing relationship). A partner who shops bad deals or whose introductions repeatedly fail diligence loses access. Quality > quantity.

**The defensive moat from partners is meaningfully real.** Public data is replicable — competitors can ingest the same EIA spot prices and AIS feeds. Partner relationships are not. Once a regional broker has invested in the relationship with VTC, switching costs are real. This is one of the few moats in commodity trading that a competitor with infinite capital cannot simply outspend.

---

## 4. Who qualifies as an origination partner

Not every small broker is a partner candidate. The candidate profile:

**Activity signals (procur-detectable):**
- Appears as a past *bidder* (not necessarily winner) in public tenders for VTC's commodity categories
- Has been operationally active in the geography for 2+ years (avoids one-shot shells)
- Shows up in `known_entities` with `role=trader` or `role=broker` or in entity_news_events as a named participant
- Operates in geographies where VTC has either commodity expertise or regulatory advantage (Caribbean, LatAm, West Africa, Med basin)

**Capital-constraint signals:**
- Contract sizes consistently below $5M (suggests small balance sheet)
- Pattern of bidding on large tenders without winning (suggests capital was the binding constraint, not capability)
- Single-office or founder-led firm in `known_entities` notes
- LinkedIn / press coverage indicates < 10 employees

**Credibility signals (manual due diligence):**
- Cleared OFAC SDN list (existing OfacScreeningAgent handles this)
- Cleared enhanced KYC (separate workflow — see §6)
- Operational history demonstrable through public records (registry filings, news mentions, prior tender appearances)
- Personal references from trusted network where possible (this is human work, not system work)

**Anti-signals (immediate disqualification):**
- Beneficial ownership opacity (offshore structures, nominee directors, no public footprint)
- Sanctions adjacency in any jurisdiction (not just OFAC)
- History of payment disputes or fraud allegations in trade press
- Unwillingness to share basic operational information during outreach
- Patterns suggesting the broker shops the same deal to multiple principals simultaneously without disclosure
- Active litigation as defendant in commercial fraud cases
- Distressed status flagged by procur's distress signal layer (these are partners who will shop bad deals as their own situation deteriorates)

The disqualification list is deliberately strict. **Better to miss a good partner than to onboard a bad one.** Reputational risk in commodity trading is severely asymmetric — one bad partner-introduced deal destroys VTC credibility that took years to build.

---

## 5. Schema additions

### 5.1 `packages/db/src/schema/enums.ts` — extend organizations.kind vocabulary

The existing `organizations.kind` field is text (per the schema comment, deliberately not an enum so vocabulary can evolve). Add `origination_partner` and `origination_partner_candidate` as recognized values.

The distinction:
- `origination_partner_candidate` — someone surfaced as a potential partner who has not yet completed enhanced KYC. They can be researched, contacted, evaluated. They cannot be brought into a partner-tier deal.
- `origination_partner` — fully vetted, KYC-complete, partnership terms agreed in writing. Eligible to introduce deals VTC will consider.

The transition between candidate → partner is a deliberate human decision (vetting workflow, see §6), not an automatic agent action.

### 5.2 `packages/db/src/schema/origination-partnerships.ts`

```ts
import {
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  date,
  boolean,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';
import { users } from './users.js';

/**
 * Formal partnership record between VTC and an origination partner.
 * Created when a candidate is elevated to partner status after
 * enhanced KYC completes. One row per active partnership.
 *
 * Distinct from organizations.kind (which marks the org's role in the
 * counterparty graph). This table captures the partnership terms,
 * performance state, and lifecycle.
 *
 * Tenant-scoped.
 */
export const originationPartnerships = pgTable(
  'origination_partnerships',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),

    /** The org acting as origination partner. */
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    /** Lifecycle: active | paused | terminated. Paused is for
        temporary holds (e.g. partner is going through internal
        change, mid-investigation). Terminated is permanent. */
    status: text('status').notNull().default('active'),

    /** Geographic scope of the partnership — countries (ISO-2) or
        regions where VTC will accept deals from this partner.
        Non-listed geographies require explicit operator review
        before deal acceptance. */
    geographicScope: text('geographic_scope').array().notNull(),

    /** Commodity scope — internal category_tags. */
    commodityScope: text('commodity_scope').array().notNull(),

    /** Referral fee structure. JSONB to allow variations:
        - { type: 'flat_pct', value: 0.0075 } — 0.75% of contract value
        - { type: 'tiered', tiers: [{ minUsd: 0, pct: 0.005 },
                                    { minUsd: 5000000, pct: 0.0075 }] }
        - { type: 'flat_usd', value: 25000 } — fixed fee per deal
        Always paid on accepted deals only; never on deals VTC declined.
        Always paid post-cargo-discharge, after final settlement.
        NEVER paid as a percentage of VTC's margin (decoupled from
        VTC P&L). */
    feeStructure: jsonb('fee_structure').$type<Record<string, unknown>>().notNull(),

    /** Exclusivity terms — typically NONE in v1 (partner can shop
        deals to other principals; VTC takes the deals it wants).
        If set, this is a contractual commitment we'll need to
        track and enforce. */
    exclusivity: text('exclusivity'),

    /** When the relationship started + when current terms took effect. */
    establishedAt: date('established_at').notNull(),
    termsEffectiveFrom: date('terms_effective_from').notNull(),

    /** KYC completion reference. Points to the enhanced-KYC document
        package stored in the documents system. */
    kycPackageRef: text('kyc_package_ref'),
    kycCompletedAt: timestamp('kyc_completed_at', { withTimezone: true }),

    /** Performance score, 0-100, computed nightly by
        OriginationPartnerScoringAgent. See §7 for components. */
    performanceScore: doublePrecision('performance_score'),

    /** Free-text operator notes — partnership history, key
        relationship facts, things the LLM should know when drafting
        partner-facing communications. */
    notes: text('notes'),

    /** Owner — the VTC operator who owns this relationship. */
    ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index('origination_partnerships_tenant_idx').on(t.tenantId),
    orgIdx: index('origination_partnerships_org_idx').on(t.orgId),
    statusIdx: index('origination_partnerships_status_idx').on(t.tenantId, t.status),
    performanceIdx: index('origination_partnerships_performance_idx').on(t.performanceScore),
  }),
);

export type OriginationPartnership = typeof originationPartnerships.$inferSelect;
export type NewOriginationPartnership = typeof originationPartnerships.$inferInsert;
```

### 5.3 `packages/db/src/schema/partner-deal-intros.ts`

```ts
import {
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  date,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';
import { originationPartnerships } from './origination-partnerships.js';
import { fuelDeals } from './fuel-deals.js';
import { users } from './users.js';

/**
 * One row per deal a partner has introduced to VTC. Created when a
 * partner submits a deal via the structured intake form (or when an
 * operator manually logs a partner introduction).
 *
 * Lifecycle:
 *   submitted -> under_review -> {accepted | declined | dropped}
 *   accepted -> linked_to_deal (when fuel_deal is created)
 *   linked_to_deal -> {closed | cancelled}
 *
 * Tenant-scoped.
 */
export const partnerDealIntros = pgTable(
  'partner_deal_intros',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),

    partnershipId: text('partnership_id')
      .notNull()
      .references(() => originationPartnerships.id, { onDelete: 'cascade' }),

    /** Lifecycle state. */
    status: text('status').notNull().default('submitted'),

    /** Submission payload — structured fields the partner filled in. */
    commodity: text('commodity').notNull(),
    grade: text('grade'),
    quantity: doublePrecision('quantity'),
    quantityUnit: text('quantity_unit'),
    estimatedPriceUsd: doublePrecision('estimated_price_usd'),
    estimatedPriceUnit: text('estimated_price_unit'),
    incoterm: text('incoterm'),
    originPort: text('origin_port'),
    destinationPort: text('destination_port'),
    laycanStart: date('laycan_start'),
    laycanEnd: date('laycan_end'),

    /** Buyer-side counterparty disclosed by the partner. May be
        named or referenced by description ("a national utility in
        country X"). Set null until disclosed. */
    buyerOrgId: text('buyer_org_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    buyerDescription: text('buyer_description'),

    /** Supply-side counterparty disclosed by the partner. */
    supplierOrgId: text('supplier_org_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    supplierDescription: text('supplier_description'),

    /** What the partner has actually committed to with each side. */
    buyerCommitmentLevel: text('buyer_commitment_level'),       // 'inquiry' | 'verbal' | 'signed_loi' | 'signed_contract'
    supplierCommitmentLevel: text('supplier_commitment_level'),

    /** Why VTC is the right principal for this deal — partner's
        stated reasoning. */
    rationale: text('rationale'),

    /** If accepted, the resulting fuel_deal. Null until linked. */
    linkedFuelDealId: text('linked_fuel_deal_id').references(() => fuelDeals.id, {
      onDelete: 'set null',
    }),

    /** Decision rationale — populated when accept/decline happens. */
    decisionAt: timestamp('decision_at', { withTimezone: true }),
    decisionBy: text('decision_by').references(() => users.id, { onDelete: 'set null' }),
    decisionRationale: text('decision_rationale'),

    /** Operator owner for this submission. */
    ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),

    /** Free-form metadata bucket — diligence notes, document refs,
        red-flag annotations. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),

    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index('partner_deal_intros_tenant_idx').on(t.tenantId),
    partnershipIdx: index('partner_deal_intros_partnership_idx').on(t.partnershipId),
    statusIdx: index('partner_deal_intros_status_idx').on(t.tenantId, t.status),
    linkedFuelDealIdx: index('partner_deal_intros_fuel_deal_idx').on(t.linkedFuelDealId),
  }),
);

export type PartnerDealIntro = typeof partnerDealIntros.$inferSelect;
export type NewPartnerDealIntro = typeof partnerDealIntros.$inferInsert;
```

### 5.4 `packages/db/src/schema/partner-kyc-records.ts`

```ts
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  date,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';
import { users } from './users.js';

/**
 * Enhanced KYC records for origination partner candidates. Distinct
 * from OFAC screening (which the existing OfacScreeningAgent handles
 * for all counterparties). Enhanced KYC goes deeper:
 *
 *   - beneficial ownership chain (UBO identification)
 *   - corporate registry verification in operating jurisdiction(s)
 *   - litigation history search
 *   - press / news search for fraud allegations
 *   - personal-reference checks where applicable
 *   - PEP (politically exposed persons) screening
 *   - adverse media screening
 *   - source-of-funds reasonableness check
 *
 * Each KYC dimension gets its own row. The aggregate clearance
 * decision is a separate workflow step taken by an operator after
 * all dimensions are collected.
 *
 * Tenant-scoped.
 */
export const partnerKycRecords = pgTable(
  'partner_kyc_records',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),

    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    /** Dimension being recorded:
        'beneficial_ownership' | 'registry_verification' | 'litigation' |
        'adverse_media' | 'pep_screening' | 'source_of_funds' |
        'personal_reference' | 'operational_history' */
    dimension: text('dimension').notNull(),

    /** Outcome:
        'pending' | 'cleared' | 'flagged' | 'failed'
        - cleared: dimension passes
        - flagged: passes with caveats; operator must explicitly accept
        - failed: hard fail; partnership cannot proceed without
          remediation */
    outcome: text('outcome').notNull().default('pending'),

    /** Findings — free-text from the operator or LLM-summarized
        from external sources (Tavily, news search, etc.). */
    findings: text('findings'),

    /** Source documents attached. JSONB array of refs into the
        documents system. */
    sourceDocuments: jsonb('source_documents').$type<string[]>().notNull().default([]),

    /** When this dimension was reviewed and by whom. */
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: text('reviewed_by').references(() => users.id, { onDelete: 'set null' }),

    /** When this dimension's clearance expires — KYC is not a
        one-shot decision; it must be refreshed periodically (typically
        annual). */
    expiresAt: date('expires_at'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantOrgIdx: index('partner_kyc_records_tenant_org_idx').on(t.tenantId, t.orgId),
    dimensionIdx: index('partner_kyc_records_dimension_idx').on(t.orgId, t.dimension),
    outcomeIdx: index('partner_kyc_records_outcome_idx').on(t.tenantId, t.outcome),
    expiresIdx: index('partner_kyc_records_expires_idx').on(t.expiresAt),
  }),
);

export type PartnerKycRecord = typeof partnerKycRecords.$inferSelect;
export type NewPartnerKycRecord = typeof partnerKycRecords.$inferInsert;
```

---

## 6. The vetting workflow — candidate to partner

Elevating an org from `origination_partner_candidate` to `origination_partner` is **deliberately a multi-step human workflow with system support.** The system enforces that each step is completed; humans make the actual judgment calls.

### Step 1: Identification

Two paths:

**Path A — procur surfaces a candidate.** A new agent `OriginationPartnerScoutAgent` (T1, runs nightly) scans procur data for orgs matching the candidate profile in §4. For matches, it:
- Sets the org's `kind = 'origination_partner_candidate'` if not already
- Pulls the org's procur intelligence into a snapshot
- Emits a signal so the operator sees the candidate

**Path B — operator manually adds a candidate.** Operator knows a broker by name. Adds them via UI. System runs basic OFAC screening immediately. Org gets `kind = 'origination_partner_candidate'`.

### Step 2: Initial outreach

Operator decides whether to invest in vetting this candidate. Most candidates from Path A won't be worth pursuing (the procur signal is necessary but not sufficient). The operator sends an initial message via the existing campaign engine. Standard partner-introduction template (see §10).

If the candidate responds positively and is willing to engage in vetting, proceed. If they don't respond or aren't interested, mark the candidate as "deferred" and move on.

### Step 3: Enhanced KYC

This is the substantive vetting work. For each KYC dimension defined in `partner_kyc_records`, the operator (with system support) collects evidence:

- **Beneficial ownership** — request UBO declaration from candidate; verify against corporate registry; cross-check with press / Sayari-style data sources
- **Registry verification** — pull the candidate's incorporation document from their primary jurisdiction; verify directors, registered address, share capital
- **Litigation** — search court databases (PACER for US, equivalents for other jurisdictions) for adverse litigation history
- **Adverse media** — broad press / news search for fraud allegations, payment disputes, regulatory actions
- **PEP screening** — check directors and UBOs against political-exposure databases
- **Source of funds** — for the candidate's existing business, where does the operating capital come from? Reasonable answers exist; opaque or implausible answers are red flags
- **Personal references** — where possible, references from existing trusted relationships in the trader network
- **Operational history** — verify 2+ years of operating presence through public records, prior tender appearances, trade press mentions

Each dimension lands as a `partner_kyc_records` row with an outcome. The system supports the workflow but doesn't make the calls — operator + LLM-assisted research + manual judgment.

The work is meaningful — typically 1-2 days of operator time per candidate. **This is the friction that prevents Pattern A drift.** If onboarding partners felt cheap, the temptation to onboard marginal partners would be real. Making it expensive ensures only candidates worth real relationship investment get through.

### Step 4: Aggregate clearance decision

Once all KYC dimensions are recorded, the operator makes the aggregate decision. The rule:
- **All dimensions cleared:** proceed to step 5
- **Any dimension flagged:** operator can proceed with documented acceptance of the flag — but only if the flag is non-material (e.g., a director has a non-substantive litigation history). Material flags must be remediated before partnership.
- **Any dimension failed:** partnership cannot proceed. Candidate is marked rejected; system enforces a 12-month cooling-off period before re-evaluation.

### Step 5: Partnership terms

Operator drafts a partnership agreement covering:
- Geographic and commodity scope
- Referral fee structure
- Exclusivity (typically none in v1)
- Confidentiality requirements
- Disclosure requirements (partner must disclose if they're shopping the same deal to other principals)
- Termination clauses
- Dispute resolution

Both parties sign. The signed agreement is uploaded to the documents system; a `partner_kyc_packageRef` points to it.

### Step 6: Activation

Operator creates the `origination_partnerships` row, sets `status = 'active'`, sets the org's `kind = 'origination_partner'` (transition from candidate). The partner now has access to the structured deal intake form. They can submit deals.

---

## 7. The OriginationPartnerScoringAgent — performance tracking

Once a partnership is active, the agent runs nightly to update `originationPartnerships.performanceScore`. The score is 0-100, higher = better, computed from these components:

| Component | Weight | What's measured |
|---|---|---|
| Submission volume | 0.10 | Number of deal intros over last 90 days, normalized by partner's stated capacity |
| Acceptance rate | 0.25 | % of submissions VTC accepted (proxy for deal quality at intake) |
| Close rate | 0.30 | % of accepted deals that closed (proxy for diligence accuracy) |
| Margin contribution | 0.15 | Average VTC margin on closed partner-introduced deals (relative to non-partner deals same commodity/geo) |
| Document quality | 0.10 | Operator rating per deal: docs clean / required cleanup / required substantial work |
| Counterparty performance | 0.10 | Did the buyers and suppliers the partner introduced perform on contract terms? Payment timeliness, delivery on spec, etc. |

Partners scored < 30 are flagged for review (likely to be paused or terminated). Partners scored > 70 are flagged as high-trust (faster review SLA, potentially better fee terms in next renewal).

**Important: distress signals on partners themselves matter here.** If procur's distress signal layer flags a partnership-active org, the scoring agent surfaces it as a separate signal — distressed partners are exactly the kind that shop bad deals as their own situation deteriorates. The system should make this visible early.

The agent is T1 (read + internal write). No automated actions on the partnership status; the operator decides whether to pause, terminate, or renegotiate based on the score and supplemental judgment.

---

## 8. Deal intake — the structured submission

Origination partners submit deals via a lightweight structured form. The form lives in vex's web UI at `/partner/submit-deal` (partner-facing surface, separate auth).

Required fields:

| Field | Purpose |
|---|---|
| Commodity | Maps to internal category_tag |
| Grade | Free text; gets parsed during evaluation |
| Quantity + unit | MT, m³, USG, bbls |
| Estimated price + unit | Partner's view of the going price |
| Incoterm | FOB, CFR, CIF, DAP, etc. |
| Origin port | Where cargo loads |
| Destination port | Where cargo discharges |
| Laycan window | Earliest / latest acceptable load dates |
| Buyer disclosure | Either named org or description with role |
| Buyer commitment level | inquiry / verbal / signed LOI / signed contract |
| Supplier disclosure | Either named org or description with role |
| Supplier commitment level | inquiry / verbal / signed LOI / signed contract |
| Rationale | Why VTC for this deal |

Optional:
- Documents upload (any pre-existing LOIs, term sheets, communications)
- Time pressure / deadline
- Other principals approached (transparency about whether the partner is shopping the deal)

On submission:
1. Row inserted in `partner_deal_intros` with status=`submitted`
2. Signal emitted to operator
3. Existing OfacScreeningAgent fires against any named buyer/supplier orgs
4. DealMarketContextAgent fires against the offer to score it vs procur's empirical pricing distribution
5. Operator gets an enriched view in the queue: partner's submission + OFAC results + market context + partner's performance score + procur intelligence on the disclosed counterparties

Operator decides: accept, decline, or request more information.

If accepted, a `fuel_deals` row gets created with `partner_deal_intros.linked_fuel_deal_id` set. From there, the existing deal lifecycle in vex takes over.

---

## 9. The discipline rules — encoded in code

The boundary between Pattern B (this brief) and Pattern A (out of scope) must be enforced by the system, not just by operator culture. Specific rules:

### Rule 1: No working capital lines

The schema has no concept of a "working line" or "credit limit" extended to a partner. There is no `partner_credit_limit` field, no `partner_outstanding_balance` table, no infrastructure for tracking what VTC owes a partner outside of specific deal-linked referral fees.

If anyone proposes adding such infrastructure, this brief should be referenced as the explicit boundary. Capital extensions to partners are Pattern A. Pattern A is out of scope.

### Rule 2: Referral fees only on closed deals

The `originationPartnerships.feeStructure` JSONB schema specifies fee structures. The application layer that computes fees enforces:
- Fees calculated only when a `partner_deal_intros.status = 'linked_to_deal'` AND the linked `fuel_deals.status` reaches `closed` or equivalent terminal-success state
- Fees never paid in advance
- Fees never paid as a percentage of VTC's margin (the structure decouples partner compensation from VTC P&L — partners get a flat or tiered percentage of contract value, not of trading profit)
- Fees paid post-cargo-discharge, after final settlement

### Rule 3: Per-deal collateral check

For every partner-introduced deal that VTC accepts as principal, the system must verify and record:
- Specific cargo (BL, warehouse receipt, or equivalent collateral)
- Specific counterparty payment commitment (LC, escrow, prepayment, or operator-approved alternative)
- Specific exit conditions (when VTC's capital comes back out of the deal)

This is enforced at deal acceptance via the existing approval-gate primitive. No partner-introduced deal can move from `partner_deal_intros.status = 'accepted'` to a live `fuel_deal` without the collateral check completing.

### Rule 4: No aggregated credit risk on partners

VTC's credit exposure to any single counterparty is bounded by the cargo collateral on whatever individual deal is in flight. The system never computes "total exposure to partner X" in a way that aggregates across multiple deals because that aggregation would only make sense if VTC were extending credit to the partner, which it isn't.

The closest the system gets to aggregate views is `OriginationPartnerScoringAgent`'s performance score, which aggregates deal *performance* signals — not credit exposure.

### Rule 5: Annual KYC refresh

`partner_kyc_records.expires_at` enforces re-vetting. When KYC dimensions expire, the partnership's `status` automatically transitions to `paused` until refresh completes. The partner can't submit new deals during a pause.

This rule prevents partnership relationships from continuing on stale due diligence indefinitely. People change. Companies change. A partner who passed KYC in 2026 may have material issues in 2028.

### Rule 6: Pattern A escape hatch is explicit

If at any point VTC decides Pattern A is the right business, the schema and code in this brief is not the path. Pattern A requires:
- A separate database (or at minimum separate tenant) so trade finance balance sheet doesn't commingle with trading book
- A separate codebase or clear architectural separation so finance-business logic doesn't drift into trading-business code paths
- New schema for working capital, credit lines, factoring receivables, collateral pools — none of which exists here
- A separate compliance program, separate legal entity, separate executive

Anyone reading this brief in the future and considering "could we just extend this for trade finance" should treat that consideration as a hard architectural boundary. The answer is no. Build a separate system.

---

## 10. Surface in vex — UI and chat

### 10.1 New pages (apps/web)

- **Partner Candidates page** — list of orgs flagged as `origination_partner_candidate`, sortable by source (procur-surfaced, manually added), age, commodity scope. Action: initiate outreach (uses existing campaign system).
- **Partner Vetting page** — for each candidate in active vetting, displays the KYC dimensions checklist with status, findings, and document refs. Operator works through dimensions one by one.
- **Active Partners page** — list of `origination_partnerships` with status, performance score, geographic/commodity scope, last submission date, recent intros. Filterable.
- **Partnership Detail page** — single partnership: terms, KYC history, performance score breakdown, deal intro history, communication thread.
- **Deal Intro Queue page** — list of `partner_deal_intros` with status=submitted or under_review. Each row shows partner name + performance score, commodity, OFAC status, market-context verdict, partner's stated rationale. Action: accept / decline / request info.

### 10.2 Partner-facing surface

A separate authenticated surface at `/partner/*` (different login flow, scoped permissions). Partners see:
- Submit a new deal (the structured intake form from §8)
- View status of their submitted deals (submitted / under review / accepted / declined / closed)
- View their referral fee history (per accepted+closed deal)
- View their partnership terms (read-only)
- Update their profile / KYC documents

Partners do NOT see:
- Other partners' deals or terms
- VTC's margin on their introduced deals
- Counterparty information beyond what they originally disclosed

### 10.3 Chat surface

| Operator says | Result |
|---|---|
| "Show me partner candidates" | Lists candidates with procur summaries |
| "Vet [candidate]" | Initiates KYC workflow, shows checklist |
| "Accept [partner deal intro]" | Triggers acceptance flow + fuel_deal creation |
| "Decline [partner deal intro] because [reason]" | Records decision with rationale |
| "Show partner performance" | Lists active partners by performance score |
| "Pause [partner] because [reason]" | Sets partnership status to paused, records why |
| "Show new deal intros from this week" | Filters intro queue by recency |

---

## 11. Implementation order

1. **Schema additions** — 3 new tables (origination_partnerships, partner_deal_intros, partner_kyc_records), enum extension. Hand-author migrations. ~0.5 day.
2. **OriginationPartnerScoutAgent** — nightly procur scan, surfaces candidates. Builds on existing ProcurClient. ~0.5 day.
3. **OriginationPartnerScoringAgent** — nightly performance scoring. ~0.5 day.
4. **Deal intake API + form** — partner-facing surface, structured submission. ~1 day.
5. **Operator queue + decision flow** — UI for reviewing intros. ~1 day.
6. **KYC workflow** — UI + backing data model for tracking dimensions. ~1 day.
7. **Partnership management** — UI for terms, documents, lifecycle. ~0.5 day.
8. **Discipline rule enforcement** — approval-gate integration ensuring per-deal collateral check fires before fuel_deal goes live. ~0.5 day.
9. **Campaign templates** — partner-introduction outreach template, partner-acceptance notification, partner-decline notification. ~0.25 day.
10. **Tests** — fixtures for full lifecycle (candidate identification → vetting → activation → deal submission → acceptance → close → fee payment). Critical because the boundary rules need test coverage. ~1 day.

**Total: ~7 days.** Most is in vex; minimal procur-side work (procur's role is signal source, already covered by existing endpoints).

---

## 12. What this brief deliberately doesn't do

Reiterating because it matters:

- **Pattern A.** Trade finance to partners. Out of scope. Not a small-scope-creep risk; this is a hard architectural and business boundary.
- **Working capital lines, pre-funding, factoring.** Out of scope per §9 Rule 1.
- **Aggregate credit exposure tracking.** Out of scope per §9 Rule 4.
- **Partner-facing trade finance products (e.g., "we can help finance your buyer's payment terms").** Out of scope.
- **Joint ventures with partners.** Different relationship type entirely. Out of scope.
- **Equity investment in partners.** Out of scope.
- **Multi-tier referral chains** (partner of a partner). Adds opacity to the network in ways that increase compliance risk without commensurate benefit. Out of scope in v1.
- **Automated partnership terms negotiation.** Operator-driven only.
- **Partner-to-partner introductions facilitated by VTC.** Out of scope (creates competitive dynamics among partners that complicate VTC's role).

---

## 13. The strategic upgrade this represents

The strategic vision document positions VTC as a deal-origination engine using public-data signals nobody else is reading carefully. **Origination partners extend that thesis to private signals nobody else can access.**

Public-signal origination is replicable in time. Any competitor with sufficient capital can ingest the same EIA spot prices, the same AIS feeds, the same trade press RSS. The information advantage from public-data infrastructure is real but bounded — bounded by the rate at which competitors can build equivalent data infrastructure.

Private-signal origination through partner relationships is replicable only with relationship investment that competitors cannot accelerate by spending more. A regional broker who has invested in the relationship with VTC — completed enhanced KYC, signed partnership terms, brought 5-10 successful deals — is not easily lured away. Switching costs are real (the broker would need to repeat KYC, rebuild the deal-flow muscle memory with a new principal, lose the performance-score history). Competitors can offer better fee terms, but they can't offer the trust accumulated through repeated successful transactions.

This is one of the few moats in commodity trading that doesn't depreciate over time. It compounds. Each successful deal cements the relationship. Each cemented relationship surfaces more deals. Each new deal contributes to procur's `supplier_signals` and the proactive matching engine's calibration. The flywheel reinforces itself.

The risk encoded in §2 — Pattern A drift — is the failure mode that destroys this. Trade finance to partners turns the relationship from "partner brings deals" to "partner depends on VTC for capital," which inverts the relationship dynamic and exposes VTC to credit losses it isn't built to absorb. The discipline rules in §9 are what prevent this drift. They are not bureaucratic overhead; they are the structural integrity of the strategy.

---

End of brief.
