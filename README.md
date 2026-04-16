# vex

AI-native revenue intelligence platform — https://vexhq.ai

## Layout

```
apps/
  web/       Next.js 14 App Router
  api/       NestJS + Fastify
  worker/    BullMQ + Temporal
packages/
  config/         zod env schema (APPLICATION_DATABASE_URL / MIGRATION_DATABASE_URL)
  domain/         branded ids, enums, ExternalKey, ApprovalTier
  db/             Drizzle ORM over Neon serverless Postgres
  integrations/   Anthropic, OpenAI, Twilio, Resend clients
  telemetry/      OpenTelemetry SDK + CostLedger interface
  ui/             ViewManifest schema + ManifestValidator
  agents/         typed ActionDescriptor / approval classification
```

## Requirements

- Node 20.11+
- pnpm 9+
- Docker (for local Redis + Localstack)

## Getting started

```bash
pnpm install
cp .env.example .env   # fill in values
docker compose up -d   # redis + localstack
pnpm -r run typecheck
pnpm -r run test
```

## Invariants

- No placeholder code.
- No raw provider payloads in `@vex/domain` types.
- All DB writes go through `withTenant(db, tenantId, fn)` (RLS wires in Sprint 3).
- All LLM calls record to `CostLedger`.
- The model never returns HTML — only typed `ViewManifest` trees.
- T2+ approval actions never execute without an approval row with `decision = approved`.
- `ManifestValidator` runs before any component renders.
