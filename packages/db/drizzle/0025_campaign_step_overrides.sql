-- 0025_campaign_step_overrides.sql
-- Adds `subject_override` + `body_override` columns to `campaign_steps`.
-- A workflow step can now ship UNTEMPLATED content directly: when
-- `template_ref` is null, the dispatcher reads the override columns and
-- writes them straight onto the approval payload. Mixed campaigns
-- (some templated steps, some inline) work without operators having
-- to register a template for every one-off body.
--
-- Validation invariant (enforced at the descriptor + dispatch layers,
-- not in SQL): every step except `manual` must set EITHER
-- `template_ref` OR (`body_override` AND, for email, `subject_override`).
-- Both null on a non-manual step is a misconfiguration that fails loud
-- at dispatch.

ALTER TABLE campaign_steps
  ADD COLUMN IF NOT EXISTS subject_override text,
  ADD COLUMN IF NOT EXISTS body_override text;
