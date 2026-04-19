-- Sprint O — per-row tag arrays on organizations + contacts.
--
-- Chat-initiated `org.tag` / `contact.tag` actions append strings to
-- these arrays; `org.untag` / `contact.untag` remove. JSONB instead
-- of a separate tags table because tags are a low-cardinality list
-- per row with no shared vocabulary to enforce.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE contacts       ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
