-- Sprint 11 — Vex fuel deal domain for Vector Trade Capital.
--
-- Seven new tables:
--   fuel_deals                         primary deal record
--   fuel_deal_cost_stack               detailed cost build-up (1:1 with deal)
--   fuel_deal_cashflow_events          timeline of inflows/outflows
--   fuel_deal_scenarios                base/conservative/aggressive/stress
--   fuel_deal_counterparty_scores      structured counterparty risk
--   fuel_deal_documents                term sheets, LCs, BLs, OFAC reports
--   fuel_market_rates                  benchmark price reference
--
-- RLS pattern: every business table is enabled with a tenant_isolation
-- policy using both USING and WITH CHECK against `app.tenant_id` — matches
-- the Sprint 3 convention.

-- ============================================================================
-- Enum types
-- ============================================================================
CREATE TYPE deal_status AS ENUM (
    'draft', 'negotiating', 'pending_approval', 'approved', 'loading',
    'in_transit', 'delivered', 'settled', 'cancelled', 'failed'
);

CREATE TYPE deal_type AS ENUM ('spot', 'program', 'tender', 'spot_with_option');

CREATE TYPE product_type AS ENUM (
    'ulsd', 'gasoline_87', 'gasoline_91', 'jet_a', 'jet_a1',
    'avgas', 'lfo', 'hfo', 'lng', 'lpg', 'biodiesel_b20'
);

CREATE TYPE incoterm AS ENUM ('fob', 'cif', 'cfr', 'dap', 'exw', 'fas');

CREATE TYPE pricing_basis AS ENUM (
    'platts', 'argus', 'opis', 'nymex_wti', 'nymex_rbob',
    'ice_brent', 'fixed', 'negotiated'
);

CREATE TYPE payment_terms AS ENUM (
    'prepayment_100', 'prepayment_80_20', 'lc_sight', 'lc_60d',
    'lc_90d', 'lc_120d', 'sblc', 'open_account',
    'telegraphic_transfer', 'mixed'
);

CREATE TYPE deal_currency AS ENUM (
    'usd', 'eur', 'cad', 'jmd', 'ttd', 'dop', 'bbd', 'xcd'
);

CREATE TYPE vessel_type AS ENUM (
    'tanker_mr', 'tanker_lr1', 'tanker_lr2', 'tanker_vlcc',
    'barge', 'coastal_tanker', 'isocontainer', 'flexitank'
);

CREATE TYPE freight_basis AS ENUM (
    'per_usg', 'lump_sum', 'worldscale', 'time_charter_eq'
);

CREATE TYPE ofac_screening_status AS ENUM (
    'not_started', 'in_progress', 'cleared', 'flagged', 'rejected'
);

CREATE TYPE scenario_type AS ENUM (
    'base', 'conservative', 'aggressive', 'stress', 'custom'
);

CREATE TYPE cashflow_direction AS ENUM ('inflow', 'outflow');

CREATE TYPE cashflow_event_type AS ENUM (
    'buyer_prepayment', 'buyer_final_payment', 'lc_payment',
    'product_purchase', 'freight_payment', 'freight_deposit',
    'insurance_premium', 'port_fees', 'compliance_fees',
    'bank_fees', 'intermediary_fee', 'storage_fees',
    'demurrage', 'overhead', 'custom'
);

CREATE TYPE cashflow_base_type AS ENUM (
    'revenue', 'product_cost', 'freight', 'insurance',
    'port_handling', 'compliance', 'finance', 'overhead', 'custom'
);

CREATE TYPE deal_document_type AS ENUM (
    'term_sheet', 'loi', 'spa', 'lc', 'sblc', 'bl', 'coa', 'q88',
    'inspection_report', 'ofac_screening', 'bis_license', 'eei',
    'insurance_cert', 'customs_entry', 'invoice', 'packing_list',
    'sddr', 'other'
);

CREATE TYPE counterparty_risk_tier AS ENUM (
    'tier_1', 'tier_2', 'tier_3', 'watch', 'declined'
);

-- ============================================================================
-- fuel_deals
-- ============================================================================
CREATE TABLE fuel_deals (
    id                          text PRIMARY KEY,
    tenant_id                   text NOT NULL,
    deal_ref                    text NOT NULL,
    status                      deal_status NOT NULL DEFAULT 'draft',
    deal_type                   deal_type NOT NULL DEFAULT 'spot',
    product                     product_type NOT NULL,
    product_grade               text,
    product_spec_notes          text,

    origin_country              text,
    origin_port                 text,
    origin_terminal             text,
    destination_country         text,
    destination_port            text,
    destination_terminal        text,

    incoterm                    incoterm NOT NULL,
    pricing_basis               pricing_basis NOT NULL,
    pricing_formula             text,
    price_lock_date             date,
    price_lock_time             text,

    volume_usg                  double precision NOT NULL,
    volume_mt                   double precision,
    volume_bbls                 double precision,
    density_kg_l                double precision NOT NULL,
    volume_tolerance_pct        double precision NOT NULL DEFAULT 0,

    currency                    deal_currency NOT NULL DEFAULT 'usd',
    fx_rate_to_usd              double precision NOT NULL DEFAULT 1,
    fx_hedge_in_place           boolean NOT NULL DEFAULT false,
    fx_hedge_rate               double precision,
    fx_hedge_instrument         text,
    fx_hedge_expiry             date,

    buyer_org_id                text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    buyer_contact_id            text REFERENCES contacts(id) ON DELETE SET NULL,
    seller_org_id               text REFERENCES organizations(id) ON DELETE SET NULL,
    intermediary_org_id         text REFERENCES organizations(id) ON DELETE SET NULL,
    intermediary_role           text,

    lead_id                     text REFERENCES leads(id) ON DELETE SET NULL,
    campaign_id                 text REFERENCES campaigns(id) ON DELETE SET NULL,

    laycan_start                date,
    laycan_end                  date,
    bl_date_estimated           date,
    bl_date_actual              date,
    eta_destination             date,
    eta_actual                  date,

    payment_terms               payment_terms NOT NULL,
    lc_issuing_bank             text,
    lc_confirming_bank          text,
    lc_value_usd                double precision,
    lc_expiry_date              date,
    lc_margin_pct               double precision,
    sblc_value_usd              double precision,

    trade_finance_cost_pct      double precision NOT NULL DEFAULT 0,

    ofac_screening_status       ofac_screening_status NOT NULL DEFAULT 'not_started',
    bis_license_required        boolean NOT NULL DEFAULT false,
    bis_license_number          text,
    bis_license_expiry          date,
    eei_filing_required         boolean NOT NULL DEFAULT false,
    eei_itn                     text,
    compliance_hold             boolean NOT NULL DEFAULT false,
    compliance_notes            text,

    counterparty_risk_score     double precision,
    country_risk_score          double precision,
    political_risk_insured      boolean NOT NULL DEFAULT false,

    notes                       text,
    internal_notes              text,
    created_by                  text REFERENCES users(id) ON DELETE SET NULL,
    approved_by                 text REFERENCES users(id) ON DELETE SET NULL,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fuel_deals_tenant_idx     ON fuel_deals (tenant_id);
CREATE INDEX fuel_deals_status_idx     ON fuel_deals (status);
CREATE INDEX fuel_deals_buyer_idx      ON fuel_deals (buyer_org_id);
CREATE INDEX fuel_deals_product_idx    ON fuel_deals (product);
CREATE INDEX fuel_deals_laycan_idx     ON fuel_deals (laycan_start);
CREATE INDEX fuel_deals_created_at_idx ON fuel_deals (created_at);
CREATE INDEX fuel_deals_deal_ref_idx   ON fuel_deals (tenant_id, deal_ref);

-- ============================================================================
-- fuel_deal_cost_stack  (1:1 with fuel_deals)
-- ============================================================================
CREATE TABLE fuel_deal_cost_stack (
    id                            text PRIMARY KEY,
    tenant_id                     text NOT NULL,
    deal_id                       text NOT NULL REFERENCES fuel_deals(id) ON DELETE CASCADE,

    product_cost_per_usg          double precision NOT NULL,
    product_quality_premium_usg   double precision NOT NULL DEFAULT 0,
    product_cost_basis            text,

    vessel_name                   text,
    vessel_imo                    text,
    vessel_flag                   text,
    vessel_type                   vessel_type,
    vessel_capacity_usg           double precision,
    vessel_utilization_pct        double precision,
    freight_basis                 freight_basis NOT NULL DEFAULT 'per_usg',
    freight_rate_raw              double precision NOT NULL DEFAULT 0,
    freight_rate_per_usg          double precision NOT NULL DEFAULT 0,
    freight_currency              deal_currency NOT NULL DEFAULT 'usd',
    demurrage_rate_per_day        double precision,
    demurrage_allowed_hours       double precision,
    demurrage_days_estimated      double precision,
    demurrage_cost_estimated      double precision,
    despatch_rate_per_day         double precision,
    port_dues_load_usd            double precision,
    port_dues_discharge_usd       double precision,
    canal_transit_cost_usd        double precision,
    bunkering_cost_usd            double precision,
    freight_total_usd             double precision NOT NULL DEFAULT 0,
    freight_per_usg_all_in        double precision NOT NULL DEFAULT 0,

    cargo_insurance_pct           double precision NOT NULL DEFAULT 0,
    cargo_insurance_usd           double precision NOT NULL DEFAULT 0,
    war_risk_premium_pct          double precision,
    war_risk_usd                  double precision,
    pi_contribution_usd           double precision,
    political_risk_premium_pct    double precision,
    political_risk_usd            double precision,
    total_insurance_per_usg       double precision NOT NULL DEFAULT 0,

    discharge_port_fee_usd        double precision,
    storage_fee_per_day_usd       double precision,
    storage_days_estimated        double precision,
    storage_cost_usd              double precision,
    customs_clearance_usd         double precision,
    inspection_fee_usd            double precision,
    sampling_testing_usd          double precision,
    shore_tank_rental_usd         double precision,
    blending_cost_usd             double precision,
    discharge_handling_per_usg    double precision NOT NULL DEFAULT 0,

    ofac_screening_fee_usd        double precision,
    bis_license_fee_usd           double precision,
    eei_filing_fee_usd            double precision,
    compliance_legal_usd          double precision,
    kyc_aml_cost_usd              double precision,
    sanctions_insurance_usd       double precision,
    total_compliance_per_usg      double precision NOT NULL DEFAULT 0,

    lc_fee_usd                    double precision,
    lc_discount_fee_usd           double precision,
    bank_guarantee_fee_usd        double precision,
    trade_finance_total_usd       double precision NOT NULL DEFAULT 0,
    trade_finance_per_usg         double precision NOT NULL DEFAULT 0,

    intermediary_fee_pct          double precision,
    intermediary_fee_usd          double precision,
    local_agent_fee_usd           double precision,
    brokerage_pct                 double precision,
    brokerage_usd                 double precision,
    total_agent_per_usg           double precision NOT NULL DEFAULT 0,

    vtc_variable_ops_per_usg      double precision NOT NULL DEFAULT 0,

    overhead_allocation_usd       double precision NOT NULL DEFAULT 0,
    overhead_per_usg              double precision NOT NULL DEFAULT 0,

    total_landed_cost_per_usg     double precision NOT NULL DEFAULT 0,
    gross_margin_per_usg          double precision NOT NULL DEFAULT 0,
    gross_margin_pct              double precision NOT NULL DEFAULT 0,
    net_margin_per_usg            double precision NOT NULL DEFAULT 0,
    net_margin_pct                double precision NOT NULL DEFAULT 0,
    ebitda_usd                    double precision NOT NULL DEFAULT 0,
    breakeven_sell_price_usg      double precision NOT NULL DEFAULT 0,

    created_at                    timestamptz NOT NULL DEFAULT now(),
    updated_at                    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fuel_deal_cost_stack_tenant_idx ON fuel_deal_cost_stack (tenant_id);
CREATE INDEX fuel_deal_cost_stack_deal_idx   ON fuel_deal_cost_stack (deal_id);

-- ============================================================================
-- fuel_deal_cashflow_events
-- ============================================================================
CREATE TABLE fuel_deal_cashflow_events (
    id                        text PRIMARY KEY,
    tenant_id                 text NOT NULL,
    deal_id                   text NOT NULL REFERENCES fuel_deals(id) ON DELETE CASCADE,
    day_relative              integer NOT NULL,
    label                     text NOT NULL,
    direction                 cashflow_direction NOT NULL,
    event_type                cashflow_event_type NOT NULL,
    base_type                 cashflow_base_type NOT NULL,
    amount_pct                double precision,
    amount_fixed_usd          double precision,
    amount_calculated_usd     double precision NOT NULL DEFAULT 0,
    currency                  text NOT NULL DEFAULT 'usd',
    fx_rate                   double precision NOT NULL DEFAULT 1,
    counterparty              text,
    payment_method            text,
    notes                     text,
    created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fuel_deal_cashflow_events_tenant_idx   ON fuel_deal_cashflow_events (tenant_id);
CREATE INDEX fuel_deal_cashflow_events_deal_idx     ON fuel_deal_cashflow_events (deal_id);
CREATE INDEX fuel_deal_cashflow_events_deal_day_idx ON fuel_deal_cashflow_events (deal_id, day_relative);

-- ============================================================================
-- fuel_deal_scenarios
-- ============================================================================
CREATE TABLE fuel_deal_scenarios (
    id                           text PRIMARY KEY,
    tenant_id                    text NOT NULL,
    deal_id                      text NOT NULL REFERENCES fuel_deals(id) ON DELETE CASCADE,
    scenario_name                text NOT NULL,
    scenario_type                scenario_type NOT NULL DEFAULT 'base',
    is_active                    boolean NOT NULL DEFAULT false,

    volume_usg_override          double precision,
    sell_price_per_usg           double precision NOT NULL,
    product_cost_override        double precision,
    freight_override_per_usg     double precision,
    fx_rate_override             double precision,
    demurrage_days_override      double precision,
    storage_days_override        double precision,

    results_json                 jsonb,
    score                        double precision,
    recommendation               text,
    calculated_at                timestamptz,

    notes                        text,
    created_at                   timestamptz NOT NULL DEFAULT now(),
    updated_at                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fuel_deal_scenarios_tenant_idx ON fuel_deal_scenarios (tenant_id);
CREATE INDEX fuel_deal_scenarios_deal_idx   ON fuel_deal_scenarios (deal_id);
CREATE INDEX fuel_deal_scenarios_active_idx ON fuel_deal_scenarios (deal_id, is_active);

-- ============================================================================
-- fuel_deal_counterparty_scores
-- ============================================================================
CREATE TABLE fuel_deal_counterparty_scores (
    id                              text PRIMARY KEY,
    tenant_id                       text NOT NULL,
    org_id                          text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    scored_at                       timestamptz NOT NULL DEFAULT now(),
    scored_by                       text REFERENCES users(id) ON DELETE SET NULL,

    country_risk                    double precision NOT NULL,
    payment_history_risk            double precision NOT NULL,
    credit_risk                     double precision NOT NULL,
    sanctions_exposure_risk         double precision NOT NULL,
    ownership_transparency_risk     double precision NOT NULL,
    regulatory_complexity_risk      double precision NOT NULL,
    operational_risk                double precision NOT NULL,
    concentration_risk              double precision NOT NULL,

    composite_score                 double precision NOT NULL,
    risk_tier                       counterparty_risk_tier NOT NULL,
    recommended_payment_terms       text,
    recommended_max_exposure_usd    double precision,
    notes                           text
);
CREATE INDEX fuel_deal_counterparty_scores_tenant_idx ON fuel_deal_counterparty_scores (tenant_id);
CREATE INDEX fuel_deal_counterparty_scores_org_idx    ON fuel_deal_counterparty_scores (org_id);
CREATE INDEX fuel_deal_counterparty_scores_tier_idx   ON fuel_deal_counterparty_scores (risk_tier);

-- ============================================================================
-- fuel_deal_documents
-- ============================================================================
CREATE TABLE fuel_deal_documents (
    id               text PRIMARY KEY,
    tenant_id        text NOT NULL,
    deal_id          text NOT NULL REFERENCES fuel_deals(id) ON DELETE CASCADE,
    document_type    deal_document_type NOT NULL,
    storage_key      text NOT NULL,
    filename         text NOT NULL,
    uploaded_by      text REFERENCES users(id) ON DELETE SET NULL,
    uploaded_at      timestamptz NOT NULL DEFAULT now(),
    notes            text
);
CREATE INDEX fuel_deal_documents_tenant_idx ON fuel_deal_documents (tenant_id);
CREATE INDEX fuel_deal_documents_deal_idx   ON fuel_deal_documents (deal_id);
CREATE INDEX fuel_deal_documents_type_idx   ON fuel_deal_documents (deal_id, document_type);

-- ============================================================================
-- fuel_market_rates
-- ============================================================================
CREATE TABLE fuel_market_rates (
    id              text PRIMARY KEY,
    tenant_id       text NOT NULL,
    rate_date       date NOT NULL,
    product         text NOT NULL,
    benchmark       text NOT NULL,
    price_per_usg   double precision NOT NULL,
    price_per_bbl   double precision NOT NULL,
    price_per_mt    double precision NOT NULL,
    currency        text NOT NULL DEFAULT 'usd',
    source          text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fuel_market_rates_tenant_idx             ON fuel_market_rates (tenant_id);
CREATE INDEX fuel_market_rates_product_benchmark_idx  ON fuel_market_rates (product, benchmark);
CREATE INDEX fuel_market_rates_date_idx               ON fuel_market_rates (rate_date);
CREATE UNIQUE INDEX fuel_market_rates_uniq_per_day
    ON fuel_market_rates (tenant_id, rate_date, product, benchmark);

-- ============================================================================
-- RLS — same USING + WITH CHECK pattern the Sprint 3 migration established.
-- ============================================================================
DO $$
DECLARE
    t text;
    deal_tables text[] := ARRAY[
        'fuel_deals',
        'fuel_deal_cost_stack',
        'fuel_deal_cashflow_events',
        'fuel_deal_scenarios',
        'fuel_deal_counterparty_scores',
        'fuel_deal_documents',
        'fuel_market_rates'
    ];
BEGIN
    FOREACH t IN ARRAY deal_tables LOOP
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I '
            'USING (tenant_id = current_setting(''app.tenant_id'', true)) '
            'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))',
            t
        );
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;
END
$$;
