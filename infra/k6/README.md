# k6 load tests

Three load tests matched to the Sprint 10 SLOs. Run against staging or
a throwaway Neon branch — **never** against production with real
`ANTHROPIC_API_KEY` credentials.

## Prerequisites

- `k6` 0.52+ installed (`brew install k6` or [grafana.com/k6](https://grafana.com/docs/k6/latest/get-started/installation/))
- A staging `apps/api` deployment with a public base URL
- A Neon branch promoted to be the staging database for the duration
  of the test (see `/docs/runbooks/neon-branch-recovery.md`)

## Tests

### `health-check.js`

Unauthenticated `/health`. Proves the Fastify + Nest dispatch path can
sustain 1000 rps with p99 < 50ms.

```bash
BASE_URL=https://staging-api.vex.local \
  k6 run infra/k6/health-check.js
```

### `webhook-ingest.js`

Signed Resend webhooks → DB insert → BullMQ enqueue. p99 < 200ms at 500
concurrent senders.

```bash
BASE_URL=https://staging-api.vex.local \
RESEND_WEBHOOK_SECRET=whsec_<base64> \
  k6 run --vus 500 --duration 60s infra/k6/webhook-ingest.js
```

### `query-endpoint.js`

Authenticated `/query` — embed → retrieve → Claude completion. p95 < 5s
at 50 concurrent users. Expensive; expect ~$2–$5 per 60s run on a
fresh eval tenant.

```bash
BASE_URL=https://staging-api.vex.local \
QUERY_BEARER=eyJhbGciOi...        # NextAuth JWE for an eval tenant
  k6 run --vus 50 --duration 60s infra/k6/query-endpoint.js
```

## Pass/fail

Each script encodes its thresholds in `options.thresholds`. A failing
threshold turns the k6 summary red and the process exits non-zero — CI
can gate merges on it.
