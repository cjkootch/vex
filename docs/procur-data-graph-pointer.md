# Data Graph Connections — Pointer

**Canonical brief:** [`cjkootch/procur_dashboard` → `docs/data-graph-connections-brief.md`](https://github.com/cjkootch/procur_dashboard/blob/main/docs/data-graph-connections-brief.md)

The canonical brief lives in procur because all five work items
operate on procur's schema and data sources. Vex's involvement is
limited to one piece of work item 3 (match queue feedback loop),
detailed below.

## What vex contributes

Work item 3 closes the feedback loop between procur's match queue
and vex's deal outcomes. Specifically:

- When a procur match is pushed to vex and vex creates a fuel_deal,
  vex pings procur's new `POST /api/intelligence/match-outcome`
  endpoint with the vexDealId.
- When the fuel_deal transitions to terminal state (closed_won,
  closed_lost), vex pings the same endpoint with the outcome.
- After 90 days without engagement, vex auto-marks the match as
  no_engagement.

The vex-side work is small — about 50 lines of code extending the
existing ProcurClient pattern. It's specified in §4 of the canonical
brief.

## What vex does NOT do

- No slate-fit logic in vex (work item 1 is purely procur-side)
- No ownership graph wiring in vex (work item 2 is purely procur-side)
- No cargo-trip inference in vex (work item 4 is purely procur-side)
- No customs context analysis in vex (work item 5 is purely
  procur-side)

Vex consumes the analytical capabilities created by these connections
through the existing intelligence HTTP API at `/api/intelligence/*`.
Specifically:

- `find_refineries_for_grade` and `find_grades_for_refinery` (work
  item 1) become callable from vex via the existing
  `lookup_in_procur` chat tool pattern, scoped to specialty crude
  use cases.
- Ownership chains (work item 2) surface in vex's organization
  detail page via a new field on the `procur_intelligence_snapshots`
  payload.
- Cargo activity summaries (work item 4) surface in vex's deal
  pages via the existing market-context infrastructure.

These integrations follow the established procur→vex pattern: procur
exposes the analytical endpoint, vex consumes it through ProcurClient,
data lands in the existing snapshot/cache layer.

## Why all five connections matter for vex's execution layer

Each connection makes vex's chat surface and approval flow more
useful:

- Slate-fit lets the assistant compose grade-specific outreach
  messages with empirical reasoning
- Ownership graph lets the assistant flag transitive sanctions
  exposure during OFAC review
- Match queue feedback lets the operator see which signal types
  actually drive their closed deals
- Cargo activity gives every supplier outreach an opening line
  grounded in observable procurement behavior
- Customs context anchors every counterparty in their macro market
  environment

## Companion documents

- `docs/strategic-vision.md` — overall technical vision (mirror)
- `docs/commercial-strategy.md` — broader commercial frame
- `docs/specialty-crude-strategy.md` — the niche where work items
  1 and 2 specifically pay off

See cjkootch/procur_dashboard/docs/data-graph-connections-brief.md
for full specification, schema additions, and implementation order.
