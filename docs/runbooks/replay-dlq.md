# Replay dead-letter jobs

Jobs that exhaust their BullMQ `attempts` land on the `dlq` queue. They
also land on the `raw_events.status = 'failed'` table (via the
DLQ processor). You replay them from the DB, not from Redis — the
Redis copy is an audit trail, the DB is source of truth.

## When to use

- DLQ depth > 0 on `vex.dlq.depth` (Grafana alert `vex-dlq-depth-high`)
- A schema / normalizer change means previously-failed events can now
  succeed

## Commands

### Replay a single event

```bash
pnpm --filter @vex/worker run replay -- --raw-event-id 01HSEEDRAW...
```

Expected output:

```
re-enqueuing raw_event 01HSEEDRAW000000000000000C
added normalization job id=01HSEEDRAW000000000000000C
```

### Replay every failed event

```bash
pnpm --filter @vex/worker run replay -- --dlq
```

Expected output:

```
found N failed raw_events
re-enqueued: N
```

The command uses the jobId convention `jobId = raw_event_id` so
double-enqueues become no-ops (BullMQ dedupe).

### Replay from a webhook fixture (dev only)

```bash
pnpm --filter @vex/worker run replay -- \
  --fixture packages/integrations/src/fixtures/resend-email-delivered.json \
  --provider resend
```

## Verifying

```bash
psql "$APPLICATION_DATABASE_URL" -c \
  "SELECT status, count(*) FROM raw_events GROUP BY status;"
```

You should see the `failed` count dropping as the normalization worker
processes the re-enqueued jobs. Check `vex.dlq.depth` in Grafana — it
should return to 0.

## Next steps to prevent recurrence

If the replay succeeds, the underlying bug was transient (provider
timeout, rate limit). If it fails the same way, investigate:

- is the normalizer assuming a field that's sometimes missing?
- did a provider schema change — Resend/Twilio version bump?
- do we need a new raw_event fixture in
  `packages/integrations/src/fixtures/` to reproduce in a unit test?
