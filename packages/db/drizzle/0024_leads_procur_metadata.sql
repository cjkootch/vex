-- 0024_leads_procur_metadata.sql
-- Adds `procur_metadata` to `leads`. Holds the five structured blobs
-- procur PR #316 (2026-Q2) started sending on every
-- POST /ingest/procur/leads push: procurApproval, productSpecs,
-- sourceDocuments, marketContext, procurTradingDefaults. Stored
-- verbatim so we can surface them on the lead UI and the chat agent
-- without re-querying procur. Default `{}` keeps reads safe across
-- the deploy gap and for old leads that pre-date the column.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS procur_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
