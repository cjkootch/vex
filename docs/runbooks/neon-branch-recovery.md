# Neon branch recovery (PITR)

Neon branches are copy-on-write from a parent. PITR = make a new branch
from a timestamp. "Recovery" = promote that branch to primary.

## When to use

- A destructive migration slipped past CI (see `rollback-migration.md`)
- A tenant-scoped data corruption was caught within the retention
  window (default 7 days on Neon free tier; 30 days on paid)
- You need a frozen snapshot to investigate without pausing the live
  system

## Procedure

### 1. Identify the recovery point

- Check `events` for the last known-good audit event timestamp:
  ```sql
  SELECT occurred_at FROM events
  WHERE verb = 'agent.completed' ORDER BY occurred_at DESC LIMIT 5;
  ```
- Or lift the timestamp from a Grafana screenshot that pre-dates the
  incident.

Format: ISO 8601 UTC, e.g. `2026-04-17T10:05:00Z`.

### 2. Create a branch from that timestamp

```bash
curl -sf -X POST \
  -H "Authorization: Bearer $NEON_API_KEY" \
  -H "Content-Type: application/json" \
  "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches" \
  -d '{
    "branch": {
      "name": "recover-2026-04-17",
      "parent_timestamp": "2026-04-17T10:05:00Z"
    },
    "endpoints": [{ "type": "read_write" }]
  }' | jq '.branch.id'
```

The response includes `branch.id` and the branch is ready in ~30s.

### 3. Inspect the recovery branch

```bash
# Pull connection URIs (pooled + direct)
CONN_POOLED=$(curl -sf \
  -H "Authorization: Bearer $NEON_API_KEY" \
  "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches/$BRANCH_ID/connection_uri?database_name=neondb&role_name=neondb_owner&pooled=true" \
  | jq -r '.uri')

psql "$CONN_POOLED" -c "SELECT count(*) FROM organizations;"
```

### 4. Promote to primary (only if the main DB is unsalvageable)

Via Neon console: Project → Branches → `recover-2026-04-17` →
**Set as primary**.

Immediately after promotion:

- Update `APPLICATION_DATABASE_URL` and `MIGRATION_DATABASE_URL` in
  Vercel (apps/web) and Fly (apps/api, apps/worker).
- Re-run any migrations that were merged after the recovery timestamp
  and are still wanted.
- Restart apps/api and apps/worker so they pick up the new URL.

### 5. Clean up

- Archive the old primary branch (console → Archive) after a safety
  window (48h).
- Delete the recovery branch after primary promotion is confirmed.

## Verifying

- `/health/detailed` on apps/api reports `db.status: "ok"`.
- The worker's `vex.dlq.depth` gauge is stable and the
  `normalization` queue is draining.
- `vex_neon_query_latency_ms` p95 is < 300ms.

## Next steps to prevent recurrence

If the trigger was a bad migration → see `rollback-migration.md`'s
prevention section. If the trigger was corrupted data from an
integration bug → add a test that replays the offending raw_event
from a saved fixture.
