# Service Level Objectives

Measurement window: rolling 30-day. Error-budget math uses the
per-objective ratio; the on-call rotation is paged when any objective's
30-day budget is below 20% with >48h left in the window.

## API

| SLO | Target | Probe |
|-----|-------:|-------|
| `/health` availability | 99.5% per month | `infra/k6/health-check.js`; Grafana synthetic probe every 60s |
| `/webhooks/*` p99 latency | < 200ms | `vex_webhook_received` + `http_req_duration` (k6 `webhook-ingest.js`) |
| `/query` p95 latency | < 5s | `vex_retrieval_query_latency_ms` (k6 `query-endpoint.js`) |

## Agent pipeline

| SLO | Target | Probe |
|-----|-------:|-------|
| Non-voice agent run completion | < 120s p95 | `vex_agent_run.count` × `duration` join, dashboard `agent-health.json` |
| Daily brief delivery | Before 07:30 UTC, 95% of weekdays | Grafana alert `vex-daily-brief-missing` |
| Voice transcript processing | < 60s p95 after `/end` | `voice.session.processed` audit event timestamp − `/end` timestamp |

## Data plane

| SLO | Target | Probe |
|-----|-------:|-------|
| Neon (pooled) p95 latency | < 300ms | `vex_neon_query_latency_ms` histogram |
| Normalization queue depth | < 1000 waiting + active | `vex_queue_depth{queue="normalization"}` |
| DLQ depth | 0 at EOD | `vex_dlq_depth` observable gauge |

## Cost

| SLO | Target | Probe |
|-----|-------:|-------|
| Per-tenant daily cost | ≤ `workspace.settings.daily_cost_limit` | `vex_agent_cost_usd_total` + cost-ledger sum; the AgentRunner's cost gate enforces this pre-flight |
| Global daily LLM spend | < $200 (soft), pager at $500 | Grafana `cost-ledger.json` panel "Cost by tenant (24h)" |

## On-call

See `/docs/runbooks/` for the incident playbooks. Each runbook closes
with a "Next steps to prevent recurrence" section — file a Linear
ticket there when you finish a page.
