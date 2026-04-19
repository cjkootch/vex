-- Sprint P — follow_ups: deferred action primitive.
--
-- Backs chat commands like "remind me about Acme next Thursday" and
-- "assign this to Jane". Rows persist until an operator marks them
-- completed or cancelled; the /app/follow-ups UI surfaces upcoming +
-- overdue sorted by due_at.
--
-- `subject_type` + `subject_id` link a follow-up to an org, contact,
-- deal, or enrollment so clicking a row can deep-link to the object.
-- Optional — standalone reminders ("call the lawyer Tuesday") have
-- both nullable.

CREATE TABLE IF NOT EXISTS follow_ups (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL,
  title         text NOT NULL,
  note          text,
  due_at        timestamptz NOT NULL,
  subject_type  text,
  subject_id    text,
  assigned_to   text,
  created_by    text NOT NULL,
  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'completed', 'cancelled')),
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS follow_ups_tenant_idx
  ON follow_ups (tenant_id);
CREATE INDEX IF NOT EXISTS follow_ups_due_idx
  ON follow_ups (tenant_id, status, due_at);
CREATE INDEX IF NOT EXISTS follow_ups_subject_idx
  ON follow_ups (tenant_id, subject_type, subject_id);

-- RLS — mirrors the rest of the schema.
ALTER TABLE follow_ups ENABLE ROW LEVEL SECURITY;
CREATE POLICY follow_ups_tenant_isolation ON follow_ups
  USING (tenant_id = current_setting('app.tenant_id', true));
