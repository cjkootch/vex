-- Grant table + sequence privileges to vex_migrator.
--
-- 0001 created vex_migrator with BYPASSRLS but no GRANTs. SET ROLE
-- vex_migrator therefore dropped every table privilege the session had
-- and DML failed with 42501 "permission denied for table workspaces" —
-- seen when running pnpm db:seed. BYPASSRLS only suppresses RLS policy
-- checks; it does not imply SELECT/INSERT/UPDATE/DELETE.
--
-- These GRANTs must execute as the table owner, not as vex_migrator, so
-- reset the role set at session level by migrate.ts. SET LOCAL scopes
-- the reset to this migration's transaction.
SET LOCAL ROLE NONE;

GRANT USAGE ON SCHEMA public TO vex_migrator;

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER
    ON ALL TABLES IN SCHEMA public TO vex_migrator;

GRANT USAGE, SELECT, UPDATE
    ON ALL SEQUENCES IN SCHEMA public TO vex_migrator;

-- Future tables/sequences created by neondb_owner inherit these grants so
-- the next schema migration doesn't reintroduce the same hole.
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON TABLES TO vex_migrator;

ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
    GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO vex_migrator;
