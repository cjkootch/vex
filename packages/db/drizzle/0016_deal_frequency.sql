-- 0016_deal_frequency.sql
-- Adds a cadence discriminator to fuel_deals so the creator can capture
-- one-off vs recurring deal structures. Text + defaulted so existing
-- rows stay valid without a backfill. `deal_frequency` covers the
-- common cases (one_off / weekly / biweekly / monthly) and 'custom'
-- opens the door for operator-defined intervals via
-- `deal_frequency_interval_days`.

ALTER TABLE fuel_deals
  ADD COLUMN IF NOT EXISTS deal_frequency text NOT NULL DEFAULT 'one_off';

ALTER TABLE fuel_deals
  ADD COLUMN IF NOT EXISTS deal_frequency_interval_days integer;

ALTER TABLE fuel_deals
  ADD COLUMN IF NOT EXISTS deal_frequency_notes text;
