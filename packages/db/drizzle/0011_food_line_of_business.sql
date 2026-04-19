-- 0011_food_line_of_business.sql
--
-- Sprint V — extend fuel_deals into a general commodity-deal table
-- with a line_of_business discriminator. Existing rows default to
-- 'fuel' so behaviour is unchanged; new food rows live in the same
-- table with their own product values + a few food-specific columns
-- (lead time, cold chain). Deliberately NOT renaming the table —
-- downstream code + dashboards + Temporal workflow names all assume
-- "fuel_deals"; a rename is a bigger refactor worth doing separately.
--
-- Product enum gains rice / beans / pork / chicken / cooking_oil /
-- powdered_milk. Incoterm / status / cost stack / cashflow tables
-- are all commodity-agnostic and need no changes.

-- 1. line_of_business + volume_unit + food-specific columns.
ALTER TABLE fuel_deals
  ADD COLUMN IF NOT EXISTS line_of_business text NOT NULL DEFAULT 'fuel',
  ADD COLUMN IF NOT EXISTS volume_unit text NOT NULL DEFAULT 'usg',
  ADD COLUMN IF NOT EXISTS production_lead_time_weeks integer,
  ADD COLUMN IF NOT EXISTS cold_chain_required boolean NOT NULL DEFAULT false;

ALTER TABLE fuel_deals
  ADD CONSTRAINT fuel_deals_line_of_business_check
    CHECK (line_of_business IN ('fuel', 'food'));

ALTER TABLE fuel_deals
  ADD CONSTRAINT fuel_deals_volume_unit_check
    CHECK (volume_unit IN ('usg', 'mt', 'kg', 'lbs', 'containers'));

CREATE INDEX IF NOT EXISTS fuel_deals_line_of_business_idx
  ON fuel_deals (line_of_business, status);

-- density_kg_l is fuel-specific — make it nullable so food rows
-- can omit. Existing fuel rows keep their value; the calculator
-- branches on line_of_business and skips density math for food.
ALTER TABLE fuel_deals
  ALTER COLUMN density_kg_l DROP NOT NULL;

-- 2. product_type enum gains the six food staples VTC trades.
ALTER TYPE product_type ADD VALUE IF NOT EXISTS 'rice';
ALTER TYPE product_type ADD VALUE IF NOT EXISTS 'beans';
ALTER TYPE product_type ADD VALUE IF NOT EXISTS 'pork';
ALTER TYPE product_type ADD VALUE IF NOT EXISTS 'chicken';
ALTER TYPE product_type ADD VALUE IF NOT EXISTS 'cooking_oil';
ALTER TYPE product_type ADD VALUE IF NOT EXISTS 'powdered_milk';
