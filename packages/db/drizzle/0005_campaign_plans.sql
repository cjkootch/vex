-- Sprint C — campaign plans + enrollments.
--
-- Adds two tables the Temporal CampaignEnrollmentWorkflow (Sprint D)
-- will drive: the per-campaign ordered step sequence and the per-
-- recipient execution state. Both carry tenant_id for RLS parity with
-- every other business table; policies are installed by the standard
-- tenant-scope policy block at the end.

CREATE TABLE IF NOT EXISTS campaign_steps (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  campaign_id text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  position integer NOT NULL,
  channel text NOT NULL,
  delay_after_prior_ms integer NOT NULL DEFAULT 0,
  template_ref text,
  gate_condition_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  tier text NOT NULL DEFAULT 'T2',
  auto_approve boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaign_steps_tenant_idx
  ON campaign_steps(tenant_id);
CREATE INDEX IF NOT EXISTS campaign_steps_campaign_idx
  ON campaign_steps(campaign_id);
CREATE UNIQUE INDEX IF NOT EXISTS campaign_steps_position_uniq
  ON campaign_steps(tenant_id, campaign_id, position);

CREATE TABLE IF NOT EXISTS campaign_enrollments (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  campaign_id text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id text NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  current_step integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'enrolled',
  last_event_at timestamptz,
  branch_history_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaign_enrollments_tenant_idx
  ON campaign_enrollments(tenant_id);
CREATE INDEX IF NOT EXISTS campaign_enrollments_campaign_idx
  ON campaign_enrollments(campaign_id);
CREATE INDEX IF NOT EXISTS campaign_enrollments_contact_idx
  ON campaign_enrollments(contact_id);
CREATE INDEX IF NOT EXISTS campaign_enrollments_state_idx
  ON campaign_enrollments(state);
CREATE UNIQUE INDEX IF NOT EXISTS campaign_enrollments_uniq
  ON campaign_enrollments(tenant_id, campaign_id, contact_id);

-- RLS — same policy shape the rest of the workspace uses so these
-- tables never accidentally leak across tenants even when a new
-- direct-query code path forgets the withTenant wrapper.
ALTER TABLE campaign_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_enrollments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON campaign_steps;
CREATE POLICY tenant_isolation ON campaign_steps
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS tenant_isolation ON campaign_enrollments;
CREATE POLICY tenant_isolation ON campaign_enrollments
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
