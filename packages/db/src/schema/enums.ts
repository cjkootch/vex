import { pgEnum } from "drizzle-orm/pg-core";
import {
  AgentRunStatus,
  ApprovalDecision,
  CampaignStatus,
  LeadStatus,
  MessageDirection,
  RawEventStatus,
  RecordStatus,
  UserRole,
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
