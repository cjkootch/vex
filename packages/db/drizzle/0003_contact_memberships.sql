-- Sprint 14 — contact_org_memberships.
--
-- Generalises the 1:1 `contacts.org_id` relationship into a proper
-- many-to-many so a person can represent multiple companies (e.g., a
-- trader brokering for several affiliated importers). The primary
-- membership per contact is preserved with a partial unique index.
--
-- Backwards compatibility:
--   - `contacts.org_id` is KEPT — it's the denormalised pointer to
--     the contact's primary org. Every writer updates both sides so
--     readers that haven't migrated (and the seed script) stay correct.
--   - The migration backfills a primary membership from every existing
--     row of `contacts`, so post-migrate the two views agree.

-- ============================================================================
-- contact_org_memberships
-- ============================================================================
CREATE TABLE contact_org_memberships (
    tenant_id   text NOT NULL,
    contact_id  text NOT NULL REFERENCES contacts(id)       ON DELETE CASCADE,
    org_id      text NOT NULL REFERENCES organizations(id)  ON DELETE CASCADE,
    role        text,
    is_primary  boolean NOT NULL DEFAULT false,
    since       timestamptz NOT NULL DEFAULT now(),
    until       timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (contact_id, org_id)
);

CREATE INDEX contact_org_memberships_tenant_idx
    ON contact_org_memberships (tenant_id);
CREATE INDEX contact_org_memberships_org_idx
    ON contact_org_memberships (org_id);
CREATE INDEX contact_org_memberships_contact_idx
    ON contact_org_memberships (contact_id);

-- Exactly one primary org per contact. Partial unique index lets
-- secondary rows coexist without the constraint firing.
CREATE UNIQUE INDEX contact_org_memberships_one_primary_per_contact
    ON contact_org_memberships (contact_id)
    WHERE is_primary;

-- ============================================================================
-- Backfill — every existing contact gets one primary membership from its
-- denormalised contacts.org_id. Safe to re-run because of ON CONFLICT.
-- ============================================================================
INSERT INTO contact_org_memberships
    (tenant_id, contact_id, org_id, is_primary, since, created_at, updated_at)
SELECT
    tenant_id,
    id,
    org_id,
    true,
    created_at,
    created_at,
    updated_at
FROM contacts
WHERE org_id IS NOT NULL
ON CONFLICT (contact_id, org_id) DO NOTHING;

-- ============================================================================
-- RLS — same USING + WITH CHECK pattern as every other business table.
-- ============================================================================
ALTER TABLE contact_org_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contact_org_memberships
    USING      (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
