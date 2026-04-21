-- 0019_vessels.sql
-- Vessel intelligence: the physical asset every fuel deal rides on.
-- Today freight rates are carried as `per_usg` on the cost stack and
-- the deal has no idea what actually moved the cargo — no IMO, no
-- utilization, no tie to a vessel's PSC record. Add a proper `vessels`
-- dimension, a `freight_rates` fact table for market benchmarks, and
-- link both to fuel_deals so the deal evaluator can reason about
-- utilization, mark-to-market freight, and vetting risk.
--
-- Numbering note: the spec said "0014" but this branch is already
-- through 0018_ofac_screening, so this migration lands at 0019.
--
-- RLS note: every new table uses USING + WITH CHECK against
-- app.tenant_id — mirrors 0001_enable_rls so INSERTs are scoped too.
-- No GRANT statements here — the migrator (packages/db/src/migrate.ts)
-- runs SET ROLE vex_migrator and reissues broad grants post-migrate.

-- =============================================================================
-- vessel_class — distinct from the existing vessel_type enum on
-- fuel_deal_cost_stack. That one is product-tanker-centric
-- (TankerMr/Lr1/Lr2/Vlcc/Barge/CoastalTanker/Isocontainer/Flexitank);
-- this broader classification covers bulk carriers, container ships,
-- and reefer tonnage as the book expands beyond refined products.
-- =============================================================================
CREATE TYPE vessel_class AS ENUM (
  'handysize',      -- 10-40k DWT
  'handymax',       -- 40-55k DWT
  'panamax',        -- 60-80k DWT
  'aframax',        -- 80-120k DWT
  'suezmax',        -- 120-200k DWT
  'vlcc',           -- 200-320k DWT
  'mr_tanker',      -- Medium Range product tanker, 45-55k DWT
  'lr1',            -- Long Range 1, 55-80k DWT
  'lr2',            -- Long Range 2, 80-120k DWT
  'coastal',        -- <10k DWT
  'barge',
  'container',
  'reefer',
  'bulk_carrier'
);

-- =============================================================================
-- vessels — one row per physical ship. Most fields nullable because
-- vessels are often nominated with only an IMO + name; the rest of
-- the particulars fill in as brokers circulate Q88s / cert packs.
-- =============================================================================
CREATE TABLE vessels (
  id                          text             PRIMARY KEY,
  tenant_id                   text             NOT NULL,
  -- IMO is the global identity for a hull. 7 digits. Nullable because
  -- early-stage charter discussions often precede IMO disclosure.
  imo_number                  text,
  name                        text             NOT NULL,
  -- ISO 3166-1 alpha-2 country code for the flag of registration.
  flag                        text,
  vessel_class                vessel_class     NOT NULL,
  dwt_mt                      double precision,
  loa_m                       double precision,
  beam_m                      double precision,
  max_draft_m                 double precision,
  built_year                  integer,
  operator_org_id             text             REFERENCES organizations(id) ON DELETE SET NULL,
  ice_class                   text,
  double_hull                 boolean          DEFAULT true,
  last_psc_inspection_date    date,
  last_psc_deficiencies       integer,
  notes                       text,
  created_at                  timestamptz      NOT NULL DEFAULT now(),
  updated_at                  timestamptz      NOT NULL DEFAULT now()
);

-- IMO is globally unique per hull. Scope the uniqueness to the tenant
-- so two workspaces can both carry the same IMO, and keep it a partial
-- index so rows without IMO don't collide on NULL.
CREATE UNIQUE INDEX vessels_imo_uniq
  ON vessels (tenant_id, imo_number)
  WHERE imo_number IS NOT NULL;
CREATE INDEX vessels_tenant_idx ON vessels (tenant_id);
CREATE INDEX vessels_class_idx ON vessels (tenant_id, vessel_class);

DROP POLICY IF EXISTS tenant_isolation ON vessels;
CREATE POLICY tenant_isolation ON vessels
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE vessels ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- freight_rates — time series of market freight benchmarks keyed on
-- (route, vessel_class, product_category). Populated from Baltic /
-- Platts / broker circulars / manual entries; consumed by the deal
-- evaluator to mark-to-market every locked freight rate.
-- =============================================================================
CREATE TABLE freight_rates (
  id                  text             PRIMARY KEY,
  tenant_id           text             NOT NULL,
  rate_date           date             NOT NULL,
  -- Free-form region slugs — e.g. "USGC", "Caribs", "ECCA", "Med".
  origin_region       text             NOT NULL,
  destination_region  text             NOT NULL,
  vessel_class        vessel_class     NOT NULL,
  -- "clean_products", "dirty", "dry_bulk", etc. Text (not enum) so the
  -- taxonomy can evolve without a schema bump.
  product_category    text             NOT NULL,
  rate_usd_per_mt     double precision NOT NULL,
  -- Worldscale points for tanker voyage charters; nullable for
  -- sources that quote fixed $/mt only.
  worldscale_points   double precision,
  -- "baltic", "platts", "broker_circular", "manual".
  source              text             NOT NULL,
  source_reference    text,
  created_at          timestamptz      NOT NULL DEFAULT now()
);

CREATE INDEX freight_rates_tenant_idx ON freight_rates (tenant_id);
-- Lookups are (route, class, latest-first) — matches how the deal
-- evaluator queries for mark-to-market reference rates.
CREATE INDEX freight_rates_route_idx ON freight_rates
  (tenant_id, origin_region, destination_region, vessel_class, rate_date DESC);
-- Idempotent ingest: same (day, route, class, product, source) tuple
-- collapses to one row on re-publish.
CREATE UNIQUE INDEX freight_rates_uniq
  ON freight_rates (tenant_id, rate_date, origin_region, destination_region,
                    vessel_class, product_category, source);

DROP POLICY IF EXISTS tenant_isolation ON freight_rates;
CREATE POLICY tenant_isolation ON freight_rates
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE freight_rates ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- fuel_deals columns — link each deal to a vessel + carry the freight
-- terms actually booked. `freight_rate_locked_at` + the matching
-- market_rate_at_lock give the evaluator the delta between what we
-- paid and what the market looked like at lock time.
-- =============================================================================
ALTER TABLE fuel_deals
  ADD COLUMN IF NOT EXISTS vessel_id                      text             REFERENCES vessels(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vessel_utilization_pct         double precision,
  ADD COLUMN IF NOT EXISTS freight_rate_usd_per_mt        double precision,
  ADD COLUMN IF NOT EXISTS freight_rate_locked_at         timestamptz,
  ADD COLUMN IF NOT EXISTS freight_rate_source            text,
  ADD COLUMN IF NOT EXISTS freight_market_rate_at_lock    double precision,
  ADD COLUMN IF NOT EXISTS demurrage_rate_usd_per_day     double precision,
  ADD COLUMN IF NOT EXISTS ballast_bonus_usd              double precision,
  -- "voyage" | "time" | "spot". Text (not enum) — CP terminology
  -- varies by desk and we'd rather not migrate every new variant.
  ADD COLUMN IF NOT EXISTS charter_type                   text;

CREATE INDEX IF NOT EXISTS fuel_deals_vessel_idx
  ON fuel_deals (vessel_id)
  WHERE vessel_id IS NOT NULL;
