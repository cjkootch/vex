-- 0022_procur_intelligence.sql
-- Vex × Procur integration — sidecar tables for cached procur
-- intelligence on counterparties + procur-sourced market context on
-- fuel deals. See docs/procur-integration.md §5.2 + §5.3.
--
-- Both tables are tenant-scoped via the canonical RLS pattern. Procur
-- itself is multi-tenant-public; vex's tenant boundary is the
-- security model on this side, so different vex tenants must not see
-- each other's choice of which orgs they enriched.
--
-- Conventions match the vessel + port migrations (0019, 0020):
--   - RLS USING + WITH CHECK on `app.tenant_id`
--   - text columns for slugs / enum-like fields that may evolve
--   - vex_migrator role handles the table creation; no vex_app grants
--     in the migration

-- =============================================================================
-- procur_intelligence_snapshots — cached procur tool responses per
-- (tenant, org, tool, query_hash). One row per unique (tenant, org,
-- procur_tool, query_hash); ProcurEnrichmentAgent upserts on this
-- conflict target so re-fetches overwrite in place.
-- =============================================================================
CREATE TABLE IF NOT EXISTS procur_intelligence_snapshots (
  id                text            PRIMARY KEY,
  tenant_id         text            NOT NULL,
  org_id            text            NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- e.g. `analyze_supplier`, `analyze_supplier_pricing`,
  -- `find_recent_cargoes`, `analyze_buyer_pricing`, `entity_news`.
  procur_tool       text            NOT NULL,
  -- Canonical hash of the input args (sorted-keys JSON of non-null
  -- values). Same shape twice → one row.
  query_hash        text            NOT NULL,
  -- Procur's response payload, verbatim.
  payload           jsonb           NOT NULL,
  fetched_at        timestamptz     NOT NULL DEFAULT now(),
  expires_at        timestamptz     NOT NULL
);

CREATE INDEX IF NOT EXISTS procur_snapshots_tenant_idx
  ON procur_intelligence_snapshots (tenant_id);
CREATE INDEX IF NOT EXISTS procur_snapshots_tenant_org_tool_idx
  ON procur_intelligence_snapshots (tenant_id, org_id, procur_tool);
CREATE INDEX IF NOT EXISTS procur_snapshots_expires_idx
  ON procur_intelligence_snapshots (expires_at);

-- Logical dedupe key — composite with tenant_id keeps the constraint
-- RLS-friendly (the unique check runs under the row's tenant_id).
CREATE UNIQUE INDEX IF NOT EXISTS procur_snapshots_unique_idx
  ON procur_intelligence_snapshots (tenant_id, org_id, procur_tool, query_hash);

DROP POLICY IF EXISTS tenant_isolation ON procur_intelligence_snapshots;
CREATE POLICY tenant_isolation ON procur_intelligence_snapshots
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE procur_intelligence_snapshots ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- fuel_deal_market_context — procur-derived empirical context for a
-- single deal. Populated by DealMarketContextAgent on draft→live; one
-- row per deal (unique on (tenant_id, deal_id)); upserts on re-eval.
-- =============================================================================
CREATE TABLE IF NOT EXISTS fuel_deal_market_context (
  id                                text             PRIMARY KEY,
  tenant_id                         text             NOT NULL,
  deal_id                           text             NOT NULL REFERENCES fuel_deals(id) ON DELETE CASCADE,
  benchmark_code                    text             NOT NULL,
  benchmark_spot_usd                double precision,
  effective_benchmark_usd           double precision,
  offer_delta_usd                   double precision,
  offer_delta_pct                   double precision,
  historical_mean_delta_pct         double precision,
  historical_median_delta_pct       double precision,
  historical_stddev_delta_pct       double precision,
  historical_sample_size            integer,
  z_score                           double precision,
  percentile                        double precision,
  -- `aggressive` | `competitive` | `fair` | `high` | `outlier_high`.
  verdict                           text             NOT NULL,
  rationale                         text,
  fetched_at                        timestamptz      NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fuel_deal_market_context_tenant_idx
  ON fuel_deal_market_context (tenant_id);
CREATE INDEX IF NOT EXISTS fuel_deal_market_context_verdict_idx
  ON fuel_deal_market_context (verdict);

CREATE UNIQUE INDEX IF NOT EXISTS fuel_deal_market_context_deal_unique
  ON fuel_deal_market_context (tenant_id, deal_id);

DROP POLICY IF EXISTS tenant_isolation ON fuel_deal_market_context;
CREATE POLICY tenant_isolation ON fuel_deal_market_context
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE fuel_deal_market_context ENABLE ROW LEVEL SECURITY;
