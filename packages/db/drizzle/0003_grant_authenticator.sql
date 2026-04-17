-- Grant runtime DML privileges to the Neon `authenticator` role.
--
-- The app connects via APPLICATION_DATABASE_URL as `authenticator` so RLS
-- policies actually gate queries by tenant_id (table owner neondb_owner
-- would bypass RLS). Without explicit GRANTs, `authenticator` fails every
-- query with "permission denied for table <name>" before RLS even runs.
--
-- RLS stays in charge of row-level access — these grants only satisfy the
-- coarse table-level check that precedes it.

GRANT USAGE ON SCHEMA public TO authenticator;

GRANT SELECT, INSERT, UPDATE, DELETE
    ON ALL TABLES IN SCHEMA public TO authenticator;

GRANT USAGE, SELECT
    ON ALL SEQUENCES IN SCHEMA public TO authenticator;

-- Future tables/sequences created by neondb_owner pick up the same grants,
-- so the next schema migration doesn't reintroduce the gap.
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticator;

ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO authenticator;
