# Vex observability — Grafana dashboards + alerts

OpenTelemetry metrics produced by the Vex services land in Prometheus
(or Grafana Cloud's metrics tier). This directory holds the dashboard
JSON and alert YAML so the observability config is versioned with code.

## Layout

- `dashboards/` — one Grafana dashboard JSON per surface
- `alerts/`     — Grafana-flavoured alert rule YAML, one per condition
- `provisioning/` — file-based provisioning configs for self-hosted Grafana

## Local quick start

1. `docker compose up -d` — boots Redis + Localstack + Temporal
2. Add a Grafana service alongside (out of scope for Sprint 7) and point
   it at this directory under `/etc/grafana/provisioning`
3. Each dashboard imports cleanly via Grafana's "Import dashboard" UI

## Producing the metrics

All eight metrics are defined in `packages/telemetry/src/metrics.ts`
(plus `vex.dlq.depth` which lives in `packages/agents/src/processors/dlq-processor.ts`
because it observes a BullMQ queue). The OTel SDK is initialised in each
service's bootstrap (`initOtel`); any production export target is
configured via `OTEL_EXPORTER_OTLP_ENDPOINT`.
