-- 0021_identity_indexes.sql
-- Identity / dedupe indexes.
--
-- Three repos do check-by-JSONB-key lookups that were reading every
-- row into Node and filtering in memory:
--   - ContactRepository.findByEmail         (contacts.emails)
--   - LeadRepository.findByExternalKey      (leads.external_keys)
--   - OrganizationRepository.findByExternalKey (organizations.external_keys)
--
-- At current volume the scan is fine, but the behaviour gets
-- exponentially worse as rows grow. These GIN indexes back JSONB
-- containment queries (`@>`), which each lookup now uses at the SQL
-- level. Index build is online via CONCURRENTLY; IF NOT EXISTS keeps
-- reruns idempotent.
--
-- Phones get an index too so "find duplicate by phone" becomes cheap
-- — the Sprint 7 contact dedupe contract now includes phone as well
-- as email.
--
-- Note: jsonb_path_ops is the smaller operator class but only
-- supports `@>`. All the lookups in the repos use `@>` now, so this
-- is fine. If a future query needs full-JSONB ops (`?`, `?|`, `?&`)
-- we'll widen it to the default class then.

CREATE INDEX IF NOT EXISTS contacts_emails_gin_idx
  ON contacts USING GIN (emails jsonb_path_ops);

CREATE INDEX IF NOT EXISTS contacts_phones_gin_idx
  ON contacts USING GIN (phones jsonb_path_ops);

CREATE INDEX IF NOT EXISTS contacts_external_keys_gin_idx
  ON contacts USING GIN (external_keys jsonb_path_ops);

CREATE INDEX IF NOT EXISTS organizations_external_keys_gin_idx
  ON organizations USING GIN (external_keys jsonb_path_ops);

CREATE INDEX IF NOT EXISTS leads_external_keys_gin_idx
  ON leads USING GIN (external_keys jsonb_path_ops);
