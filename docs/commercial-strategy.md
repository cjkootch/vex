# Commercial Strategy — VTC's Niche and Operating Model

**Status:** strategic framing, not a build brief
**Owner:** Cole
**Last updated:** 2026-04-30
**Companion to:** `docs/strategic-vision.md` (which describes the *technical* shape of what's being built; this document describes the *commercial* shape it serves)

This document explains where VTC operates commercially, why the procur+vex stack is uniquely suited to that space, and how VTC engages counterparties to generate deal flow. It is not a build brief. The build briefs implement components; this document explains the commercial position those components serve.

If you're new to this project, read `docs/strategic-vision.md` first. Then this document. Then the build briefs.

---

## 1. The niche, in one paragraph

VTC operates the **sub-major Caribbean and Latin American physical commodity trading segment** where deal sizes run $1-5M per cargo, the buyer is institutional but not sovereign-scale, the supply is geographically constrained, and the deal requires both regional relationship knowledge AND credible institutional infrastructure. This is the structural space where the major commodity trading houses (Vitol, Trafigura, Mercuria, Glencore, Gunvor) won't bid because the deals are below their operational floor (typically $5-15M cargo size minimum), and where small regional brokers can't credibly execute alone because they lack capital, credibility with international counterparties, and compliance infrastructure. **The niche exists structurally — the deals happen anyway, but value capture is fragmented across multiple intermediaries, none of whom is positioned to capture more than a small slice. VTC's commercial position is to consolidate that fragmented value capture by operating at sub-major scale with institutional execution discipline.**

---

## 2. Why the niche is structurally defensible

The niche is defensible because the constraint sets that exclude others apply asymmetrically and aren't easily resolved by capital alone.

**The majors won't enter because their economics forbid it.** A senior trader at Vitol has a P&L target measured in tens of millions per year. Spending two weeks on a $1.2M cargo with $80K of margin is destroying their capital allocation regardless of whether the deal closes. The deal-size floor is real, has shifted up over the last 20 years rather than down, and is a structural feature of every major trading desk's compensation and operational structure. The majors won't fix this constraint because doing so would compromise their primary business at much larger deal sizes.

**Small regional brokers can't enter because their constraints compound.** A typical Caribbean broker operates with $200K-$2M of working capital, runs the business on email and WhatsApp, lacks compliance infrastructure beyond surface-level OFAC screening, can't credibly call international counterparties cold without an introduction, and operates with documentation discipline that creates friction in every deal. Each constraint is solvable individually but the combination requires investment that would consume their margin entirely. They stay small because the path to becoming credibly larger requires a structural step they can't fund.

**The space between is what VTC occupies.** Specifically, VTC has:

- **Houston entity (VTC LLC) for U.S. dollar settlement and supplier credibility** — gives the credibility face for talking to Houston refiners and U.S.-based suppliers.
- **Vector Antilles FZCO (Dubai Silicon Oasis) with Dubai Islamic Bank** — provides financial infrastructure that operates outside the patterns U.S. compliance is most paranoid about, particularly for sanctioned-adjacent markets.
- **Canadian citizenship + EDC eligibility** — gives access to political risk insurance and emerging-markets buyer financing that neither U.S. trading entities nor purely offshore structures can match cleanly.
- **The procur+vex stack** — provides systematic operational leverage (counterparty intelligence, OFAC screening, document discipline, deal-context evaluation) at a quality typical of a 30-person trading desk, operated by a team of one.
- **An origination partner network strategy** — solves the regional-relationships gap by partnering with people who already have those relationships, paying referral fees on closed deals only.
- **Active commodity-trading practice (not just SaaS)** — VTC is a counterparty, not a data vendor. The commercial relationships are real, the deals are real, the track record is being built deal by deal.

The combination of all six is what creates the defensible position. Any one of them is replicable. The combination is not, and the combination is what makes the niche economically viable to occupy.

---

## 3. Three sub-niches within the broader niche

Within the broader sub-major space, three specific sub-niches stand out as where VTC's structural advantages compound most:

### 3.1 Caribbean fuel trading at sub-major scale

Refined products (diesel, gasoline, jet, HFO, LPG) into Caribbean utilities, distributors, and tourism-economy buyers at $1-5M cargo size. This is the day-to-day commercial business — high deal frequency, moderate margins, builds the operational rhythm and relationship base that the higher-margin work depends on.

The defining buyers are: Caribbean utility commissions (DR's various electric authorities, Jamaica Public Service, Bahamas Power, Trinidad utilities, OECS micro-states), tourism-economy distributors (large hotel chains, resort operators, large fuel distributors), and secondary distributors throughout the islands. The defining suppliers are: Houston refiners (Marathon, P66, Valero, Citgo, ExxonMobil retail, Shell), Cartagena (Reficar), Curaçao operations, St. Croix terminal infrastructure, and increasingly Trinidad operations.

The procur+vex stack provides bid advantage on the public-tender flow (DR DGCP, Jamaica GOJEP, OECS publishers), pricing analytics for empirical Caribbean premium analysis, and the campaign engine for systematic counterparty outreach. This sub-niche is the well-understood reactive flow business; the briefs in this repo cover its implementation comprehensively.

### 3.2 Specialty crude flows where logistics and grade-matching matter more than scale

Single-cargo specialty crude (600,000-1,000,000 bbl, $45-80M cargo value) into refineries that can run specific grades and aren't part of the supermajors' standard supply rotation. Examples: Libyan crude to Mediterranean specialty refiners, Azeri Light to Mediterranean / Black Sea complex configurations, West African grades to Caribbean refineries with light-sweet capability, Canadian heavy sour to specific Gulf Coast complex refiners.

The defining feature: **freight is not the binding constraint; grade-fit is.** A refinery configured for sweet light cannot run heavy sour profitably, and vice versa. This means the geographic universe of viable buyers for any given specialty crude is small (often 6-15 globally), well-defined by refinery configuration data, and not what the majors fight over at the cargo level.

VTC's `crude_grades` schema in procur + the refinery rolodex with slate-fit metadata + the AIS-derived cargo trip inference layer is the analytical infrastructure that makes this work. The strategic case is detailed separately in `docs/specialty-crude-strategy.md`.

### 3.3 Sub-floor referral relationships with major trading desks

The most novel of the three. The majors' regional desks (Vitol Houston, Trafigura Houston, ExxonMobil's commercial group, etc.) periodically see deals in the $1-5M cargo range that are below their operational floor. They currently say no to these deals or hand them back to the buyer with a generic referral. **The position to occupy is "the executor below your floor — you don't have to say no to small Caribbean buyers anymore, you can hand them to us."**

For the major: it's free goodwill with the buyer, no operational cost, no compliance risk, no capital deployment. For VTC: it's a deal flow source where the deals arrive pre-qualified by the major's existing customer relationship. For the buyer: they get the cargo without the friction of being told no.

This sub-niche requires a track record of closed deals before it becomes credible to approach. Pre-track-record, you don't have the credibility to ask. Post-track-record (10-20 closed deals across 9-12 months), the conversation becomes possible. Defer active outreach until that track record exists. Recognize the sub-niche as a strategic destination, not an immediate workstream.

---

## 4. How the system shows up commercially — selling without selling

A frequent strategic question is "how do we sell the system to counterparties." The honest answer is: **we don't sell it. We use it. The system manifests externally as observable behaviors, not as a product to demo.**

The trap to avoid: most operators who have built impressive infrastructure want to demo it. Pull up the screen, show the maps, show the proactive match queue, watch the prospect get impressed. **This is actively counterproductive for VTC's counterparty universe.** Specifically:

- The small Caribbean broker who runs the business on WhatsApp doesn't want to learn your system. They pattern-match you to "fintech bro who built a thing" rather than "trader I want to work with."
- The mid-tier refinery commercial director has been pitched by every commodity-tech startup in the last 10 years. The more your pitch sounds like a software pitch, the further you drift from the "counterparty I close real deals with" frame they're judging you against.
- The senior trader at a major has Bloomberg, Refinitiv, Argus, internal proprietary systems. Showing them your stack signals smaller, not more sophisticated.

The pattern across all three: **leading with the tech makes you look like a tech vendor, when your value to them is being a counterparty.**

The system manifests externally as four observable behaviors that prospects notice without you ever explaining the infrastructure:

**1. You know things about their business they didn't tell you.** Opening lines that reference their actual award history, recent activity patterns, capability profile, or specific gaps you've noticed. Not flattery; specifics. *"I noticed your team has averaged $0.94/L on DR diesel awards through 2024-2026. The cargo I'm looking at would land you 8% under that."* They don't need to know how you knew. They register that you knew.

**2. You move faster than the people they're used to working with.** Same-day quotes with freight-adjusted pricing, OFAC screening already done, payment instruments already proposed. Hours feels professional in a market where most small brokers take 2-3 days to respond with anything actionable.

**3. Your documentation is right the first time.** Term sheets that match spec, OFAC screening already done, payment instruments already proposed. Counterparties notice when something *doesn't* require three rounds of correction.

**4. You don't waste their time.** You bring them deals that fit their actual capability profile, not deals they'll have to decline. Every deal you place in front of them is one their team can realistically execute.

These four behaviors are what the system enables. **Selling them as behaviors, not as software, is how the system creates commercial value.**

### 4.1 The selling moves, in order of priority

Five concrete moves, in the order they typically appear in counterparty engagement:

**Move 1: Lead with specificity, not capability.** Open every counterparty conversation with a fact about their business that signals "I've done my homework." Not LinkedIn-level research — something they assume only an insider would know. *"I see your team's wins on the DR DGCP have been concentrated in 50ppm ULSD over the last 18 months, with a noticeable gap in 500ppm. Is that intentional positioning, or capacity constraint? I'm asking because I have a Colombian supply that could help on the 500ppm side."* The system gives the data to construct this opener for any named counterparty in the warehouse, in roughly 30 seconds.

**Move 2: Quote prices empirically, not directionally.** Refuse the phrases small operators use ("market is around $X," "I'm hearing $X"). Instead: *"Across the last 24 months of public DR diesel awards, the cargo-weighted average premium over NY Harbor ULSD has been $0.247/L with a standard deviation of $0.068. Your offer at $0.31 is roughly +0.9σ over that distribution — at the high end of the historical range but not outlier territory."* The empirical specificity is the signal.

**Move 3: Make due diligence visible without making it a deliverable.** When bringing a counterparty into a deal: *"Before we go further, I've already cleared OFAC against the latest SDN list for [counterparty], confirmed the corporate registry filing in [jurisdiction] is current, and verified there's no active commercial litigation."* Most small brokers either skip this or rely on counterparty to do it. Saying out loud "I've already done it" tells the prospect three things: institutional execution, compliance protection, no slowdown from their compliance team's homework.

**Move 4: Demonstrate reach without showing the system.** Produce deliverables that obviously came from systematic tracking but aren't dashboards: weekly Caribbean diesel landed-cost matrix as a one-pager, monthly "what's loading where" cargo report, ad-hoc grade-availability summaries. The prospect can read it without logging in, can forward it to their boss, sees VTC's name on the masthead. The system makes producing these trivial; competitors can't recreate them.

**Move 5: Specific outreach at sustained volume.** 30 highly-specific cold messages a week, each one referencing something about the recipient's business that came from the warehouse, will outperform 1,000 generic messages by an order of magnitude. The system gives leverage to do specific outreach at the volume that would otherwise produce 5 generic messages a week. Over 90 days that's 360 specific messages to named counterparties, which compounds into relationship density that gets harder for competitors to match the longer it runs.

### 4.2 Why we don't talk about the system at all

Counterintuitive but right: for the first 12-18 months of using the system commercially, **don't mention it to counterparties unless they directly ask.** Specific reasons:

- **Imitation risk.** Publicizing a sophisticated procurement intelligence + execution stack teaches the next entrant exactly what to build. The system is a moat; talking about it converts moat-time into competitive lead-time spent defending against imitation.
- **Counterparty positioning.** Every minute spent explaining the tech stack is a minute not closing a deal. Counterparties want VTC to be a counterparty, not a software company.
- **Counterparty disinterest.** Refineries care about clean lifts, on-spec delivery, clean payment. Brokers care about earning fees on deals that don't blow back. Plants care about feedstock at working price. None of them want to learn the tech stack.
- **Quiet sophistication is more durable than loud sophistication.** A counterparty who *figures out over six months* that VTC operates at a level above their expectations holds VTC in much higher regard than one VTC tried to convince in the first meeting. The slow reveal beats the cold pitch.

Exceptions where mentioning the infrastructure is appropriate:

- **With origination partners.** Partner recruitment can selectively reveal that the data infrastructure lets VTC evaluate partner submissions in hours rather than days. The system is the reason the partnership-acceleration promise is credible.
- **With capital partners (eventually).** If VTC ever raises capital, the system becomes evidence of operating leverage most small commodity traders don't have. Not as a SaaS valuation play, but as proof of structural cost advantage.
- **With major commodity trading firms (sub-floor referral conversations).** Briefly demonstrating compliance + execution infrastructure makes the "we'll execute deals below your floor" pitch credible. The major needs to know VTC won't embarrass them by botching a referral.
- **With certain specialty buyers who explicitly ask.** Occasionally a sophisticated buyer asks "how do you source?" The right answer is honest: *"We have a procurement intelligence warehouse that tracks public tender awards across roughly 20 jurisdictions, vessel positions, and refinery capability profiles. When a tender like yours publishes, we know the supplier base in 24 hours."*

---

## 5. The outreach strategy — shotgun coverage with rifle precision per interaction

Most operators get this question wrong because they treat shotgun coverage and rifle precision as a tension. They aren't, when the system is part of the equation. Specifically:

**Shotgun in coverage** — VTC engages a broad universe of counterparties (~120-180 active relationships at sustained state). The rationale isn't volume per se. It's option value: each established relationship is a free option to exercise when an opportunity appears. Most options expire worthless, but the cost of maintaining a relationship is near-zero (one quarterly check-in email), and one unexpected deal from a counterparty cultivated 14 months ago can pay for the entire outreach program.

**Rifle in every interaction** — every individual cold message, follow-up, call, or quote is precisely tailored to the counterparty using the system. Not because that's the moral high road, but because **specificity determines categorization, and categorization is durable**. When a counterparty receives a cold message, they sort the sender within the first 90 seconds into one of four buckets:

1. **Serious counterparty** — replied to within 48 hours, kept in rolodex
2. **Capable but small** — polite "we'll keep your details on file" — relationship functionally dead
3. **Broker shopping the world** — ignored or autoreply — sender now associated with low-quality outreach
4. **Spammer / scammer** — added to a deny-list — future emails don't get through

The categorization is **mostly determined by the first message** and is **durable** — once put in bucket 3 or 4, getting moved to bucket 1 takes a meaningful gesture. Generic high-volume outreach efficiently broadcasts "I'm shopping the world" and produces bucket-3 categorization at scale. The system enabling faster generic outreach actually amplifies the damage rather than reducing it. **Speed without specificity is worse than slowness.**

The system resolves the apparent tension because it can compose specific cold messages at scale that competitors can't match. With the system: 30 specific messages per week is sustainable. Without the system: 30 specific messages per week requires a small team. **VTC operates at the level of a 30-person desk by using the system to convert generic-message capacity into specific-message capacity.**

### 5.1 Tiering the universe

The relevant counterparty universe is geographically and commercially bounded by VTC's actual deal patterns, not by ambition. Practically:

- **Tier 1**: Counterparties within 1,500 NM of VTC's typical discharge ports (Caribbean / LatAm / West African). Roughly Houston, Lake Charles, Pascagoula, St. Croix, Curaçao, Cartagena, Barranquilla, Aruba, Bonaire, Pointe-à-Pierre, Refidomsa, Lagos / Port Harcourt, Skikda. **~40-60 refineries.** All of these get cultivated.
- **Tier 2**: Counterparties within 4,000 NM (most US Gulf, Mediterranean basin including Algeria / Libya / Egypt, West Africa beyond Nigeria, northern South America). **~80-120 refineries.** Most of these get cultivated.
- **Tier 3**: Everything else. **Opportunistic only** — engaged when a specific deal makes the freight or grade-fit work.

That's 120-180 active refinery relationships — the right size for "shotgun coverage." Add 60-100 specialty crude sellers and ~200 origination partner candidates over time, and the total active counterparty universe is 400-500 entities. **All managed by one operator, because the system handles the operational leverage.**

### 5.2 Sustained operational rhythm

The discipline that makes the strategy work is operational, not strategic. The cadence:

- **Monday-Tuesday**: send 8-12 net-new outreach messages, all specific, all to current-tier targets.
- **Wednesday-Friday**: handle replies. Same-business-day where possible, next-business-day worst case.
- **End of week**: review the proactive match queue, action 1-3 high-confidence items, mark outcomes for prior weeks' interactions.

That cadence, sustained for 6 months, builds the foundation. By month 6: ~50 active Tier 1 refinery relationships, 5-15 closed deals, clear picture of which sub-segments are working best.

**The rate-limiting constraint is operator judgment, not system capacity.** A traditional small commodity trader manages 30-50 counterparty relationships well. A traditional medium-sized desk manages 200-300 with a team of 5-8 traders. The system lets one operator manage 200-300 relationships *if the operator's judgment can absorb that volume*. Practically: 4-8 net-new outreach contacts per business day with same-day reply discipline. Volume that exceeds judgment capacity is volume that damages categorization.

### 5.3 Specific sourcing rules

Three rules that have to hold or the strategy degrades:

**Reply within 4 business hours.** Slow replies tell counterparties VTC is not serious. The system supports this through vex's `follow-ups` infrastructure with priority routing on Tier 1 counterparty replies. Use it.

**Treat every reply as an opportunity to over-deliver.** If a counterparty asks a follow-up question, send back something more substantive than they expected. Their categorization of VTC moves up a tier; the cost of producing the substantive response is low because the system does most of it.

**Track every relationship's state.** Every Tier 1 relationship has a state: cold-no-reply, replied-first-time, intro-call-completed, active-discussion, sourced-once, sourced-multiple-times. Quarterly outreach in quiet quarters keeps relationships warm — but the outreach has to be substantively interesting, not "checking in."

---

## 6. The crude sellers extension

The natural strategic extension once refined product Caribbean trading is operating: cultivate relationships with **crude sellers** as well as refineries, positioning VTC as a placement intermediary on specialty crude flows.

The strategic logic:
- The same refineries cultivated for refined product offtake are *also* crude buyers. The handoff conversation from product to crude procurement happens within the same counterparty.
- The system's `crude_grades` schema and refinery slate-fit data answer questions about which refineries can run which crudes — questions that small refined product brokers cannot credibly answer.
- Specialty crude single cargoes ($45-80M, 600K-1M bbl) sit below the supermajor floor and represent genuine deal flow that's currently fragmented across small specialty intermediaries.

The detailed strategic and operational case for this is in `docs/specialty-crude-strategy.md`, including the specific schema additions needed and the structural advantages Vector Antilles provides for sanctions-flexible flows. **That document should be read in conjunction with this one** for any work in the specialty crude space.

---

## 7. Deliverables that productize the system without exposing it

Specific artifacts to produce on a regular cadence that obviously came from the system but read as commercial deliverables, not as software output:

### 7.1 Weekly Caribbean Diesel Landed-Cost Matrix
One-page PDF showing landed prices into 6-8 Caribbean ports for cargoes loading in the next 30 days. Sources: EIA / FRED for spot benchmarks, freight rates from procur's freight data, the empirical Caribbean premium from `award_price_deltas`. Email distribution to ~20-30 Caribbean refiner / utility / distributor decision-makers. The note line: *"Thought you might find this useful. Let me know if you'd like to be added to the weekly list."*

### 7.2 Monthly West Africa Crude Position Report
For specialty crude track once active. Cargo loading patterns from named West African producers in the past 30 days, with anonymized destination patterns and grade-fit notes. Distributed to the bilateral counterparty list for crude (refiners that take West African grades, specialty intermediaries).

### 7.3 Quarterly Caribbean Tender Pipeline
Forward-looking summary of major Caribbean public tenders likely to publish in the next 90 days, based on procurement cadence analysis of historical award timing. Distributed to the supplier network — gives VTC's suppliers a heads-up on coming opportunities, positions VTC as the source of market intelligence.

### 7.4 Ad-hoc grade-fit analyses
On request, custom analyses of "which refineries can run [grade]" or "what would a [origin]-to-[destination] cargo look like." Produced from the system, delivered as PDFs with VTC branding. These become reference documents the recipient keeps and refers back to.

The deliverables matter because they make VTC visible without requiring a meeting. Recipients forward them, share them, refer back to them. Over time VTC becomes "the firm that produces those reports." The system makes producing them trivial; the brand effect compounds.

---

## 8. Origination partner network as the third leg

The reactive flows (refined product Caribbean trading) and the proactive specialty crude track are two of three legs. The third is the origination partner network specified in `docs/origination-partners-brief.md`.

The strategic role: origination partners are **a third source of signal** beyond public tender data and public-domain intelligence. They capture privately-known information (a regional broker hears that a refinery is overstocked because his cousin works there) before public data shows it. The 14-90 day window between privately-known and publicly-visible is the same asymmetric window that drives the proactive matching engine — partners aren't a separate workflow, they're an additional signal source feeding the same engine.

Defer active partner recruitment until the reactive and crude flows have produced a track record that makes VTC attractive as a partner-side principal. Practically, this means months 6-12 from the start of operations. **The infrastructure is built; the recruitment is held back deliberately until VTC has the track record to attract good partners (and protect against the bad ones).**

---

## 9. Discipline rules that determine whether the strategy works

Three disciplines that must hold or the commercial strategy collapses:

**Maintain entity separation between VTC LLC and Vector Antilles FZCO.** Every interaction. Vector Antilles has its own banking, its own counterparty list, its own contracts, its own books and records. Customers of one are not customers of the other. The discipline is operational, not just legal — it has to be visible in how VTC communicates with counterparties, what email signatures are used, what entities are referenced in introductions. Vector Antilles has its own brand and positioning; VTC LLC has its own. This is non-negotiable.

**Defer the higher-risk niches until the lower-risk ones have produced track record.** Specialty crude through Vector Antilles has higher compliance complexity than Caribbean refined product through VTC LLC. The compliance cost is justified by the margin, but only if the foundational track record exists. Don't enter the higher-risk niche before the foundation supports it.

**Productize behaviors, not the system.** Talk about VTC as a counterparty. Ship deliverables (one-pagers, reports, analyses) that demonstrate sophistication without exposing infrastructure. Reserve the system itself as an internal asset, mentioned only when specifically appropriate (capital partners, sub-floor referral conversations with majors, partner recruitment). The system is a moat; treat it like one.

---

## 10. The strategic positioning, in one sentence

VTC is a **Caribbean and Latin American physical commodity trader operating at sub-major scale with institutional execution discipline, supported by a procurement intelligence and sales execution infrastructure that creates operating leverage equivalent to a 30-person trading desk, occupying a structural niche neither the majors nor small regional brokers can profitably occupy alone.** The infrastructure is what makes the niche economically viable to occupy. The niche is what gives the infrastructure commercial purpose. They are inseparable.

This document captures the commercial frame. `docs/strategic-vision.md` captures the technical frame. Together they describe what VTC is building and why.

---

End of commercial strategy document.
