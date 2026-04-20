-- 0014_contact_merge_pointer.sql
-- Tombstone pointer for merged contacts. The merge executor sets
-- `status='archived'` + `merged_into_contact_id=<target>` so the UI
-- can render "archived — merged into X" and future reads can hop to
-- the canonical contact.
--
-- ON DELETE SET NULL so a hard-delete of the target (rare) doesn't
-- cascade-nuke the tombstones; they'd just become regular archived
-- contacts.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS merged_into_contact_id text
    REFERENCES contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS contacts_merged_into_idx
  ON contacts (merged_into_contact_id)
  WHERE merged_into_contact_id IS NOT NULL;
