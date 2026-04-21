-- 0017_fuel_deal_participants.sql
-- Per-deal participants with heterogeneous commission structures so the
-- team can answer "what % are we paying the supplier-side broker on
-- deal X?" Variance is captured in two columns: commission_type (which
-- pricing model) + commission_value (interpreted per type — % of sell,
-- cents/L, $/mt, or a flat USD amount).
--
-- Text columns (party_type, commission_type) rather than enums so new
-- roles / pricing models can be added without a schema bump.
-- display_name is NOT NULL so operators can build deals before the
-- broker's company is added to the CRM; org_id links up later.

CREATE TABLE IF NOT EXISTS fuel_deal_participants (
  id                 text        PRIMARY KEY,
  tenant_id          text        NOT NULL,
  deal_id            text        NOT NULL REFERENCES fuel_deals(id) ON DELETE CASCADE,

  party_type         text        NOT NULL,
  org_id             text        REFERENCES organizations(id) ON DELETE SET NULL,
  contact_id         text        REFERENCES contacts(id) ON DELETE SET NULL,
  display_name       text        NOT NULL,

  commission_type    text        NOT NULL DEFAULT 'none',
  commission_value   double precision,
  commission_notes   text,

  notes              text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fuel_deal_participants_tenant_idx
  ON fuel_deal_participants (tenant_id);
CREATE INDEX IF NOT EXISTS fuel_deal_participants_deal_idx
  ON fuel_deal_participants (deal_id);
CREATE INDEX IF NOT EXISTS fuel_deal_participants_org_idx
  ON fuel_deal_participants (org_id);

-- RLS — mirror the pattern from 0001_enable_rls for the other business
-- tables: tenant_isolation policy with both USING + WITH CHECK so
-- inserts are constrained to the session tenant. vex_migrator has
-- BYPASSRLS; runtime connections set app.tenant_id via withTenant().
DROP POLICY IF EXISTS tenant_isolation ON fuel_deal_participants;
CREATE POLICY tenant_isolation ON fuel_deal_participants
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE fuel_deal_participants ENABLE ROW LEVEL SECURITY;
