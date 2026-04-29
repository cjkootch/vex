# Fuel Pricing Model — Vex → Procur Handoff

**Status:** code transfer brief. Hand this file to the procur Claude.
**Source repo:** `cjkootch/vex` (paths below are relative to its root).
**Target repo:** `cjkootch/procur_dashboard`.
**Why:** vex has a deterministic fuel-deal pricing + risk model that operates on a single deal. Procur wants the same primitives so its assistant tools (`evaluate_offer_against_history`, `find_buyers_for_offer`, `analyze_supplier_pricing`) can reason about per-deal economics — not just aggregate award-price-deltas.

The handoff is **read-only**. Procur should copy the calculator + types, not import from vex. Vex stays the system of record for deals; procur uses the same math to score offers it surfaces from public data.

---

## 1. What you're moving

Three layers, in dependency order:

### Layer 1 — pricing reference data (schema)

**File:** `packages/db/src/schema/fuel-market-rates.ts` (~52 lines)

A flat table of `(date, product, benchmark, pricePerUsg, pricePerBbl, pricePerMt, source)`. Indexed on `(tenant_id)`, `(product, benchmark)`, `(rate_date)`. Unique on `(tenant_id, rate_date, product, benchmark)`.

In procur this is **already covered** by `commodity_prices` + `award_price_deltas` from the pricing-analytics brief — don't duplicate the table. Just expose a function that returns `{pricePerUsg, pricePerBbl, pricePerMt}` for `(product, benchmark, asOfDate)` so the calculator below can read it.

### Layer 2 — the calculator (the actual model)

**File:** `packages/db/src/deals/calculator.ts` (~1634 lines, public surface ~30 functions/types)

This is the deal you want. Pure functions, no I/O, no DB. Takes a `FuelDealInputs` record, returns `FuelDealResults` with: per-USG economics, totals, breakeven analysis, warnings (with severity), scorecard (with recommendation: `proceed` / `proceed_with_caution` / `do_not_proceed`).

**Public surface to copy:**

```ts
// Constants + enums
export const DealWarningSeverity = { ... }     // info | caution | critical
export const DealRecommendation = { ... }      // proceed | proceed_with_caution | do_not_proceed

// Inputs
export interface FuelDealInputs               // the big one — see file
export interface VesselInputs
export interface VesselSpec
export interface PortSpec
export interface TradeFinanceInputs
export interface DealThresholds
export interface DealComplianceState

// Outputs
export interface FuelDealResults              // top-level result
export interface PerUsgEconomics
export interface DealTotals
export interface BreakevenAnalysis
export interface DealWarning
export interface DealScorecard
export interface VesselEconomics
export interface InsuranceCosts
export interface CashflowResults
export interface SensitivityOutputs

// Pure helpers
export function dealVolumeMt(volumeUsg, densityKgL): number
export function computeVesselUtilization(...): number
export function computeFreightCost(...): number

// Stage functions (each is independently testable)
export function calculateVesselEconomics(...)
export function calculateInsuranceCosts(inputs)
export function calculateUnitEconomics(inputs)        // per-USG margins
export function calculateTotals(...)
export function calculateBreakevens(...)
export function calculateWarnings(...)
export function validatePortConstraints(args)
export function calculateDealScore(...)
export function calculateCashflow(inputs)
export function calculateSensitivityGrids(...)

// Top-level — what most callers use
export function calculateFuelDeal(inputs: FuelDealInputs): FuelDealResults
```

**Tests:** `packages/db/src/deals/calculator.test.ts` (~355 lines). Copy these — every stage function has fixture-driven coverage and the calculator is highly composable. Keeping the tests in lock-step with the calc is the only protection against silent drift.

### Layer 3 — the deal-evaluator agent (optional reference)

**File:** `packages/agents/src/agents/deal-evaluator.ts` (~397 lines)

Vex's wrapper that loads a deal + scenario + cost stack, builds `FuelDealInputs`, calls `calculateFuelDeal`, persists results, and proposes a `deal.human_review` approval on `do_not_proceed`. Procur **doesn't need this verbatim** — your equivalent is to load `awards` + `external_suppliers` + price history, build `FuelDealInputs`, and score offers against the same calculator.

The useful patterns to lift:
- `benchmarkFor(product)` (line ~255): the `product → benchmark` mapping (`ulsd` → `platts_usgc_ulsd`, `jet_a1` → `platts_usgc_jet`, etc.)
- `buildInputs({deal, scenario, costStack})` (line ~271): how the row-shaped inputs get reconstituted into the calculator's input record. Your version reads from procur's award + price tables.
- `buildSummaryText(deal, results, latestBenchmarkPrice)` (line ~358): deterministic-template summary builder that produces the same text for the same inputs (cache-friendly).

---

## 2. Where it lives in procur

Suggested layout (mirrors vex's package boundaries):

```
packages/
  pricing/                                    ← new package
    src/
      calculator.ts                           ← copy from vex calculator.ts
      calculator.test.ts                      ← copy from vex
      benchmarks.ts                           ← product → benchmark map
      index.ts                                ← public barrel
    package.json
    tsconfig.json
```

Or if you don't want a new package, drop the calculator into `packages/catalog/src/calculator/` alongside the existing assistant tools. Either way the calculator is **pure** so the choice is purely about how procur's import graph is shaped.

---

## 3. Required type substitutions

The calculator imports nothing from `@vex/db` schema rows directly — `FuelDealInputs` is a plain TypeScript record with primitive fields. So copy-pasting works **as-is** with two caveats:

- **None of the schema imports come along.** The calc is self-contained.
- **`createId` and `TenantId`** appear in the *agent* file (`deal-evaluator.ts`) but NOT in the calculator. If you're only taking the calculator + tests, no domain imports needed.

---

## 4. What this unlocks for procur

Three direct use cases in procur's existing assistant tools:

### `evaluate_offer_against_history` — currently returns z-score vs distribution
**Add:** for each offer, call `calculateUnitEconomics(buildInputsFromOffer(...))` to surface per-USG margin. Return both verdicts: empirical (vs award_price_deltas) and modeled (vs cost stack). The modeled view tells the operator *whether the offer is profitable*, not just *whether it's in line with history*.

### `analyze_supplier_pricing` — currently returns avg delta vs benchmark
**Add:** when called for a supplier, project a cost stack using their geography (freight from supplier country to common buyer ports), compute the implied buyer-side price for each award, compare against the actual award price. Surfaces which suppliers are price-aggressive (small spread = thin margin = capacity-constrained or distressed) vs price-disciplined.

### `find_buyers_for_offer` — currently returns ranked buyer candidates
**Add:** for each candidate, compute the cost-to-deliver from the offer's origin to the candidate's typical port. Re-rank by *deliverable price* not just buyer affinity. This is the single biggest upgrade — buyers ranked by who can actually be served at margin, not just who buys this commodity.

---

## 5. Mechanical checklist for procur Claude

1. `cp /path/to/vex/packages/db/src/deals/calculator.ts <procur>/packages/pricing/src/calculator.ts`
2. `cp /path/to/vex/packages/db/src/deals/calculator.test.ts <procur>/packages/pricing/src/calculator.test.ts`
3. Read both files end-to-end. The calculator is heavily commented — section markers + invariants are baked into the comments.
4. Run the tests against the copy in procur's package — they should pass byte-identically. If any fail, the copy was incomplete.
5. Build `packages/pricing/src/benchmarks.ts` with the `product → benchmark` map (lift from `deal-evaluator.ts:255` — about 6 lines).
6. Decide one of:
   - **Procur owns its own price-feed table** (clean — recommend this). Procur's existing `commodity_prices` schema almost certainly has `(date, product, benchmark, price)` already.
   - **Procur reads from vex** (skip — would create a procur→vex dependency the integration brief explicitly excludes).
7. Wire the calculator into the three assistant tools above. Each adds 5–20 lines.

---

## 6. Things deliberately NOT in this handoff

- **The deal-evaluator agent itself.** Procur doesn't run agents in vex's tier-gated, approval-gated way. The calculator is the model; how procur exposes it is procur's call.
- **Cost-stack schema.** Vex stores per-deal cost stacks in `fuel_deal_cost_stack`. Procur doesn't have deals; you'll synthesize cost stacks on the fly from offer + freight rates + standard premiums. The calculator doesn't care where the inputs come from.
- **Counterparty risk scoring.** Vex has `fuel_deal_counterparty_scores` (8-dimensional risk model). Distinct from the pricing model and not needed for the assistant-tool integrations above.
- **Compliance state (OFAC / BIS / EEI).** Vex feeds `compliance` into `FuelDealInputs` and the calculator emits warnings. Procur doesn't have a compliance pipeline — pass `{ofac: 'unknown', bisRequired: false, ...}` defaults so warnings just don't fire on those codes.
- **Sensitivity grids + cashflow.** `calculateSensitivityGrids` and `calculateCashflow` are advanced (fuel-deal-detail UI uses them); the assistant tools above don't need them. Copy the code (it's already in calculator.ts) but don't bother wiring into procur surfaces in v1.

---

## 7. Open questions for the procur side

1. **Where do procur's price feeds live?** If `commodity_prices` is already populated nightly with Platts/Argus values, the integration is trivial. If not, procur needs an ingestion path before the calculator has anything to read.
2. **How does procur model freight?** The calculator takes `freightPerUsg` as a flat input. If procur has a freight-rate query (origin port + destination port + vessel class → $/USG), wire that in. Otherwise, fall back to a small reference table for common Caribbean lanes.
3. **Vessel utilization assumptions?** Vex sets `vesselUtilizationPct` per deal based on cost-stack negotiation. Procur should default to 0.95 (ideal load) for offer-scoring purposes, then surface "actual utilization" as a sensitivity dimension.

These are scoping decisions for the procur side, not blockers — the calculator works with reasonable defaults out of the box.

---

End of handoff.
