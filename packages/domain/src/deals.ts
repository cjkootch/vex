/**
 * Fuel deal domain enums and unit helpers for Vector Trade Capital —
 * Houston bulk fuel trader operating in Caribbean and Latin American
 * markets.
 *
 * This module defines the `const` objects that the Drizzle pgEnum
 * declarations and the TS unions share, so the DB enum and the TS type
 * never drift. Nothing in here performs calculation — the calculation
 * engine lives elsewhere and is not part of this change set.
 */

// ---------------------------------------------------------------------------
// Deal identity & lifecycle
// ---------------------------------------------------------------------------

export const DealStatus = {
  Draft: "draft",
  Negotiating: "negotiating",
  PendingApproval: "pending_approval",
  Approved: "approved",
  Loading: "loading",
  InTransit: "in_transit",
  Delivered: "delivered",
  Settled: "settled",
  Cancelled: "cancelled",
  Failed: "failed",
} as const;
export type DealStatus = (typeof DealStatus)[keyof typeof DealStatus];

export const DealType = {
  Spot: "spot",
  Program: "program",
  Tender: "tender",
  SpotWithOption: "spot_with_option",
} as const;
export type DealType = (typeof DealType)[keyof typeof DealType];

// ---------------------------------------------------------------------------
// Product, routing, pricing
// ---------------------------------------------------------------------------

/**
 * Product codes — common fuel SKUs traded via VTC. `ulsd` is the workhorse
 * (Ultra Low Sulfur Diesel, 15 ppm S). `jet_a1` is the international jet
 * spec; `jet_a` is the US domestic variant (no anti-icing additive).
 */
export const ProductType = {
  Ulsd: "ulsd",
  Gasoline87: "gasoline_87",
  Gasoline91: "gasoline_91",
  JetA: "jet_a",
  JetA1: "jet_a1",
  Avgas: "avgas",
  Lfo: "lfo", // light fuel oil
  Hfo: "hfo", // heavy fuel oil / bunker
  Lng: "lng",
  Lpg: "lpg",
  BiodieselB20: "biodiesel_b20",
} as const;
export type ProductType = (typeof ProductType)[keyof typeof ProductType];

export const IncotermType = {
  Fob: "fob",
  Cif: "cif",
  Cfr: "cfr",
  Dap: "dap",
  Exw: "exw",
  Fas: "fas",
} as const;
export type IncotermType = (typeof IncotermType)[keyof typeof IncotermType];

export const PricingBasis = {
  Platts: "platts",
  Argus: "argus",
  Opis: "opis",
  NymexWti: "nymex_wti",
  NymexRbob: "nymex_rbob",
  IceBrent: "ice_brent",
  Fixed: "fixed",
  Negotiated: "negotiated",
} as const;
export type PricingBasis = (typeof PricingBasis)[keyof typeof PricingBasis];

// ---------------------------------------------------------------------------
// Settlement, currency, vessel
// ---------------------------------------------------------------------------

export const PaymentTermsType = {
  Prepayment100: "prepayment_100",
  Prepayment80_20: "prepayment_80_20",
  LcSight: "lc_sight",
  Lc60d: "lc_60d",
  Lc90d: "lc_90d",
  Lc120d: "lc_120d",
  Sblc: "sblc",
  OpenAccount: "open_account",
  TelegraphicTransfer: "telegraphic_transfer",
  Mixed: "mixed",
} as const;
export type PaymentTermsType = (typeof PaymentTermsType)[keyof typeof PaymentTermsType];

export const DealCurrency = {
  Usd: "usd",
  Eur: "eur",
  Cad: "cad",
  Jmd: "jmd",
  Ttd: "ttd",
  Dop: "dop",
  Bbd: "bbd",
  Xcd: "xcd",
} as const;
export type DealCurrency = (typeof DealCurrency)[keyof typeof DealCurrency];

export const VesselType = {
  TankerMr: "tanker_mr",
  TankerLr1: "tanker_lr1",
  TankerLr2: "tanker_lr2",
  TankerVlcc: "tanker_vlcc",
  Barge: "barge",
  CoastalTanker: "coastal_tanker",
  Isocontainer: "isocontainer",
  Flexitank: "flexitank",
} as const;
export type VesselType = (typeof VesselType)[keyof typeof VesselType];

export const FreightBasis = {
  PerUsg: "per_usg",
  LumpSum: "lump_sum",
  Worldscale: "worldscale",
  TimeCharterEq: "time_charter_eq",
} as const;
export type FreightBasis = (typeof FreightBasis)[keyof typeof FreightBasis];

// ---------------------------------------------------------------------------
// Compliance, scenarios, cashflow, documents, risk
// ---------------------------------------------------------------------------

export const OfacScreeningStatus = {
  NotStarted: "not_started",
  InProgress: "in_progress",
  Cleared: "cleared",
  Flagged: "flagged",
  Rejected: "rejected",
} as const;
export type OfacScreeningStatus =
  (typeof OfacScreeningStatus)[keyof typeof OfacScreeningStatus];

export const ScenarioType = {
  Base: "base",
  Conservative: "conservative",
  Aggressive: "aggressive",
  Stress: "stress",
  Custom: "custom",
} as const;
export type ScenarioType = (typeof ScenarioType)[keyof typeof ScenarioType];

export const CashflowDirection = {
  Inflow: "inflow",
  Outflow: "outflow",
} as const;
export type CashflowDirection =
  (typeof CashflowDirection)[keyof typeof CashflowDirection];

export const CashflowEventType = {
  BuyerPrepayment: "buyer_prepayment",
  BuyerFinalPayment: "buyer_final_payment",
  LcPayment: "lc_payment",
  ProductPurchase: "product_purchase",
  FreightPayment: "freight_payment",
  FreightDeposit: "freight_deposit",
  InsurancePremium: "insurance_premium",
  PortFees: "port_fees",
  ComplianceFees: "compliance_fees",
  BankFees: "bank_fees",
  IntermediaryFee: "intermediary_fee",
  StorageFees: "storage_fees",
  Demurrage: "demurrage",
  Overhead: "overhead",
  Custom: "custom",
} as const;
export type CashflowEventType =
  (typeof CashflowEventType)[keyof typeof CashflowEventType];

export const CashflowBaseType = {
  Revenue: "revenue",
  ProductCost: "product_cost",
  Freight: "freight",
  Insurance: "insurance",
  PortHandling: "port_handling",
  Compliance: "compliance",
  Finance: "finance",
  Overhead: "overhead",
  Custom: "custom",
} as const;
export type CashflowBaseType =
  (typeof CashflowBaseType)[keyof typeof CashflowBaseType];

export const DealDocumentType = {
  TermSheet: "term_sheet",
  Loi: "loi",
  Spa: "spa",
  Lc: "lc",
  Sblc: "sblc",
  Bl: "bl",
  Coa: "coa",
  Q88: "q88",
  InspectionReport: "inspection_report",
  OfacScreening: "ofac_screening",
  BisLicense: "bis_license",
  Eei: "eei",
  InsuranceCert: "insurance_cert",
  CustomsEntry: "customs_entry",
  Invoice: "invoice",
  PackingList: "packing_list",
  Sddr: "sddr",
  Other: "other",
} as const;
export type DealDocumentType =
  (typeof DealDocumentType)[keyof typeof DealDocumentType];

export const CounterpartyRiskTier = {
  Tier1: "tier_1",
  Tier2: "tier_2",
  Tier3: "tier_3",
  Watch: "watch",
  Declined: "declined",
} as const;
export type CounterpartyRiskTier =
  (typeof CounterpartyRiskTier)[keyof typeof CounterpartyRiskTier];

// ---------------------------------------------------------------------------
// Unit conversions (schema stores USG, MT, and BBL for quick aggregation)
// ---------------------------------------------------------------------------

/** US gallons per barrel (petroleum). */
export const USG_PER_BBL = 42;
/** Litres per US gallon. */
export const LITRES_PER_USG = 3.785411784;

/** Convert US gallons to metric tonnes using product density in kg/L. */
export function usgToMt(usg: number, densityKgL: number): number {
  return (usg * LITRES_PER_USG * densityKgL) / 1000;
}

/** Convert US gallons to barrels. */
export function usgToBbl(usg: number): number {
  return usg / USG_PER_BBL;
}
