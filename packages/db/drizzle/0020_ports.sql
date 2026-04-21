-- 0020_ports.sql
-- Port intelligence layer. Today fuel_deals carry origin_port and
-- destination_port as free-text strings — the deal evaluator can't
-- check draft/LOA/reefer constraints, can't surface congestion, can't
-- chain a deal to a local agent. Promote ports to a real dimension
-- with operational + physical specs, plus a port_events fact table
-- so closures/strikes/tariff changes can fire signals against every
-- live deal touching the affected port.
--
-- Numbering note: spec said 0015 but this branch is past 0019_vessels,
-- so this lands at 0020. Conventions match the vessel intelligence
-- migration (0019): RLS USING + WITH CHECK, no vex_app grants
-- (migrator handles), text columns for slugs/enums that may evolve.

CREATE TABLE IF NOT EXISTS ports (
  id                                text             PRIMARY KEY,
  tenant_id                         text             NOT NULL,
  -- UN/LOCODE is the global identity for a port. 5 chars: country (2) +
  -- locode (3). Scoped unique per-tenant so two workspaces can carry
  -- the same port independently.
  unlocode                          text             NOT NULL,
  name                              text             NOT NULL,
  country_code                      text             NOT NULL,
  -- Free-text region slug — "caribbean", "usgc", "ecca", etc. Matches
  -- the freight_rates region naming so the deal evaluator can join
  -- ports → freight benchmarks without a translation table.
  region                            text             NOT NULL,
  lat                               double precision,
  lng                               double precision,

  -- Physical constraints. Nullable because particulars trickle in
  -- over time as port circulars / Q88-equivalents land.
  max_draft_m                       double precision,
  max_loa_m                         double precision,
  max_beam_m                        double precision,
  max_dwt_mt                        double precision,

  -- Operational. Boolean flags for terminal capabilities — most ports
  -- handle multiple cargo types, so each is independent.
  fuel_terminal                     boolean          NOT NULL DEFAULT false,
  container_terminal                boolean          NOT NULL DEFAULT false,
  bulk_terminal                     boolean          NOT NULL DEFAULT false,
  reefer_capable                    boolean          NOT NULL DEFAULT false,

  -- Timing baselines. Medians from VTC operational history; the
  -- congestion_factor is a live multiplier the agent updates from
  -- port-event flow.
  customs_clearance_days_median     double precision,
  port_days_median                  double precision,
  congestion_factor                 double precision DEFAULT 1.0,

  -- Regulatory / commercial. Free-text — the rules vary too much per
  -- port to enum.
  tariff_notes                      text,
  restricted_cargo_notes            text,
  working_hours                     text,
  pilotage_required                 boolean          NOT NULL DEFAULT true,

  -- Linked local agent (organization). Populated by an operator or
  -- the port-intelligence agent.
  local_agent_org_id                text             REFERENCES organizations(id) ON DELETE SET NULL,

  last_verified_at                  timestamptz,
  -- Audit trail of source URLs / publication refs that informed the
  -- record. JSONB array of strings/objects.
  source_references                 jsonb            NOT NULL DEFAULT '[]'::jsonb,
  created_at                        timestamptz      NOT NULL DEFAULT now(),
  updated_at                        timestamptz      NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ports_unlocode_uniq
  ON ports (tenant_id, unlocode);
CREATE INDEX IF NOT EXISTS ports_tenant_idx ON ports (tenant_id);
CREATE INDEX IF NOT EXISTS ports_region_idx ON ports (tenant_id, region);
CREATE INDEX IF NOT EXISTS ports_country_idx ON ports (tenant_id, country_code);

DROP POLICY IF EXISTS tenant_isolation ON ports;
CREATE POLICY tenant_isolation ON ports
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE ports ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- port_events — closures, congestion spikes, strikes, tariff changes,
-- regulatory updates. ends_at NULL means ongoing.
-- =============================================================================
CREATE TABLE IF NOT EXISTS port_events (
  id           text         PRIMARY KEY,
  tenant_id    text         NOT NULL,
  port_id      text         NOT NULL REFERENCES ports(id) ON DELETE CASCADE,
  -- "closure" | "congestion" | "strike" | "tariff_change" | "regulatory"
  -- Text (not enum) so new event types can be added without a schema bump.
  event_type   text         NOT NULL,
  severity     text         NOT NULL DEFAULT 'info',
  starts_at    timestamptz  NOT NULL,
  ends_at      timestamptz,
  title        text         NOT NULL,
  body         text,
  source_url   text,
  created_at   timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS port_events_port_idx
  ON port_events (port_id, starts_at DESC);
-- Active = ongoing (ends_at IS NULL). Ports closures with a future
-- end-date are still queryable through the port_events_port_idx — we
-- just can't filter on now() inside a partial index predicate
-- (Postgres rejects mutable functions there).
CREATE INDEX IF NOT EXISTS port_events_active_idx
  ON port_events (tenant_id, starts_at DESC)
  WHERE ends_at IS NULL;

DROP POLICY IF EXISTS tenant_isolation ON port_events;
CREATE POLICY tenant_isolation ON port_events
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE port_events ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- fuel_deals.origin_port_id / destination_port_id
-- Both columns coexist with the legacy text origin_port/destination_port
-- so the migration to ULID-linked ports can roll forward gradually.
-- =============================================================================
ALTER TABLE fuel_deals
  ADD COLUMN IF NOT EXISTS origin_port_id      text REFERENCES ports(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS destination_port_id text REFERENCES ports(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS fuel_deals_origin_port_idx
  ON fuel_deals (origin_port_id) WHERE origin_port_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fuel_deals_destination_port_idx
  ON fuel_deals (destination_port_id) WHERE destination_port_id IS NOT NULL;
