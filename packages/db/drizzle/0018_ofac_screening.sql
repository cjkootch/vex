-- 0018_ofac_screening.sql
-- OFAC SDN screening lives in two places: a rolling state on
-- `organizations` (cheap read, tells the UI "should we block anything?")
-- and a full audit trail in `ofac_screens` (one row per screen run per
-- org, immutable, supports compliance review).
--
-- Text column for organizations.ofac_status (not an enum) so the
-- screening agent can introduce new states — e.g. "stale" after 30d
-- without a re-screen — without a migration. Default 'unscreened' so a
-- freshly created counterparty is visibly ungated and the UI can prompt
-- an operator to kick off a screen.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS ofac_status        text               NOT NULL DEFAULT 'unscreened',
  ADD COLUMN IF NOT EXISTS ofac_screened_at   timestamptz,
  ADD COLUMN IF NOT EXISTS ofac_highest_score double precision;

CREATE INDEX IF NOT EXISTS organizations_ofac_status_idx
  ON organizations (tenant_id, ofac_status)
  WHERE ofac_status != 'clear';

CREATE TABLE IF NOT EXISTS ofac_screens (
  id              text             PRIMARY KEY,
  tenant_id       text             NOT NULL,
  org_id          text             NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  screened_at     timestamptz      NOT NULL DEFAULT now(),
  -- Calendar date of the SDN XML used (not when we fetched it).
  sdn_list_date   text             NOT NULL,
  status          text             NOT NULL,
  highest_score   double precision NOT NULL DEFAULT 0,
  match_count     integer          NOT NULL DEFAULT 0,
  -- Structured match records (SdnUid + matched name + score + programs).
  -- JSONB so future fields don't need schema changes.
  matches         jsonb            NOT NULL DEFAULT '[]'::jsonb,
  cleared_by      text             REFERENCES users(id) ON DELETE SET NULL,
  cleared_at      timestamptz,
  cleared_reason  text
);

CREATE INDEX IF NOT EXISTS ofac_screens_tenant_idx
  ON ofac_screens (tenant_id, screened_at DESC);
CREATE INDEX IF NOT EXISTS ofac_screens_org_idx
  ON ofac_screens (org_id, screened_at DESC);
CREATE INDEX IF NOT EXISTS ofac_screens_status_idx
  ON ofac_screens (tenant_id, status)
  WHERE status IN ('potential_match', 'confirmed_match');

-- RLS — mirror the pattern from 0001_enable_rls.
DROP POLICY IF EXISTS tenant_isolation ON ofac_screens;
CREATE POLICY tenant_isolation ON ofac_screens
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE ofac_screens ENABLE ROW LEVEL SECURITY;
