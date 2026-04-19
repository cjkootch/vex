-- 0010_signals.sql
--
-- Proactive signal layer. A `signal` is a system-generated alert
-- surfaced to operators without being asked — e.g. "deal 003
-- laycan in 3 days and BIS licence missing", "counterparty X
-- hasn't responded to 3 touchpoints", "margin on 001 dropped below
-- threshold". Rules run on a cron and insert rows here; the UI
-- shows unacknowledged signals newest-first.
--
-- Dedupe: (tenant_id, rule_id, subject_id) is unique with a partial
-- index so a rule firing twice on the same subject before the first
-- is acknowledged doesn't create a duplicate.

CREATE TABLE IF NOT EXISTS signals (
  id                text PRIMARY KEY,
  tenant_id         text NOT NULL,
  rule_id           text NOT NULL,
  severity          text NOT NULL DEFAULT 'warn', -- info | warn | critical
  subject_type      text,
  subject_id        text,
  title             text NOT NULL,
  body              text,
  metadata          jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  acknowledged_at   timestamptz,
  acknowledged_by   text
);

CREATE INDEX IF NOT EXISTS signals_tenant_idx
  ON signals (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS signals_tenant_unack_idx
  ON signals (tenant_id, created_at DESC)
  WHERE acknowledged_at IS NULL;

-- One open signal per (rule, subject) at a time. If the subject_id
-- is null (tenant-wide signal), the (tenant, rule) pair is unique.
CREATE UNIQUE INDEX IF NOT EXISTS signals_rule_subject_open_uq
  ON signals (tenant_id, rule_id, COALESCE(subject_id, ''))
  WHERE acknowledged_at IS NULL;

ALTER TABLE signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY signals_tenant_isolation ON signals
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
