import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  dealCurrencyEnum,
  dealStatusEnum,
  dealTypeEnum,
  incotermEnum,
  ofacScreeningStatusEnum,
  paymentTermsEnum,
  pricingBasisEnum,
  productTypeEnum,
} from "./enums.js";
import { organizations } from "./organizations.js";
import { contacts } from "./contacts.js";
import { vessels } from "./vessels.js";
import { ports } from "./ports.js";
import { leads } from "./leads.js";
import { campaigns } from "./campaigns.js";
import { users } from "./users.js";

/**
 * Fuel deal record — one row per negotiated transaction. The cost stack,
 * cashflow events, scenarios, and documents all hang off `fuel_deals.id`.
 *
 * Per invariant: no raw provider payloads live on this table. The external
 * reference fields (`bis_license_number`, `eei_itn`) are regulator-issued
 * identifiers, not counterparty payloads.
 */
export const fuelDeals = pgTable(
  "fuel_deals",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    dealRef: text("deal_ref").notNull(),
    status: dealStatusEnum("status").notNull().default("draft"),
    dealType: dealTypeEnum("deal_type").notNull().default("spot"),
    /**
     * Cadence. Migrated in 0016_deal_frequency as a plain text column
     * (not an enum) so operators can add new rhythms without a schema
     * bump. Allowed values: one_off, weekly, biweekly, monthly, custom.
     * When `custom`, `dealFrequencyIntervalDays` carries the cadence.
     */
    dealFrequency: text("deal_frequency").notNull().default("one_off"),
    dealFrequencyIntervalDays: integer("deal_frequency_interval_days"),
    dealFrequencyNotes: text("deal_frequency_notes"),
    product: productTypeEnum("product").notNull(),
    productGrade: text("product_grade"),
    productSpecNotes: text("product_spec_notes"),

    originCountry: text("origin_country"),
    originPort: text("origin_port"),
    originTerminal: text("origin_terminal"),
    destinationCountry: text("destination_country"),
    destinationPort: text("destination_port"),
    destinationTerminal: text("destination_terminal"),

    incoterm: incotermEnum("incoterm").notNull(),
    pricingBasis: pricingBasisEnum("pricing_basis").notNull(),
    pricingFormula: text("pricing_formula"),
    priceLockDate: date("price_lock_date"),
    priceLockTime: text("price_lock_time"),

    volumeUsg: doublePrecision("volume_usg").notNull(),
    volumeMt: doublePrecision("volume_mt"),
    volumeBbls: doublePrecision("volume_bbls"),
    /**
     * Fuel-specific. Nullable after 0011_food_line_of_business —
     * food deals (line_of_business='food') have no density.
     */
    densityKgL: doublePrecision("density_kg_l"),
    volumeTolerancePct: doublePrecision("volume_tolerance_pct").notNull().default(0),
    /**
     * Sprint V — discriminator. 'fuel' (default, legacy behaviour) or
     * 'food' (rice, beans, pork, chicken, cooking oil, powdered milk).
     */
    lineOfBusiness: text("line_of_business").notNull().default("fuel"),
    /** Unit the `volume_usg` column is denominated in for this row. */
    volumeUnit: text("volume_unit").notNull().default("usg"),
    /**
     * Food-specific. Suppliers of pork / chicken / processed goods
     * typically need 3–6 weeks between PO and shipment; the rule
     * engine can fire a signal if a deal is near laycan without any
     * production milestone events.
     */
    productionLeadTimeWeeks: integer("production_lead_time_weeks"),
    /** Pork, chicken, and some dairy need reefer containers. */
    coldChainRequired: boolean("cold_chain_required").notNull().default(false),

    currency: dealCurrencyEnum("currency").notNull().default("usd"),
    fxRateToUsd: doublePrecision("fx_rate_to_usd").notNull().default(1),
    fxHedgeInPlace: boolean("fx_hedge_in_place").notNull().default(false),
    fxHedgeRate: doublePrecision("fx_hedge_rate"),
    fxHedgeInstrument: text("fx_hedge_instrument"),
    fxHedgeExpiry: date("fx_hedge_expiry"),

    buyerOrgId: text("buyer_org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    buyerContactId: text("buyer_contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    sellerOrgId: text("seller_org_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    intermediaryOrgId: text("intermediary_org_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    intermediaryRole: text("intermediary_role"),
    // Sprint W — two-sided brokers. Deals sometimes have a broker
    // on the buy side AND the sell side, each with their own
    // commission + payment terms. `intermediaryOrgId` stays for
    // back-compat; new deals populate these explicit slots.
    buySideBrokerOrgId: text("buy_side_broker_org_id").references(
      () => organizations.id,
      { onDelete: "set null" },
    ),
    buySideBrokerCommissionPct: doublePrecision(
      "buy_side_broker_commission_pct",
    ),
    buySideBrokerPaymentTerms: text("buy_side_broker_payment_terms"),
    sellSideBrokerOrgId: text("sell_side_broker_org_id").references(
      () => organizations.id,
      { onDelete: "set null" },
    ),
    sellSideBrokerCommissionPct: doublePrecision(
      "sell_side_broker_commission_pct",
    ),
    sellSideBrokerPaymentTerms: text("sell_side_broker_payment_terms"),

    leadId: text("lead_id").references(() => leads.id, { onDelete: "set null" }),
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),

    laycanStart: date("laycan_start"),
    laycanEnd: date("laycan_end"),
    blDateEstimated: date("bl_date_estimated"),
    blDateActual: date("bl_date_actual"),
    etaDestination: date("eta_destination"),
    etaActual: date("eta_actual"),

    paymentTerms: paymentTermsEnum("payment_terms").notNull(),
    lcIssuingBank: text("lc_issuing_bank"),
    lcConfirmingBank: text("lc_confirming_bank"),
    lcValueUsd: doublePrecision("lc_value_usd"),
    lcExpiryDate: date("lc_expiry_date"),
    lcMarginPct: doublePrecision("lc_margin_pct"),
    sblcValueUsd: doublePrecision("sblc_value_usd"),

    tradeFinanceCostPct: doublePrecision("trade_finance_cost_pct").notNull().default(0),

    ofacScreeningStatus: ofacScreeningStatusEnum("ofac_screening_status")
      .notNull()
      .default("not_started"),
    bisLicenseRequired: boolean("bis_license_required").notNull().default(false),
    bisLicenseNumber: text("bis_license_number"),
    bisLicenseExpiry: date("bis_license_expiry"),
    eeiFilingRequired: boolean("eei_filing_required").notNull().default(false),
    eeiItn: text("eei_itn"),
    complianceHold: boolean("compliance_hold").notNull().default(false),
    complianceNotes: text("compliance_notes"),

    counterpartyRiskScore: doublePrecision("counterparty_risk_score"),
    countryRiskScore: doublePrecision("country_risk_score"),
    politicalRiskInsured: boolean("political_risk_insured").notNull().default(false),

    /**
     * Vessel intelligence (0019_vessels). Each fuel deal can pin to a
     * physical hull and carry the freight terms actually booked. The
     * lock-time market rate gives the evaluator the delta between
     * what we paid and what the spot looked like at lock — surfaces
     * good (or bad) timing inside the calculator's freight line.
     */
    vesselId: text("vessel_id").references(() => vessels.id, {
      onDelete: "set null",
    }),
    vesselUtilizationPct: doublePrecision("vessel_utilization_pct"),
    freightRateUsdPerMt: doublePrecision("freight_rate_usd_per_mt"),
    freightRateLockedAt: timestamp("freight_rate_locked_at", {
      withTimezone: true,
    }),
    freightRateSource: text("freight_rate_source"),
    freightMarketRateAtLock: doublePrecision("freight_market_rate_at_lock"),
    demurrageRateUsdPerDay: doublePrecision("demurrage_rate_usd_per_day"),
    ballastBonusUsd: doublePrecision("ballast_bonus_usd"),
    /** "voyage" | "time" | "spot". Text — CP terminology varies. */
    charterType: text("charter_type"),

    /**
     * Port intelligence (0020_ports). ULID-linked origin + destination
     * ports. Coexist with the legacy text `originPort` / `destinationPort`
     * columns so the migration from free-text strings can roll forward
     * gradually.
     */
    originPortId: text("origin_port_id").references(() => ports.id, {
      onDelete: "set null",
    }),
    destinationPortId: text("destination_port_id").references(() => ports.id, {
      onDelete: "set null",
    }),

    notes: text("notes"),
    internalNotes: text("internal_notes"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("fuel_deals_tenant_idx").on(t.tenantId),
    statusIdx: index("fuel_deals_status_idx").on(t.status),
    buyerIdx: index("fuel_deals_buyer_idx").on(t.buyerOrgId),
    productIdx: index("fuel_deals_product_idx").on(t.product),
    laycanIdx: index("fuel_deals_laycan_idx").on(t.laycanStart),
    createdAtIdx: index("fuel_deals_created_at_idx").on(t.createdAt),
    dealRefIdx: index("fuel_deals_deal_ref_idx").on(t.tenantId, t.dealRef),
    vesselIdx: index("fuel_deals_vessel_idx").on(t.vesselId),
    originPortIdx: index("fuel_deals_origin_port_idx").on(t.originPortId),
    destinationPortIdx: index("fuel_deals_destination_port_idx").on(
      t.destinationPortId,
    ),
  }),
);

export type FuelDeal = typeof fuelDeals.$inferSelect;
export type NewFuelDeal = typeof fuelDeals.$inferInsert;
