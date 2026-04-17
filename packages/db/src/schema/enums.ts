import { pgEnum } from "drizzle-orm/pg-core";
import {
  AgentRunStatus,
  ApprovalDecision,
  CampaignStatus,
  CashflowBaseType,
  CashflowDirection,
  CashflowEventType,
  CounterpartyRiskTier,
  DealCurrency,
  DealDocumentType,
  DealStatus,
  DealType,
  FreightBasis,
  IncotermType,
  LeadStatus,
  MessageDirection,
  OfacScreeningStatus,
  PaymentTermsType,
  PricingBasis,
  ProductType,
  RawEventStatus,
  RecordStatus,
  ScenarioType,
  UserRole,
  VesselType,
  WorkspacePlan,
} from "@vex/domain";

/**
 * Postgres enum declarations. Values come from `@vex/domain` so the DB enum
 * and the TS union type never drift.
 */
export const workspacePlanEnum = pgEnum("workspace_plan", [
  WorkspacePlan.Free,
  WorkspacePlan.Essentials,
  WorkspacePlan.Pro,
]);

export const userRoleEnum = pgEnum("user_role", [
  UserRole.Owner,
  UserRole.Admin,
  UserRole.Member,
  UserRole.Viewer,
]);

export const recordStatusEnum = pgEnum("record_status", [
  RecordStatus.Active,
  RecordStatus.Inactive,
  RecordStatus.Archived,
]);

export const leadStatusEnum = pgEnum("lead_status", [
  LeadStatus.New,
  LeadStatus.Qualified,
  LeadStatus.Disqualified,
  LeadStatus.Won,
  LeadStatus.Lost,
]);

export const campaignStatusEnum = pgEnum("campaign_status", [
  CampaignStatus.Active,
  CampaignStatus.Paused,
  CampaignStatus.Completed,
  CampaignStatus.Archived,
]);

export const messageDirectionEnum = pgEnum("message_direction", [
  MessageDirection.Inbound,
  MessageDirection.Outbound,
]);

export const rawEventStatusEnum = pgEnum("raw_event_status", [
  RawEventStatus.Pending,
  RawEventStatus.Processed,
  RawEventStatus.Failed,
]);

export const agentRunStatusEnum = pgEnum("agent_run_status", [
  AgentRunStatus.Pending,
  AgentRunStatus.Running,
  AgentRunStatus.Completed,
  AgentRunStatus.Failed,
]);

export const approvalDecisionEnum = pgEnum("approval_decision", [
  ApprovalDecision.Pending,
  ApprovalDecision.Approved,
  ApprovalDecision.Rejected,
  ApprovalDecision.AutoApproved,
]);

// ============================================================================
// Fuel deal enums (Sprint 11)
// ============================================================================

export const dealStatusEnum = pgEnum("deal_status", [
  DealStatus.Draft,
  DealStatus.Negotiating,
  DealStatus.PendingApproval,
  DealStatus.Approved,
  DealStatus.Loading,
  DealStatus.InTransit,
  DealStatus.Delivered,
  DealStatus.Settled,
  DealStatus.Cancelled,
  DealStatus.Failed,
]);

export const dealTypeEnum = pgEnum("deal_type", [
  DealType.Spot,
  DealType.Program,
  DealType.Tender,
  DealType.SpotWithOption,
]);

export const productTypeEnum = pgEnum("product_type", [
  ProductType.Ulsd,
  ProductType.Gasoline87,
  ProductType.Gasoline91,
  ProductType.JetA,
  ProductType.JetA1,
  ProductType.Avgas,
  ProductType.Lfo,
  ProductType.Hfo,
  ProductType.Lng,
  ProductType.Lpg,
  ProductType.BiodieselB20,
]);

export const incotermEnum = pgEnum("incoterm", [
  IncotermType.Fob,
  IncotermType.Cif,
  IncotermType.Cfr,
  IncotermType.Dap,
  IncotermType.Exw,
  IncotermType.Fas,
]);

export const pricingBasisEnum = pgEnum("pricing_basis", [
  PricingBasis.Platts,
  PricingBasis.Argus,
  PricingBasis.Opis,
  PricingBasis.NymexWti,
  PricingBasis.NymexRbob,
  PricingBasis.IceBrent,
  PricingBasis.Fixed,
  PricingBasis.Negotiated,
]);

export const paymentTermsEnum = pgEnum("payment_terms", [
  PaymentTermsType.Prepayment100,
  PaymentTermsType.Prepayment80_20,
  PaymentTermsType.LcSight,
  PaymentTermsType.Lc60d,
  PaymentTermsType.Lc90d,
  PaymentTermsType.Lc120d,
  PaymentTermsType.Sblc,
  PaymentTermsType.OpenAccount,
  PaymentTermsType.TelegraphicTransfer,
  PaymentTermsType.Mixed,
]);

export const dealCurrencyEnum = pgEnum("deal_currency", [
  DealCurrency.Usd,
  DealCurrency.Eur,
  DealCurrency.Cad,
  DealCurrency.Jmd,
  DealCurrency.Ttd,
  DealCurrency.Dop,
  DealCurrency.Bbd,
  DealCurrency.Xcd,
]);

export const vesselTypeEnum = pgEnum("vessel_type", [
  VesselType.TankerMr,
  VesselType.TankerLr1,
  VesselType.TankerLr2,
  VesselType.TankerVlcc,
  VesselType.Barge,
  VesselType.CoastalTanker,
  VesselType.Isocontainer,
  VesselType.Flexitank,
]);

export const freightBasisEnum = pgEnum("freight_basis", [
  FreightBasis.PerUsg,
  FreightBasis.LumpSum,
  FreightBasis.Worldscale,
  FreightBasis.TimeCharterEq,
]);

export const ofacScreeningStatusEnum = pgEnum("ofac_screening_status", [
  OfacScreeningStatus.NotStarted,
  OfacScreeningStatus.InProgress,
  OfacScreeningStatus.Cleared,
  OfacScreeningStatus.Flagged,
  OfacScreeningStatus.Rejected,
]);

export const scenarioTypeEnum = pgEnum("scenario_type", [
  ScenarioType.Base,
  ScenarioType.Conservative,
  ScenarioType.Aggressive,
  ScenarioType.Stress,
  ScenarioType.Custom,
]);

export const cashflowDirectionEnum = pgEnum("cashflow_direction", [
  CashflowDirection.Inflow,
  CashflowDirection.Outflow,
]);

export const cashflowEventTypeEnum = pgEnum("cashflow_event_type", [
  CashflowEventType.BuyerPrepayment,
  CashflowEventType.BuyerFinalPayment,
  CashflowEventType.LcPayment,
  CashflowEventType.ProductPurchase,
  CashflowEventType.FreightPayment,
  CashflowEventType.FreightDeposit,
  CashflowEventType.InsurancePremium,
  CashflowEventType.PortFees,
  CashflowEventType.ComplianceFees,
  CashflowEventType.BankFees,
  CashflowEventType.IntermediaryFee,
  CashflowEventType.StorageFees,
  CashflowEventType.Demurrage,
  CashflowEventType.Overhead,
  CashflowEventType.Custom,
]);

export const cashflowBaseTypeEnum = pgEnum("cashflow_base_type", [
  CashflowBaseType.Revenue,
  CashflowBaseType.ProductCost,
  CashflowBaseType.Freight,
  CashflowBaseType.Insurance,
  CashflowBaseType.PortHandling,
  CashflowBaseType.Compliance,
  CashflowBaseType.Finance,
  CashflowBaseType.Overhead,
  CashflowBaseType.Custom,
]);

export const dealDocumentTypeEnum = pgEnum("deal_document_type", [
  DealDocumentType.TermSheet,
  DealDocumentType.Loi,
  DealDocumentType.Spa,
  DealDocumentType.Lc,
  DealDocumentType.Sblc,
  DealDocumentType.Bl,
  DealDocumentType.Coa,
  DealDocumentType.Q88,
  DealDocumentType.InspectionReport,
  DealDocumentType.OfacScreening,
  DealDocumentType.BisLicense,
  DealDocumentType.Eei,
  DealDocumentType.InsuranceCert,
  DealDocumentType.CustomsEntry,
  DealDocumentType.Invoice,
  DealDocumentType.PackingList,
  DealDocumentType.Sddr,
  DealDocumentType.Other,
]);

export const counterpartyRiskTierEnum = pgEnum("counterparty_risk_tier", [
  CounterpartyRiskTier.Tier1,
  CounterpartyRiskTier.Tier2,
  CounterpartyRiskTier.Tier3,
  CounterpartyRiskTier.Watch,
  CounterpartyRiskTier.Declined,
]);
