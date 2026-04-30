# Specialty Crude — 30-Day Operational Plan

**Status:** active operational plan
**Drafted:** 2026-04-30
**Owner:** Cole
**Lifecycle:** This is a 30-day tactical plan. It supersedes itself every 30 days. At the end of the period, write a brief retrospective and a fresh 30-day plan rather than treating this document as the standing operating procedure. The strategic backbone is `docs/specialty-crude-strategy.md`; this is the tactical execution layer.
**Read first:** `docs/specialty-crude-strategy.md` (the strategic case), `docs/commercial-strategy.md` (the commercial frame), and `docs/strategic-vision.md` (the technical vision)

This document is the actual operational plan for the first 30 days of VTC's specialty crude track. It assumes the strategic case in `docs/specialty-crude-strategy.md` has been internalized and the Day-0 prerequisites (entity discipline rule documented, outside counsel engaged) are committed.

---

## 0. Day-0 prerequisites — must complete before Day 1

Two non-negotiables. If these don't happen, the plan below collapses.

### 0.1 Entity discipline rule documented and signed

Today, write down and sign an internal policy memo on Vector Antilles operational separation from VTC LLC. The memo states:

- Vector Antilles maintains its own banking (DIB), its own counterparty list, its own contracts, its own books and records, its own correspondence and email signatures.
- Customers of one entity are not customers of the other.
- No employee of VTC LLC works on Vector Antilles trades and vice versa unless documented as a separate engagement with separate compensation.
- All counterparty-facing communications clearly identify which entity is engaging.
- The discipline applies to operational, banking, contractual, and informational separation.

This memo is the artifact that demonstrates discipline if anyone ever investigates. It takes 30 minutes to write. Do it before anything else.

### 0.2 Outside counsel engaged this week

Engage a sanctions-and-commodity-trade attorney with relevant background. Recommended profiles: Treasury OFAC alumnus, DOJ National Security Division alumnus, or partner at a major firm's sanctions practice (Akin Gump, Wiley Rein, Steptoe, Crowell & Moring, Holland & Knight all have known practices in this area).

The retainer engagement is typically $15-30K to start the relationship, with hourly billing on top. **Initiate the conversation this week, before Day 1 of the plan starts.** Every other workstream depends on having this person available for fast turnaround on specific questions.

The engagement letter should scope: (1) initial review of Vector Antilles structure and applicable sanctions regimes (OFAC, EU, UK, Canadian, Australian) for a Dubai FZCO with Canadian-citizen ownership and DIB banking, (2) written memo identifying which trade structures are clearly compliant in this configuration, (3) ongoing availability for specific deal-level reviews on 24-72 hour turnaround.

If counsel can't deliver the initial memo within 14 days of engagement, this is the wrong counsel — find someone who can.

---

## 1. Days 1-7 — Foundation week

The week is about getting legal, structural, and informational foundation solid enough to support outreach starting Day 8.

### 1.1 Legal foundation track

**Day 1**: Engagement letter signed with outside counsel. Initial intake call. Counsel begins review.

**Days 2-3**: Counsel reviews Vector Antilles operating documents. Identifies any gaps that need closing before transacting (likely findings: clearer operating agreement, documented separation policies with VTC, compliance manual specific to sanctioned-origin trade).

**Days 4-7**: Execute on whatever counsel flags. Most of this is paperwork and signing; minimal time impact.

### 1.2 System schema additions track (parallel to legal)

Write a build brief for the four schema additions specified in `docs/specialty-crude-strategy.md` §5: `trade_compliance_routes`, `bilateral_counterparties` (or visibility extension), `transaction_structures`, `discount_market_observations`. Have Claude Code execute the brief.

This is roughly 1-2 days of Claude Code work. The brief specifies:
- Schema definitions for all four tables
- Migration sequence (next available migration numbers in vex)
- Assistant tool: `evaluate_trade_route` that takes a proposed structure and returns a preliminary compliance assessment based on counsel-validated rules
- Assistant tool: `lookup_bilateral_counterparties` for querying the sanctions-flexible network
- Assistant tool: `apply_transaction_template` for populating deal blueprints from the validated template library
- Initial seed data: skeleton entries for the 30-40 Tier 1 counterparties to be researched in parallel

### 1.3 Counterparty research track (start Day 1, runs throughout)

The full universe is 200-400 entities and is a 60-90 day buildout. The first month focuses on the first 30-40 entities — the Tier 1 priority list:

**Specialty Dubai-based crude trading houses** (~5):
The universe of UAE-based intermediaries handling Russian / Iranian-history / Venezuelan flows. Build the list through public sources (DIFC company registry, Dubai trade press, LinkedIn for named commercial directors).

**Indian refiners with crude procurement teams that take sanctioned-origin grades** (~5-7):
Reliance, Nayara Energy, IOCL, BPCL, HPCL. Start with Reliance and Nayara since they're the known buyers of sanctioned-origin volumes. Identify named procurement directors via LinkedIn + press.

**Turkish refiners that take Russian / Caspian / Mediterranean grades** (~3-4):
Tüpraş, STAR Refinery, others. Identify named commercial directors.

**Producing-country marketing arms relevant to VTC's geography** (~5-6):
Sonatrach (Algeria), NOC Marketing (Libya), Sonangol (Angola), KPC (Kuwait), ADNOC (UAE), Saudi Aramco trading arm (selectively). Most of these have published commercial contacts.

**Russian-origin trading houses operating with sanctions-flexible counterparties** (~4-5):
Litasco, Coral Energy, others. Public information is limited but available.

**Caribbean / LatAm refiners that could plausibly receive specialty crude** (~4-6):
Refidomsa (DR), Petrojam (Jamaica), Curaçao operations, Trinidad operations, Mexican Pemex regional commercial groups.

**Specialty intermediaries handling ad-hoc placements** (~3-4):
These you discover as you research. Names emerge through trade press analysis, LinkedIn searches for specific deal patterns, and sometimes through interactions with the more visible counterparties above.

**Total ~30-40 entities researched by end of Week 1.** Each gets a research run through procur's existing tools (web search, news search, LinkedIn enrichment) plus manual operator curation. Target: 4-6 entities per day. Each entity ends up with a populated `bilateral_counterparties` row containing: legal name, jurisdiction, beneficial ownership where known, named contacts, recent commercial activity patterns, sanctions status across all relevant regimes.

### 1.4 Templates documentation track (start Day 3)

Begin documenting the first 6-8 transaction structure templates. Don't try to do all 15 at once. Start with structures most likely to come up first:

1. **Russian / Caspian crude** FOB Novorossiysk → STS Fujairah → CIF Indian refiner, Dirham settlement
2. **Algerian / Libyan crude** FOB origin → CIF Mediterranean refiner, EUR or USD settlement (mostly compliant, no sanctions exposure)
3. **Caribbean refined product** FOB Houston / Cartagena → CIF Caribbean buyer, USD settlement (existing playbook, document formally)
4. **West African specialty grade** FOB origin → CIF Indian / Chinese refiner, USD settlement
5. **Cuba-routing structure** (separate template, with explicit OFAC SCP / CACR analysis)
6. **Venezuelan crude** under specific OFAC license types (multiple sub-templates depending on license)
7. **Russian Urals under G7 oil price cap** (specific compliance structure required)
8. **Generic specialty crude FOB** with payment via LC at sight

Each template is a 4-8 page document covering: legal structure, payment routing, banking confirmations needed, BL conventions, insurance arrangements, specific compliance tests, and any standing concerns counsel has flagged. Counsel reviews each before it becomes a "validated template" — typically 2-4 hours of legal time per template.

End of Week 1 deliverables:
- Outside counsel engaged and initial intake complete
- Schema additions live in vex
- 30-40 Tier 1 counterparties researched and entered in `bilateral_counterparties`
- 3-4 transaction templates drafted (counsel review pending)

---

## 2. Days 8-14 — First outreach wave + foundation hardening

Outreach starts Day 8. The first wave is intentionally small — 8-12 messages, all to the most strategic targets. Week 2 isn't volume; it's calibration.

### 2.1 Outreach targets (8-12 contacts, all Tier 1)

Pick from the researched universe. Suggested distribution:
- 2-3 specialty Dubai trading houses
- 2-3 Indian refiners' crude procurement teams (Reliance and Nayara prioritized)
- 2-3 producing-country marketing arms (Sonatrach, NOC, Sonangol)
- 1-2 Caribbean / LatAm refiners

### 2.2 Message structure for this niche

Crude outreach is structurally different from refined product outreach. Refined product cold messages position VTC as a generic small trader with regional infrastructure. Crude messages position Vector Antilles as a placement specialist with specific destination capability (when reaching out to sellers) or as a sourcing specialist with access to grades they may not see (when reaching out to refiners).

**Sample opener to a Dubai trading house:**

> Subject: [Specific grade/region] cargo placement — Caribbean / LatAm / West African destinations
>
> [Contact name],
>
> VTC's Dubai-based affiliate operates trade flows into Caribbean, Latin American, and West African refining destinations. We've been tracking the placement profile of [specific grade] cargoes through Q2-Q3 and have observed [specific pattern that demonstrates real analysis — drawn from the system].
>
> Our placement infrastructure includes [specific destination markets] with documented capability to handle [specific trade structures]. Open to a 30-minute call if there are cargoes you're looking to place into our destinations — happy to discuss our payment, insurance, and discharge arrangements.
>
> [Vector Antilles signature, DIB banking reference, Dubai address]

**Sample opener to an Indian refiner crude procurement:**

> Subject: Specialty crude grade fit for [Refiner] slate — ad-hoc cargo placement
>
> [Contact name],
>
> VTC's Dubai-based affiliate sources specialty crude grades for placement at refineries with appropriate slate fit. Looking at your facility's slate configuration, your unit appears optimized for [grade characteristic profile] crude with [specific tolerance range].
>
> We have visibility into [specific origin] grades that fit this profile, including occasional cargoes outside the typical term-contract structure. Would your crude procurement team be open to a call about ad-hoc placement opportunities? Cycle time from inquiry to delivered cargo is typically 30-45 days under our standard structures.
>
> [Vector Antilles signature]

These messages are short, technical, and signal sophistication immediately. Volume is much lower than refined product outreach because each message requires more thought, but response rate per message should be substantially higher.

### 2.3 Outreach pacing

Send **1-2 messages per business day** for this first week. Same-business-day reply discipline on any responses. Track every reply in vex with the `bilateral_counterparties` reference, the message variant sent, the response (or non-response), and operator notes.

### 2.4 Foundation hardening continuing

- Counsel's first written memo arrives mid-week. Read carefully, ask follow-up questions, refine trade-structure assumptions based on it.
- Schema work in vex completes. The `trade_compliance_routes` table is populated with the first 6-8 templates (counsel-validated as they complete review).
- Continue researching the next 30-40 counterparties for Tier 2 expansion in Week 3.

End of Week 2 deliverables:
- 8-12 outreach messages sent
- 3-5 replies received (target ~25-40% reply rate at this niche)
- 1-2 introductory calls scheduled
- Counsel's foundational legal opinion received and digested
- 6-8 templates validated by counsel

---

## 3. Days 15-21 — Volume ramp + first calls

Foundation is solid by Week 3. Outreach volume ramps and the first introductory calls happen.

### 3.1 Outreach volume

**15-20 net-new messages** across the week. Mix:
- Remaining Tier 1 contacts from the original 30-40 list
- Beginning of Tier 2 (additional Indian refiners, Chinese refiners' Singapore-based procurement arms, Turkish refiners, additional producing-country marketing arms)

### 3.2 The first introductory calls

These calls are the relationship event. Target 3-6 of them this week if outreach is working.

**Call structure** (recommended ~30-40 minutes):

- 5 minutes mutual introduction — both sides describe their operation
- 15-20 minutes substantive discussion — the *specific* topic they responded to. Not generic. If the outreach was about Russian Urals placement into Indian refiners, the entire call is about that. Demonstrate the depth of data analysis on the specific topic.
- 5-10 minutes on what would have to be true for a first transaction — compliance structure, payment instrument, documentation requirements, timing. This flushes out whether the relationship is real or theoretical.
- Concrete next step before ending — *"send me your standard term sheet for [structure]"*, *"let me check with my procurement team on near-term cargo positions"*, *"happy to circulate our standard MNDA"*. **Never end with "let's stay in touch" without a specific next action.**

### 3.3 Post-call discipline

After every call, write a structured summary in vex within 4 hours. Capture: who attended, their commercial interests, what they signaled about deal flow, what objections came up, what the agreed next step is. The system supports this through existing call-summary infrastructure. **Discipline is in actually doing it, not in the technology.**

### 3.4 Compliance-route population

For each promising introductory call, log the specific trade structure they're interested in into `trade_compliance_routes`. Have `evaluate_trade_route` produce a preliminary compliance assessment. Counsel reviews any non-trivial assessment before VTC responds substantively. **Target: compliance clarity within 24-48 hours of a call** rather than the multi-week cycle most small operators face.

End of Week 3 deliverables:
- ~25-30 total contacts initiated (cumulative)
- 3-6 introductory calls completed
- Each call documented in vex with structured summary
- 1-3 specific deal structures evaluated through `trade_compliance_routes`
- Counsel review on at least 1-2 deal-specific structures

---

## 4. Days 22-28 — Second-wave outreach + early deal evaluation

By Week 4 operational rhythm is established. Outreach continues at sustained volume. New work this week is evaluating specific opportunities that have surfaced.

### 4.1 Outreach: 15-20 more messages

Completing Tier 1 and continuing into Tier 2. By end of Week 4 cumulative contacts: ~40-55 entities across the strategic universe — roughly the bulk of Tier 1 plus a fraction of Tier 2.

### 4.2 Specific opportunities surface

Realistically, by Week 4 there should be **2-4 specific cargo-level discussions in some stage of development.** Not closed deals — discussions. Examples:

- A specialty Dubai trader has a Russian Urals cargo loading from Novorossiysk in 21 days, looking for placement at Indian or Turkish refiners, asking if VTC has a confirmed buyer.
- An Indian refiner mentions flexibility on a 600,000 bbl crude slot in 45 days and would consider a non-term-contract origin if the price differential justifies it.
- A Caribbean refiner mentions supply tightness on light sweet and would consider an alternate origin.
- A West African producer's marketing arm mentions an ad-hoc cargo position outside their normal term contract structure.

For each, the work is matching supply-side to demand-side and structuring the trade. This is what the system is built to do — `evaluate_trade_route` for compliance, the new pricing intelligence for differential analysis, OFAC at every step, transaction structure templates as starting points.

### 4.3 Realistic outcome

**At least one deal moving toward execution by end of Week 4.** Not closed — closing crude deals takes 60-120 days from first conversation typically. But moving toward execution with structure agreed, terms in negotiation, compliance cleared, payment instrument identified.

End of Week 4 deliverables:
- ~40-55 total contacts (cumulative)
- 6-10 introductory calls completed (cumulative)
- 2-4 active deal-level discussions
- 1+ deal moving toward execution

---

## 5. Days 29-30 — Pause, evaluate, document

Two days of explicit work to consolidate learning and prepare the next 30-day cycle.

### 5.1 Day 29 — Pipeline and learning review

For each entity contacted, what's the current status? What was the response rate by entity type (specialty Dubai vs. Indian refiner vs. producing-country marketing arm vs. Caribbean refiner)? Which messages worked? Which didn't? Which trade structures came up most often? Which compliance issues are recurring?

Write this down. Either in your head, in vex's strategy section, or in a fresh `docs/specialty-crude-month-1-review.md` file. The system makes the data accessible; the value is in the operator's reflection on it.

### 5.2 Day 30 — Prep next 30 days

The next 30-day plan is a continuation, not a redesign. Most likely:

- Continue outreach to fill out Tier 2 (~30-50 more entities over 30 days)
- Push 1-3 active deal discussions toward execution
- Refine transaction templates based on what was learned
- Add 2-4 new transaction templates for structures that emerged that weren't anticipated
- Tighten the bilateral_counterparties data based on what worked

**The first deal close target: end of Month 3 from start, give or take 30 days.**

---

## 6. The disciplines that determine whether the plan works

Three operational rules must hold or the plan falls apart.

### 6.1 Reply within 4 business hours, every time

This niche has zero tolerance for slow replies. Counterparties responding to a cold message are testing whether VTC is a real operator. A 24-hour reply tells them VTC is not. The system supports this through vex's `follow-ups` infrastructure with priority routing on Tier 1 counterparty replies.

### 6.2 Document every interaction, including failures

Every cold message that didn't get a reply, every call that didn't lead anywhere, every counterparty who declined — all of this goes into vex. The information value is high because the patterns reveal the niche's real shape: which counterparties are receptive, which aren't, which trade structures are practically executable.

### 6.3 Religious entity separation between Vector Antilles and VTC LLC

Cannot drift. No customer of one is a customer of the other. No employee works for both unless documented as separate engagements. No banking, no shared infrastructure, no shared correspondence. The discipline is operational, not just legal — visible in how VTC communicates with counterparties, what email signatures are used, what entities are referenced in introductions.

---

## 7. What this plan does and does not include

**Includes:**
- Full foundation work in Week 1 (legal, schema, research)
- Outreach starting Day 8, ramping through Week 4
- ~50-60 outreach contacts by end of Month 1
- ~10-15 introductory calls
- 2-4 specific deal-level conversations underway
- 6-8 transaction templates documented (with counsel validation)
- 1+ deal moving toward execution

**Deliberately does not include:**
- Closing the first deal in 30 days (unrealistic; 60-90 day target from initial contact)
- Reaching all 200-400 of the eventual counterparty universe (months 4-12 work)
- Building the full discount-market pricing intelligence (start in Month 2-3 once data points exist from VTC's own deals)
- Any work on Iran-related flows (out of scope, full stop)
- Compromising VTC's Caribbean refined product business (continues unchanged in parallel)

---

## 8. Risks and mitigations

Three risks worth naming explicitly.

### 8.1 Counsel scheduling

If counsel can't be engaged in Week 1 with fast turnaround on the initial memo, the whole plan slips. **Mitigation:** start counsel outreach today, not on Day 1. The retainer conversation can happen this week regardless of when the rest starts.

### 8.2 Counterparty silence

If the first 12 outreach messages produce zero responses, the issue is probably the message, not the universe. **Mitigation:** explicit calibration check at end of Week 2. If reply rate is below 15%, rewrite the messaging before scaling volume in Week 3. Don't ramp into a broken message.

### 8.3 A deal that comes too fast

Opposite risk — a real cargo opportunity in Week 3 requires fast decision before the transaction-template library is mature, before counsel is up to speed on VTC operations, before banking is fully aligned. **Mitigation:** have a "fast-deal protocol" written down by end of Week 1. Specifically: any deal that comes faster than Week 4 gets compressed-but-complete diligence with counsel involvement at every step, even if it slows the deal. **Better to lose the first opportunity than to take a deal that can't be executed cleanly.**

---

## 9. The four commitments required for the plan to work

This plan only works if these four are committed:

1. **$30-50K spent on legal foundation in Month 1** (counsel retainer + template review work).
2. **Religious entity separation between Vector Antilles and VTC LLC. Every interaction.**
3. **Documentation discipline — every counterparty, every call, every learning recorded.**
4. **Willingness to walk away from the first attractive-looking deal if it can't pass clean compliance review.** There will be tests; some will fail.

If those four are committed, the 30-day plan is genuinely executable at the pace described. If any of them are not, the plan needs to be either delayed (build foundation first, do outreach later) or redirected (stay in refined product Caribbean trade where the compliance cost is lower).

---

## 10. End-of-period output

By Day 30, this plan should produce:

**Quantitative:**
- 50-60 outreach contacts initiated
- 10-15 introductory calls completed
- 2-4 specific deal-level discussions underway
- 1+ deal moving toward execution
- 6-8 vetted transaction templates
- 30-40 fully-researched bilateral counterparties (Tier 1 substantially complete)

**Qualitative:**
- Calibrated outreach messaging based on observed response patterns
- Working relationship with outside counsel with established turnaround SLAs
- Operational rhythm for the niche
- Clear picture of which sub-segments (origin × destination × structure combinations) are working

**Strategic:**
- Foundation in place to scale outreach in Month 2 to ~120 cumulative contacts
- Track record beginning to form (even before first close)
- Counterparty network at the size where the proactive matching engine starts producing useful matches

---

## 11. The lifecycle of this document

This document is a 30-day plan. At Day 30:

1. Write `docs/specialty-crude-month-1-review.md` capturing actuals vs. plan, learnings, and surprises.
2. Write `docs/specialty-crude-month-2-plan.md` for the next 30 days.
3. Update this document's header to mark it as "superseded — see month-2-plan."

**Do not treat this document as the standing operating procedure for specialty crude operations 6 months from now.** Operations evolve. New tactical plans get written every 30 days. The strategic backbone in `docs/specialty-crude-strategy.md` is what's durable; this document is a snapshot of the operational tactics for one specific 30-day window.

---

End of 30-day plan.
