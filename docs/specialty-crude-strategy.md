# Specialty Crude Strategy — VTC's Higher-Margin Track

**Status:** strategic framing, not a build brief
**Owner:** Cole
**Last updated:** 2026-04-30
**Companion to:** `docs/commercial-strategy.md` (which describes VTC's broad commercial position; this document zooms into the specialty crude sub-niche specifically)
**Operational counterpart:** `docs/specialty-crude-30-day-plan.md` (the tactical execution plan for the first 30 days of this track)

This document describes the strategic case for VTC's specialty crude trading track, why it requires a structural setup distinct from the refined product business, what system additions are required to support it, and what discipline rules govern its execution. It is not a build brief but it specifies enough architecture that the build briefs to follow can be written from it.

If you're new to this project, read `docs/strategic-vision.md` and `docs/commercial-strategy.md` first. Those provide the technical and commercial context this document builds on.

---

## 1. The specialty crude niche, sharpened

The strategic vision document describes VTC as a "deal-origination engine using public-data signals nobody else is reading carefully." The commercial strategy document describes VTC as occupying "the sub-major Caribbean / LatAm physical commodity trading segment." Both are accurate. **This document describes the specific sub-niche where VTC's full structural stack — including Vector Antilles, Canadian credit access, and the data infrastructure — uniquely combines, and where margins are several multiples of the refined product business.**

The niche is:

> **Specialty crude single-cargo flows from sanctions-adjacent or politically-constrained origins (Russian, Venezuelan, Libyan, Iraqi-Kurdish, certain West African) into refining destinations that can accept these grades (Caribbean, Latin American, West African, Indian, Chinese, Turkish), structured through Vector Antilles to maintain compliance separation from VTC's U.S. entity, brokered as single-cargo transactions where VTC's data infrastructure adds the grade-matching specificity that the supermajors can't economically deploy at this scale and other small operators can't technically deploy at all.**

Every clause in that sentence is doing strategic work. The niche works because each constraint excludes a category of competitor:

- **"Specialty crude single-cargo"** excludes refined products (margins too small for compliance complexity) and bulk/term-contract crude (the supermajors' domain).
- **"From sanctions-adjacent origins"** is the source of the structural margin. Russian Urals trades at $15-25/bbl below Brent; Venezuelan Merey at $20-30/bbl below comparable heavy sour benchmarks; Libyan grades have their own discount dynamics. The discount exists because the buyer pool is structurally smaller — most U.S., EU, Japanese, Korean buyers can't transact, leaving Indian, Chinese, Turkish, UAE-based, and a handful of other entities. **Trading margins at the cargo level are routinely $2-5/bbl gross. On a 1M-bbl cargo that's $2-5M gross margin. Compare to refined product brokerage at $15-60K per cargo.**
- **"Into refining destinations that can accept these grades"** specifies the buyer universe and reflects the freight-vs-grade-fit reality. For specialty crude, grade-fit dominates freight; the geographic universe of viable buyers expands beyond the Caribbean into Indian, Chinese, Turkish, Mediterranean refiners.
- **"Structured through Vector Antilles"** is the critical enabler. VTC LLC (Houston) cannot transact in this space; the U.S. entity's banking and compliance perimeter exclude it. The Dubai FZCO with DIB banking, run by a Canadian citizen, *can*. **The structure is what makes the strategy executable.**
- **"Where data infrastructure adds grade-matching specificity"** is the differentiator from other Dubai-based or Asian intermediaries who could theoretically occupy this space. They have the structural compliance fit but typically not the systematic data infrastructure to support it. VTC's stack provides exactly this.

---

## 2. Why this niche only VTC can occupy

The architectural test: **could anyone else credibly do this?**

- **The supermajors (Vitol, Trafigura, Mercuria, Glencore, Gunvor)** — no. Single-cargo deal sizes ($45-80M) are below their floor. They have the relationships and the capital but the unit economics don't work at this scale.
- **The supermajors' regional desks** — closer, but still constrained. They might do these as accommodations to existing customers but not as a primary business. Their P&L expectations and operational overhead don't fit single-cargo specialty work.
- **Russian/Iranian/Venezuelan-aligned trading houses (Litasco, Coral Energy, others)** — they do the volumes and have upstream supplier relationships. **They lack U.S.-credible Canadian-EDC-eligible last-mile distribution into Caribbean / LatAm / West Africa.** Their structural strength is upstream sourcing, not regional placement.
- **Indian and Chinese major traders** — Reliance, Indian Oil, Sinopec, Unipec, etc. They move significant volumes but mostly into their own domestic refining systems. They don't typically broker into Caribbean or West African destinations.
- **Other small Dubai-based traders** — there are some. **Most are not Canadian-citizen-owned with a parallel U.S. credibility entity.** Most don't have the data infrastructure VTC has built. Most don't operate with the operational discipline systems VTC has encoded.
- **Small Caribbean / LatAm brokers** — they have relationships but lack the Dubai structure, the Canadian credit access, and the data infrastructure. The combination is structurally unavailable to them.

**The combination of advantages required to occupy this niche credibly — U.S. credibility entity + offshore sanctions-flexible entity + Canadian credit access + tech infrastructure + small-operator agility + Caribbean-LatAm-West-African distribution + operational discipline systems — appears to be unique to VTC.** No other identifiable operator combines all of them at small scale. This is the strategic asymmetry that justifies committing infrastructure and operator attention to this niche.

---

## 3. Margin economics — why this is the high-margin track

A typical Caribbean refined product brokerage transaction:
- Cargo size: 5,000-15,000 MT (~$3-10M)
- Brokerage / margin: 1.0-2.5% of cargo value
- Gross per cargo: $30,000-250,000
- Compliance overhead: low (standard OFAC, standard documentation)
- Capital deployment: minimal if pure brokerage
- Cycle time first-contact-to-close: 60-90 days

A typical specialty crude single-cargo transaction in this niche:
- Cargo size: 600,000-1,000,000 bbl (~$45-80M)
- Brokerage / margin: 0.3-1.5% of cargo value (lower percentage but on much larger base)
- Gross per cargo: $135,000-1,200,000
- Compliance overhead: high (route-aware compliance, banking confirmation, structured documentation)
- Capital deployment: minimal if pure brokerage; cargo-specific if principal
- Cycle time first-contact-to-close: 90-180 days for first deal, faster for repeat deals with established counterparties

**The headline: a single specialty crude cargo can produce 4-10x the gross of a single refined product cargo.** The deal volume is proportionally lower (1-2 deals per quarter vs. 2-4 per month), but the annual gross potential is similar or higher with much smaller operational footprint per dollar of revenue.

**Why specialty crude trading cannot be the only track.** Two reasons:
1. **Cycle time means the first 6-12 months produce no revenue from this track.** Refined product Caribbean is the cash-generating engine that funds the patience required for crude.
2. **Refined product trading produces operational rhythm and counterparty learning that crude does not.** The day-to-day deal flow keeps the team sharp on documentation, compliance, payment, and execution. Without that rhythm, when a crude deal lands, the operational muscle memory has atrophied. Refined product is the practice; crude is the championship.

The two tracks are complementary, not competing. Both depend on the same infrastructure but exercise different parts of it.

---

## 4. The structural risk frame

This niche has materially higher inherent compliance and reputational risk than refined product Caribbean trade. Naming the risks explicitly:

**Compliance risk.** Sanctioned-adjacent crude trading has multiple overlapping sanctions regimes (OFAC, EU, UK, Canadian, Australian, G7 oil price cap mechanism). Each transaction must be evaluated against all of them. A trade structure that's compliant under OFAC may be non-compliant under EU sanctions. A trade compliant today may become non-compliant if an entity is added to a sanctions list mid-execution. **The penalty for getting compliance wrong is severe** — OFAC enforcement actions, banking de-risking (loss of accounts), reputational damage, and in extreme cases personal sanctions on the operator.

**Banking risk.** Banks in U.S., EU, and UK jurisdictions have systematically de-risked from sanctions-adjacent trade. A bank that processes a payment with sanctions exposure faces enforcement penalties orders of magnitude larger than the customer's transaction value, so banks tend to over-shut accounts rather than risk it. **VTC's primary banking relationship for this niche is Dubai Islamic Bank**, which operates outside the U.S. correspondent banking pressure that drives most de-risking. Maintaining DIB as the primary banking relationship for Vector Antilles is non-negotiable.

**Fraud risk.** Crude trading has structurally higher fraud volume than refined products. Large cargo values, complex documentation, multi-jurisdiction transactions, and a long history of scams targeting small operators in this space (advance-fee schemes, fake bills of lading, ghost cargoes, documentary credit fraud). **The first 3-5 deals offered to VTC in this niche should be assumed to include tests, some legitimate and some fraudulent.** Discipline rules (independently verify cargo exists via vessel tracking, never advance payment before independent verification, refuse opaque documentation chains) are the defenses.

**Reputational risk.** A bad trade in this niche has reputational consequences that follow the operator personally. Even if Vector Antilles is the contracting entity, the operator's name is associated. Mistakes are durable.

**Iran-specifically risk.** Iranian crude trading post-2018 sanctions environment is genuinely high-margin and there are people doing it. There are also people in U.S. federal prison for doing it. **The OFAC enforcement reach for Iranian-origin trades is broader than people assume**, and the compliance line is genuinely difficult to maintain even with offshore structures. **Iran is explicitly out of scope for VTC.** Russia / Venezuela / Libya / Iraqi-Kurdish all have legitimate paths under appropriate structures; Iran does not for any U.S.-citizen-connected operator. This boundary is hard.

The risk frame doesn't argue against entering the niche — the margins justify the risk *if the discipline is maintained.* It argues for entering only with the discipline framework explicit, the compliance infrastructure built, and outside legal counsel engaged before any specific deal lands.

---

## 5. The four required system additions

Beyond what's currently built in procur+vex, the specialty crude niche requires four specific extensions. None individually is large; collectively they constitute roughly 6-10 days of focused work.

### 5.1 Route-aware compliance infrastructure

The current OFAC integration in vex screens individual entities. This niche requires *route-aware* compliance — evaluating not just "is this counterparty cleared" but "is this trade structure compliant given the cargo origin, the title-transfer points, the payment routing, and the jurisdictions of all parties."

**New schema in vex: `trade_compliance_routes`.** Each row captures a proposed trade structure:
- Cargo origin (port, country, producer entity, grade)
- Title-transfer geography (offshore STS, port-to-port, etc.)
- Discharge port and buyer entity
- Payment currency and routing banks
- Insurance arrangements
- All counterparty entities at each step

The row evaluates against:
- OFAC sectoral sanctions for origin country and commodity
- Specific OFAC General Licenses or specific licenses that may apply
- EU, UK, Canadian, Australian sanctions regimes
- The G7 oil price cap mechanism on Russian crude (if applicable)
- Counterparty entity status across all sanctions lists, not just SDN

**New assistant tool: `evaluate_trade_route`.** Takes a proposed trade structure as input. Returns a compliance assessment with specific findings, cited rules, and recommended adjustments. Counsel reviews any non-trivial assessment before VTC responds substantively to a counterparty. The tool's role is to compress what would otherwise be a 5-10 day legal review cycle into a 24-48 hour cycle for routine cases, with counsel only deeply engaged on novel structures.

### 5.2 Bilateral counterparty network for sanctions-flexible markets

The current `known_entities` rolodex is heavily focused on public-procurement-visible entities. **For this niche, the relevant counterparty universe is mostly invisible in public data** — Russian-origin trading houses don't appear in OCDS feeds, Indian refiner crude procurement teams aren't in tender databases, specialty Dubai-based traders don't post awards.

**Schema extension: a `visibility` flag on `known_entities` (or a separate `bilateral_counterparties` table).** Captures:
- Russian, Indian, Chinese, Turkish, UAE-based trading entities relevant to sanctioned-origin flows
- Named procurement teams at refineries that buy these flows (Indian Reliance, Chinese Sinopec / Unipec, Turkish Tüpraş, etc.)
- State oil company marketing arms (Sonangol, NOC Marketing for Libya, KPC, Sonatrach, etc.)
- Specialty intermediaries handling ad-hoc cargo placements

Universe is small (200-400 entities total) and stable (doesn't decay quickly once researched). Building it is a 60-90 day research workstream of systematic enrichment via existing procur tools (web search, news search, LinkedIn) plus manual operator curation.

### 5.3 Cargo-level transaction structure templates

Specialty crude trades in this niche have specific structural patterns that recur:
- Russian Urals to Indian refiners through UAE-based intermediaries: Dirham or Yuan settlement, offshore Fujairah or Singapore strait STS title-transfer
- Libyan crude to Mediterranean refiners: USD or EUR settlement, conventional FOB / CIF structure
- Venezuelan crude under specific OFAC licenses: complex structure depending on license type
- Caribbean refined product (the existing playbook, documented formally for completeness)
- West African specialty grades to Indian / Chinese refiners

**A vetted library of 8-15 transaction structure templates**, each documenting a specific origin × destination × payment route combination with legal, banking, insurance, and operational specifics. Each template:
- Reviewed and validated by outside counsel
- Stored in a `transaction_structures` table in vex with the documented blueprint
- Available as a starting point in deal creation flow — operator selects applicable template, system populates structural blueprint

The investment is 6-15 lawyer hours per template (~$3-7K each), so $25-100K total for the initial library. Done once, reused across many deals. **This is the legal infrastructure cost that small competitors can't credibly fund and the majors don't bother with at the cargo level.**

### 5.4 Discount market pricing intelligence

Current pricing analytics tuned to Brent / WTI / refined product spot benchmarks. **For this niche, the relevant pricing is the discount level itself** — Russian Urals at -$15 to -$25/bbl below Brent, Venezuelan Merey at its own discount dynamic, Libyan grades with their own basis, etc.

These discount levels are not in EIA, FRED, or OilPriceAPI's free tier. Sources:
- Trade press (Reuters, Argus public-news, S&P Commodity Insights public articles) — free, lossy, requires LLM extraction
- Specialty industry reports (selective subscriptions, ~$5-10K/year combined for the most relevant ones)
- **Most importantly: prices reported by VTC's own counterparties during outreach and quote conversations.** Each call, each quote, each proposed structure includes a price point that contributes to the discount-market estimate.

**New schema: `discount_market_observations`.** Captures every price point observed from any source with provenance. Maintains a rolling estimate of the current discount for each grade. Becomes both a pricing-intelligence asset (VTC can quote discount levels with rigor) and an outreach instrument (VTC can lead conversations with empirical observations about where the market is pricing). The system extension is small (~1 day of schema + ingestion work).

---

## 6. The compliance and operational discipline rules

Six rules that govern how the niche is operated. These extend the discipline rules in `docs/origination-partners-brief.md` §9 to specialty crude specifically.

### Rule 1: Religious entity separation between VTC LLC and Vector Antilles

Non-negotiable. Vector Antilles has its own banking, its own counterparty list, its own contracts, its own books and records, its own employees (if any), its own correspondence and email signatures. **Customers of one are not customers of the other.** Information may flow informally (the operator knows what's happening on both sides), but operational and legal infrastructure are fully separate.

The visible test: a Dubai counterparty looking up Vector Antilles should find a self-contained entity with its own brand, address, banking, and operating history. They should not find evidence that the entity is "an offshore arm of a Houston trading firm." The structural separation must be visible to anyone investigating.

### Rule 2: Outside counsel engaged before any specific deal lands

A sanctions-and-commodity-trade attorney with relevant background (Treasury OFAC alumnus, DOJ National Security Division, or major firm sanctions practice) on retainer at all times during specialty crude operations. Retainer typically $15-30K initial + hourly billing. **Built before need, not at moment of need.**

The role: rapid review of proposed trade structures (24-72 hour turnaround), validation of transaction templates, advice on sanctions developments, and crisis response if issues arise.

### Rule 3: Per-cargo collateral and exit conditions

If VTC takes principal on any specialty crude cargo (vs. pure brokerage), specific cargo (BL or warehouse receipt as collateral), specific counterparty payment commitment (LC, escrow, or operator-approved alternative), and specific exit conditions (when capital exits the deal) must all be verified and recorded before capital deploys. This is enforced at the approval-gate level in vex. **No partner-introduced or operator-discretionary deal can go live without the per-cargo collateral check.**

### Rule 4: No working capital lines or financing extended to counterparties

Vector Antilles does not provide trade finance to suppliers, brokers, intermediaries, or buyers. Every dollar of capital VTC commits is allocated to a specific cargo with specific collateral. **The Pattern A boundary from `docs/origination-partners-brief.md` applies fully to specialty crude operations.** Pattern A (trade finance to counterparties) is explicitly out of scope for both VTC LLC and Vector Antilles.

### Rule 5: Iran is out of scope

Iranian-origin crude or refined products, Iranian-controlled entities, Iranian-flagged vessels, or any structure with Iranian connection is not in scope. **No exceptions.** The OFAC enforcement reach for Iran is broader than other sanctioned origins; the compliance line is genuinely difficult to maintain even for sophisticated operators with offshore structures; and the available legal margin for error is essentially zero. Russia / Venezuela / Libya / Iraqi-Kurdish all have legitimate paths under appropriate structures; Iran does not.

### Rule 6: Document every interaction substantively

Every counterparty conversation, every cold message, every introductory call, every quote received, every deal evaluated, every deal declined — documented in vex within 4 business hours of the interaction. The documentation is not for the system; it's for the operator's own records and for any future regulatory audit. **A trade audited 18 months later that lacks contemporaneous documentation is much harder to defend than a trade that has it.** The system supports this; the discipline is operator behavior.

---

## 7. The strategic position relative to other VTC tracks

Specialty crude is one of three concurrent VTC tracks, each operating on a different tempo and counterparty universe but sharing the same infrastructure:

| Track | Volume | Margin per deal | Cycle time | Risk profile | Entity |
|---|---|---|---|---|---|
| **Caribbean refined product** | 2-4 deals/month | $30-250K | 60-90 days | Low | VTC LLC |
| **Specialty crude single-cargo** | 1-2 deals/quarter | $135K-1.2M | 90-180 days | Medium-high | Vector Antilles |
| **Origination partner network** | Variable, partner-dependent | Variable | 30-90 days post-relationship | Medium | VTC LLC primarily |

Capacity allocation: ~70% operator attention to refined product (the cash-generating engine), ~20% to specialty crude (the high-margin track during build phase), ~10% to origination partners (until track record supports more aggressive recruitment).

The three tracks reinforce each other. Refined product generates the cash flow that funds patience on specialty crude. Specialty crude relationships sometimes produce refined product opportunities as a byproduct. Origination partners feed both tracks once active.

---

## 8. The 18-month destination state

If the strategy executes, what does the specialty crude track look like at 18 months from start?

**Counterparty network**: ~150 active Tier 1+2 relationships across specialty crude sellers (sovereign marketing arms, Russian-origin trading houses, specialty intermediaries) and crude-buying refiners (Indian, Chinese, Turkish, Caribbean, LatAm, West African).

**Transaction templates**: 12-15 vetted templates covering the realistic structural universe of deals that have occurred. Each refined through experience.

**Closed deals**: 4-8 closed cargoes over 18 months, generating $1-5M in gross margin against relatively flat operational cost. The fixed cost of compliance infrastructure (counsel, banking, KYC) is amortized across deals; marginal cost per additional deal is very low.

**Track record artifact**: a documented portfolio of executed trades (anonymized as appropriate) that can be referenced when (a) approaching the supermajor sub-floor referral conversations, (b) potentially raising capital for a Stage-3 trade book, or (c) approaching new specialty counterparties cold with credibility.

**System maturity**: route-aware compliance evaluation operating in production, bilateral counterparty network at ~250 entities with rich enrichment, transaction templates as a vetted library, discount market pricing intelligence with hundreds of observations creating a credible empirical view of where the market is pricing across the specialty grades.

This destination state is realistic if the operational rhythm holds and the discipline rules are maintained. It's not aggressive on any single dimension — modest deal count, conservative timelines on relationship building. The asymmetry is in the unit economics: 4-8 deals at this scale produce more margin than 50-100 refined product deals over the same period, and the infrastructure is largely paid for once and reused.

---

## 9. The strategic decision encoded in this document

The strategic vision document positioned VTC's destination as a deal-origination engine using public-data signals. The commercial strategy document positioned VTC as the sub-major Caribbean / LatAm operator. **This document positions specialty crude through Vector Antilles as the structural niche only VTC can credibly occupy.**

These three positions are concentric, not competing. The broadest is "deal-origination engine." Within it sits "sub-major Caribbean / LatAm trader." Within that sits "specialty crude through Vector Antilles for sanctions-flexible flows." Each level inherits the discipline of the level above it; each level adds specific structural advantages that compound the previous level's positioning.

If anyone reading the codebase later — you in 18 months, a future hire, a capital partner, future Claude Code — questions why VTC has this specific structural setup, the answer traces back through these three documents:

- **What is the technical system?** → `docs/strategic-vision.md`
- **What is the commercial business?** → `docs/commercial-strategy.md`
- **What is the highest-margin structural niche?** → this document

Read in that order. Each document explains why the next one looks the way it does.

---

End of specialty crude strategy document.
