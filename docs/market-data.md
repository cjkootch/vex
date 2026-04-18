# Market data + marketing automation engine

Sprint 11 adds a provider-agnostic petroleum + natural-gas market feed
and a downstream alert/outreach path. This document covers the moving
parts so operators know what's polling, what's gated, and what to
check when something goes sideways.

## Components

| Layer | File | Responsibility |
| --- | --- | --- |
| Feed adapter | `packages/integrations/src/eia.ts` | Thin wrapper over `api.eia.gov/v2` — one series at a time over a date window, returns normalized rows. |
| Agent — ingest | `packages/agents/src/agents/market-data.ts` | Accepts a `MarketDataProvider` + a `MarketDataSeries[]`, converts to per-USG / per-bbl / per-mt, upserts into `fuel_market_rates`. T1. |
| Agent — alert | `packages/agents/src/agents/market-alert.ts` | Scans latest rates vs a 30-day baseline; for each crossing, scores buyer readiness and proposes T2 `market.outreach`. |
| Scoring | `packages/agents/src/scoring/buyer-readiness.ts` | Pure 0–100 ranker over counterparty tier, engagement, momentum, price favorability. |
| Worker job | `apps/worker/src/jobs/market-data-job.ts` | Chains ingest → alert inside one `withTenant` transaction; boot-time + every 6h. |
| Prompt | `packages/agents/src/prompts/market-outreach.ts` | System prompt for the reviewer-triggered "draft outreach" path. |
| API | `apps/api/src/market/market.controller.ts` | `GET /market/rates`, `GET /market/alerts` — RLS-scoped reads. |
| Web proxy | `apps/web/src/app/api/market/{rates,alerts}/route.ts` | Forwards to apps/api; stubs when `VEX_API_URL` is unset. |
| UI panel | `apps/web/src/components/canvas/panels/market-intel-panel.tsx` | Renders the `market_intel` manifest variant. |

## Environment

```
EIA_API_KEY=            # US EIA Open Data v2 — https://www.eia.gov/opendata/
ALPHA_VANTAGE_API_KEY=  # Fallback commodity feed (not yet wired)
```

Both are optional. `buildEiaProvider(undefined)` returns `null`; when it
does, the worker's market-data timer is never started. No silent
fallback to an unauthenticated endpoint.

## Series configuration

`FUEL_SERIES_CONFIG` in `apps/worker/src/jobs/market-data-job.ts` pins
five EIA series:

- `PET.RWTC.D` — Cushing WTI spot ($/bbl, daily)
- `PET.RBRTE.D` — Europe Brent spot ($/bbl, daily)
- `PET.EER_EPMRU_PF4_RGC_DPG.W` — US regular gasoline retail ($/gal, weekly)
- `PET.EER_EPD2D_PF4_Y35NY_DPG.W` — NY Harbor ULSD spot ($/gal, weekly)
- `NG.RNGWHHD.D` — Henry Hub natural gas ($/MMBtu, daily)

Each series carries a canonical `product` label and a product-
appropriate `bblPerMt` for unit conversion (crude 7.33, gasoline 8.5,
diesel 7.45). Downstream consumers should ignore `price_per_mt` for
natural gas since MMBtu has no mass equivalent.

## Schedule

| Job | Cadence | Trigger |
| --- | --- | --- |
| MarketDataAgent (ingest) | Boot + every 6h | `setInterval` in `apps/worker/src/main.ts` |
| MarketAlertAgent (alert) | Same transaction as ingest | Chained inside `runMarketDataTick` |
| Outreach execution | Manual | Reviewer approves a `market.outreach` row in the inbox |

EIA weekly series publish once/week; daily series publish once/day.
Polling every six hours keeps the feed warm without burning API quota.
Re-ingesting the same day is idempotent via the `(tenant_id, rate_date,
product, benchmark)` unique index.

## Alert threshold

Defaults (overridable per tick in `MarketDataJobDeps`):

- `baselineDays: 30` — rolling mean window
- `thresholdPct: 5` — crossing magnitude vs baseline

The agent skips a series silently when fewer than five prior data
points exist in the window — not enough signal to raise an alert
responsibly. Crossings emit a dedup-keyed audit event, so a re-run
over the same rate date never duplicates proposals.

## Buyer readiness

`scoreBuyerReadiness()` produces a 0–100 score with contributions across
five dimensions (counterparty tier, 30d touchpoints, inbound recency,
open momentum, price favorability). Bands: `cold` (<25), `watch`
(25–49), `warm` (50–74), `hot` (≥75). Only `warm` and `hot` buyers
generate outreach proposals. Prohibited counterparties (`watch`
tier → high; `declined` tier → prohibited) never generate proposals
regardless of score.

## Panel payload

The `market_intel` manifest panel takes:

- `rates[]` — one row per `(product, benchmark)` with per-USG / per-bbl
  / per-mt prices, `rateDate`, `source`, optional `changePct`
- `alerts[]` — zero or more recent crossings with `direction`,
  `changePct`, current and baseline prices, baseline window, threshold

The canvas component renders USG as the headline price and bbl / mt
as secondary. When `changePct` is present, a ▲/▼ badge tinted by sign
appears under the card.

## Troubleshooting

**No rows appearing in `fuel_market_rates` despite EIA_API_KEY set.**
Check the worker log for `market-data tick failed`. Common causes: the
EIA API rate-limiting the key (lift to a higher tier), the series id
being disabled (EIA occasionally retires series), or `MIGRATION_DATABASE_URL`
not having the Sprint 11 `fuel_market_rates` table (run migrations).

**Alerts never appear even though prices clearly moved.** The baseline
window requires at least five prior data points — on a brand-new feed
you'll see the first alerts ~5 trading days in. Check
`agent.market_data.snapshot_ingested` audit events to confirm the feed
is actually landing rows before expecting alerts.

**Outreach approvals never surface in the inbox.** MarketAlertAgent
emits `approval.created` events with `action_type = market.outreach`.
If those events exist but the inbox is empty, check whether the
inbox UI filters by `actionType` — Sprint 14+ inbox shows all pending
approvals by default, but a narrower filter may hide new kinds.

**Wrong product mapping.** Rate labels (`diesel`, `gasoline`, `jet`)
don't match the fine-grained deal product enum (`ulsd`, `jet_a`,
`gasoline_87`). The `DEFAULT_MARKET_PRODUCT_MAP` in market-data-job.ts
is the authority. Override per tenant by passing `productMap` into
`runMarketDataTick` — your workspace config should drive the override.
