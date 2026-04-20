-- 0013_workspace_strategy.sql
-- Sprint S — workspace-level strategy. A single JSONB column on
-- `workspaces` holds the operator-authored guiding principles
-- (mission, target markets, ICP buyers/suppliers, brand voice,
-- pricing philosophy, no-go zones, growth priorities,
-- additional_guidance free-form). The column is prepended to
-- every chat system prompt so Vex answers, drafts, and proposals
-- are conditioned on the tenant's strategy.
--
-- Nullable-feeling via JSONB defaults: rows that haven't been
-- authored yet get `{}` and the renderer produces an empty
-- preamble that the query prompt skips.
--
-- Defaulting to '{}' NOT NULL keeps the shape stable on every
-- read (no need for `?? {}` guards downstream).
--
-- No separate revisions table in v1 — edits overwrite in place.
-- A future audit trail (workspace_strategy_revisions) is a
-- follow-up PR; not strictly needed for the operator authoring
-- loop.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS strategy jsonb NOT NULL DEFAULT '{}';
