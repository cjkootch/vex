-- Sprint 3 — enable RLS on every business table.
--
-- Sprint 1's 0000 migration created tenant_isolation policies on each table
-- but did not call ENABLE ROW LEVEL SECURITY. This migration flips them on
-- and creates a vex_migrator role that future migrations can SET ROLE to so
-- they bypass RLS while still running through the same connection user.

-- ============================================================================
-- vex_migrator role
-- ============================================================================
DO $$
BEGIN
    CREATE ROLE vex_migrator WITH BYPASSRLS NOLOGIN;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

-- Make the role usable from the standard Neon owner connection. The grant
-- itself is idempotent on Postgres.
GRANT vex_migrator TO neondb_owner;

-- ============================================================================
-- Workspaces — RLS policy uses `id` because the workspace IS the tenant.
-- The Sprint 1 migration created a placeholder policy that compared
-- `tenant_id`, but workspaces has no `tenant_id` column. Replace it.
-- ============================================================================
DROP POLICY IF EXISTS tenant_isolation ON workspaces;
CREATE POLICY tenant_isolation ON workspaces
    USING (id = current_setting('app.tenant_id', true))
    WITH CHECK (id = current_setting('app.tenant_id', true));
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- All other business tables — replace USING-only policies with USING + WITH
-- CHECK so INSERTs are validated against the session tenant too.
-- ============================================================================
DO $$
DECLARE
    t text;
    business_tables text[] := ARRAY[
        'users',
        'organizations',
        'contacts',
        'leads',
        'campaigns',
        'touchpoints',
        'threads',
        'messages',
        'activities',
        'documents',
        'summaries',
        'raw_events',
        'events',
        'embedding_chunks',
        'agent_runs',
        'approvals'
    ];
BEGIN
    FOREACH t IN ARRAY business_tables LOOP
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I '
            'USING (tenant_id = current_setting(''app.tenant_id'', true)) '
            'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))',
            t
        );
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;
END
$$;
