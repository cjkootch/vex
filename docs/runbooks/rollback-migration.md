# Roll back a migration

Migrations live in `packages/db/drizzle/`. They are hand-authored SQL
files named `NNNN_<name>.sql`. Drizzle does not track down-migrations —
when we need to roll back we either (a) write a new forward migration
that reverses the change, or (b) PITR-restore the Neon branch.

## Decision tree

```
Did the migration succeed and the rollback is about bad behavior?
  → Write a new forward migration that reverses it.
Did the migration leave the DB in a broken state?
  → PITR-restore Neon to pre-deploy.
Is it a PR Neon branch (pr-123)?
  → Delete the branch, re-open the PR to recreate it.
```

## Option A — forward reverse migration

1. Copy the failing migration; author the reverse in a new file:
   ```bash
   NEXT=$(ls packages/db/drizzle | tail -n1 | awk -F_ '{printf "%04d", $1+1}')
   touch "packages/db/drizzle/${NEXT}_revert_<name>.sql"
   ```
2. Fill it with the reverse DDL (e.g. `DROP COLUMN` if the previous
   migration was `ADD COLUMN`).
3. Run it against `MIGRATION_DATABASE_URL`:
   ```bash
   pnpm --filter @vex/db run migrate
   ```
4. Deploy the code that stops writing to the removed column before
   merging.

## Option B — Neon PITR (branch promotion)

Neon point-in-time recovery is a branch + promote:

1. Create a branch from a timestamp before the bad migration:
   ```bash
   curl -sf -X POST \
     -H "Authorization: Bearer $NEON_API_KEY" \
     -H "Content-Type: application/json" \
     "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches" \
     -d '{"branch":{"name":"recover-2026-04-17","parent_timestamp":"2026-04-17T10:05:00Z"},"endpoints":[{"type":"read_write"}]}'
   ```
2. Verify:
   ```bash
   psql "<recover-branch-pooled-url>" -c "\\d <table_that_was_broken>"
   ```
3. Promote the recover branch to be primary via the Neon console
   (Project → Branches → recover-2026-04-17 → "Set as primary"). This
   updates `APPLICATION_DATABASE_URL` to point at the new endpoint —
   rotate the secret in Vercel + Fly.
4. Delete or archive the old primary when you're confident.

## Option C — PR Neon branch

Our GitHub Actions (`.github/workflows/neon-branch.yml`) creates a
`pr-<num>` branch per PR and deletes it on close. If the migration
wrecks a PR branch, close + reopen the PR — the workflow deletes and
recreates.

## Verifying

```bash
# Schema check
pnpm -F @vex/db run verify
# Smoke
pnpm --filter @vex/api run test -- --run webhooks
```

## Next steps to prevent recurrence

- Add a migration-test row to the eval suite that catches this class
  of schema error.
- If the migration touched a hot index, run it via
  `CREATE INDEX CONCURRENTLY` next time.
