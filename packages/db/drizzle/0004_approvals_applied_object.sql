-- Sprint 15 — approval idempotency via applied_object_id.
--
-- The approval executor creates CRM entities (organizations, contacts,
-- fuel deals) from approved rows. Until now those creates always ran
-- on every retry, so an at-least-once queue could silently produce
-- duplicate orgs/contacts/deals for a single approval.
--
-- Record the id of the entity each approval produced, plus the
-- timestamp it was applied, so the executor can short-circuit a
-- retry that arrives after the create already succeeded.

ALTER TABLE "approvals"
  ADD COLUMN IF NOT EXISTS "applied_object_id" text,
  ADD COLUMN IF NOT EXISTS "applied_at" timestamptz;
