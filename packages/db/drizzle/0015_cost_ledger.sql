-- 0015_cost_ledger.sql
-- Finally materialise the cost_ledger table. The schema + repository
-- files have existed since Sprint 2 but no migration ever created the
-- table, so `AnthropicAdapter.complete`, `OpenAIAdapter.embed`, and
-- every other integration that calls `costLedger.record(...)` was
-- writing to an InMemoryCostLedger Map that evaporates on process
-- restart. Admin → Cost tab read the empty table (caught 42P01) and
-- displayed $0.00 for everyone. This migration fixes that.
--
-- Using `text` for ids to match the rest of the codebase's ULID
-- convention (tenant_id = workspace ULID, agent_run_id = agent_runs.id).
-- Earlier draft schema used `uuid` but nothing else in the system does.
-- No FK on tenant_id: the ledger survives workspace cascades on
-- purpose (keeps billing auditable even if a workspace is torn down).
--
-- idempotency_key unique so retries never double-charge.
-- (tenant_id, occurred_at) index powers the admin range queries.

CREATE TABLE IF NOT EXISTS cost_ledger (
  id                 text        PRIMARY KEY,
  tenant_id          text        NOT NULL,
  agent_run_id       text,
  idempotency_key    text        NOT NULL UNIQUE,
  operation          text        NOT NULL,
  provider           text        NOT NULL,
  model              text,
  units              bigint      NOT NULL,
  unit_kind          text        NOT NULL,
  cost_usd_micros    bigint      NOT NULL,
  occurred_at        timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cost_ledger_tenant_occurred_at_idx
  ON cost_ledger (tenant_id, occurred_at);
