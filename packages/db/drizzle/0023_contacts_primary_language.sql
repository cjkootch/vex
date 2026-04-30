-- 0023_contacts_primary_language.sql
-- Adds `primary_language` to `contacts`. Populated by the
-- ContactEnrichmentAgent from public signals (location, employer
-- region, profile language) and consumed by the chat agent so email
-- drafts default to the recipient's language. ISO 639-1 (e.g. "en",
-- "es", "zh"). Nullable — null means "no inference yet" and the chat
-- agent falls back to English.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS primary_language text;
