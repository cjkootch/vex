export { createDb, type Db, type Tx } from "./client.js";
export { withTenant, type TenantScopedDb } from "./with-tenant.js";
export { pingDb } from "./health.js";
export * as schema from "./schema/index.js";
export { resolveFieldValue, type FieldConfidenceEntry } from "./merge.js";
export {
  createNextMonthPartitions,
  monthPartitionBounds,
  nextMonth,
  type DirectSqlClient,
} from "./partitions.js";
export * from "./repositories/index.js";
export * from "./retrieval/index.js";

// Row-type aliases — convenience for callers (services, agents) that
// pass DB rows around without depending on the full schema namespace.
export type {
  Approval,
  NewApproval,
} from "./schema/approvals.js";
export type {
  AgentRun,
  NewAgentRun,
} from "./schema/agent-runs.js";
export type {
  Workspace,
  NewWorkspace,
  WorkspaceSettings,
  WorkspaceStrategy,
} from "./schema/workspaces.js";
export type { Thread, NewThread } from "./schema/threads.js";
export type { Lead, NewLead } from "./schema/leads.js";
export type {
  Organization,
  NewOrganization,
  ExternalKeys,
  FieldConfidenceMap,
} from "./schema/organizations.js";
export type { Contact, NewContact } from "./schema/contacts.js";
export type {
  ContactOrgMembership,
  NewContactOrgMembership,
} from "./schema/contact-org-memberships.js";
export type { Touchpoint, NewTouchpoint } from "./schema/touchpoints.js";
export type { Campaign, NewCampaign } from "./schema/campaigns.js";
export type { Activity, NewActivity } from "./schema/activities.js";
export type { Event, NewEvent } from "./schema/events.js";
export type { RawEvent, NewRawEvent } from "./schema/raw-events.js";
export type { Summary, NewSummary } from "./schema/summaries.js";
export type {
  OfacScreen,
  NewOfacScreen,
  OfacMatchRecord,
} from "./schema/ofac-screens.js";
export type { Vessel, NewVessel } from "./schema/vessels.js";
export type { FreightRate, NewFreightRate } from "./schema/freight-rates.js";
export type { VesselClass } from "./schema/enums.js";
export type {
  EmbeddingChunk,
  NewEmbeddingChunk,
} from "./schema/embedding-chunks.js";
export type { FuelDeal, NewFuelDeal } from "./schema/fuel-deals.js";
export type {
  FuelDealScenario,
  NewFuelDealScenario,
} from "./schema/fuel-deal-scenarios.js";
export type {
  FuelDealCounterpartyScore,
  NewFuelDealCounterpartyScore,
} from "./schema/fuel-deal-counterparty-scores.js";
export type {
  FuelMarketRate,
  NewFuelMarketRate,
} from "./schema/fuel-market-rates.js";
export {
  calculateBreakevens,
  calculateDealScore,
  calculateFuelDeal,
  calculateInsuranceCosts,
  calculateTotals,
  calculateUnitEconomics,
  calculateVesselEconomics,
  calculateWarnings,
  DealRecommendation,
  DealWarningSeverity,
  type BreakevenAnalysis,
  type DealComplianceState,
  type DealScorecard,
  type DealThresholds,
  type DealTotals,
  type DealWarning,
  type FuelDealInputs,
  type FuelDealResults,
  type InsuranceCosts,
  type PerUsgEconomics,
  type TradeFinanceInputs,
  type VesselEconomics,
  type VesselInputs,
} from "./deals/calculator.js";
