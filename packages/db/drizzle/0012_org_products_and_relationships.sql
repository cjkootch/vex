-- 0012_org_products_and_relationships.sql
--
-- Sprint W — counterparty shape + product catalog + broker/supplier
-- graph. Three additions.
--
-- 1. organizations.kind — free-form text (not an enum, so the role
--    vocabulary can evolve without migrations). Populated values we
--    expect: 'buyer', 'supplier', 'broker', 'buyer_broker', 'internal',
--    'competitor'. Null means "unknown / not yet classified" which
--    matches every pre-sprint-W org.
--
-- 2. organization_products — which products an org can source,
--    broker, or buy. The same broker may appear multiple times (one
--    row per product). Works for brokers whose upstream suppliers
--    are unknown: they get product rows without relationship rows.
--
-- 3. organization_relationships — directed edges between orgs. The
--    primary use-case is broker → supplier ("Broker A brokers rice
--    for Supplier B"), but the shape is generic enough to cover
--    subsidiaries, partners, etc. later. `product` is nullable so a
--    relationship can span all products or a specific one.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS kind text;

ALTER TABLE organizations
  ADD CONSTRAINT organizations_kind_check
    CHECK (
      kind IS NULL
      OR kind IN (
        'buyer',
        'supplier',
        'broker',
        'buyer_broker',
        'internal',
        'competitor'
      )
    );

CREATE INDEX IF NOT EXISTS organizations_kind_idx
  ON organizations (tenant_id, kind);

-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organization_products (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL,
  org_id        text NOT NULL
                REFERENCES organizations(id) ON DELETE CASCADE,
  -- Matches the product_type enum but stored as text so brokers can
  -- tag products we haven't formally catalogued yet. The app layer
  -- validates against the enum on insert.
  product       text NOT NULL,
  notes         text,
  added_by      text,
  added_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS organization_products_org_product_uq
  ON organization_products (tenant_id, org_id, product);

CREATE INDEX IF NOT EXISTS organization_products_product_idx
  ON organization_products (tenant_id, product);

ALTER TABLE organization_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_products_tenant_isolation ON organization_products
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organization_relationships (
  id                 text PRIMARY KEY,
  tenant_id          text NOT NULL,
  from_org_id        text NOT NULL
                      REFERENCES organizations(id) ON DELETE CASCADE,
  to_org_id          text NOT NULL
                      REFERENCES organizations(id) ON DELETE CASCADE,
  relationship_type  text NOT NULL,
  -- Product-specific relationships (e.g. "A brokers rice for B")
  -- set this; all-products relationships leave it null.
  product            text,
  notes              text,
  added_by           text,
  added_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (from_org_id <> to_org_id),
  CHECK (
    relationship_type IN (
      'brokers_for',
      'sources_from',
      'partners_with',
      'subsidiary_of'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS organization_relationships_uq
  ON organization_relationships (
    tenant_id,
    from_org_id,
    to_org_id,
    relationship_type,
    COALESCE(product, '')
  );

CREATE INDEX IF NOT EXISTS organization_relationships_from_idx
  ON organization_relationships (tenant_id, from_org_id, relationship_type);

CREATE INDEX IF NOT EXISTS organization_relationships_to_idx
  ON organization_relationships (tenant_id, to_org_id, relationship_type);

ALTER TABLE organization_relationships ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_relationships_tenant_isolation ON organization_relationships
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------
-- Two-sided brokers on a deal.
--
-- The existing `intermediary_org_id` column represents a single
-- broker slot. Real VTC deals sometimes have a broker on both the
-- buy side (represents the buyer) AND the sell side (represents the
-- supplier), each with their own commission + payment structure.
-- Add explicit buy/sell slots; leave intermediary_org_id in place
-- for back-compat. Payment terms stored as free-form text so
-- operators can capture "1.5% on delivery", "$0.002/USG wired at BL",
-- "flat $5k on signing" without schema acrobatics.
-- ---------------------------------------------------------------------

ALTER TABLE fuel_deals
  ADD COLUMN IF NOT EXISTS buy_side_broker_org_id text
    REFERENCES organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS buy_side_broker_commission_pct double precision,
  ADD COLUMN IF NOT EXISTS buy_side_broker_payment_terms text,
  ADD COLUMN IF NOT EXISTS sell_side_broker_org_id text
    REFERENCES organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sell_side_broker_commission_pct double precision,
  ADD COLUMN IF NOT EXISTS sell_side_broker_payment_terms text;

CREATE INDEX IF NOT EXISTS fuel_deals_buy_side_broker_idx
  ON fuel_deals (buy_side_broker_org_id)
  WHERE buy_side_broker_org_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS fuel_deals_sell_side_broker_idx
  ON fuel_deals (sell_side_broker_org_id)
  WHERE sell_side_broker_org_id IS NOT NULL;
