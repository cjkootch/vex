-- Sprint Q — per-row notified_at on follow_ups so the cron can
-- tell which rows it's already fired notifications for.
--
-- Nullable. Populated the first time the notifier fires; a cron run
-- with `status='open' AND due_at <= now() AND notified_at IS NULL`
-- is O(index seek) thanks to the existing due_idx partial shape.

ALTER TABLE follow_ups ADD COLUMN IF NOT EXISTS notified_at timestamptz;
