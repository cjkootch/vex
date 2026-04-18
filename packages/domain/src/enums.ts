/**
 * Domain enums. Keep these as `const` objects so they're compatible with both
 * drizzle-orm pgEnum declarations (string tuple) and runtime checks.
 */

export const WorkspacePlan = {
  Free: "free",
  Essentials: "essentials",
  Pro: "pro",
} as const;
export type WorkspacePlan = (typeof WorkspacePlan)[keyof typeof WorkspacePlan];

export const UserRole = {
  Owner: "owner",
  Admin: "admin",
  Member: "member",
  Viewer: "viewer",
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const RecordStatus = {
  Active: "active",
  Inactive: "inactive",
  Archived: "archived",
} as const;
export type RecordStatus = (typeof RecordStatus)[keyof typeof RecordStatus];

export const LeadStatus = {
  New: "new",
  Qualified: "qualified",
  Disqualified: "disqualified",
  Won: "won",
  Lost: "lost",
} as const;
export type LeadStatus = (typeof LeadStatus)[keyof typeof LeadStatus];

export const CampaignStatus = {
  Active: "active",
  Paused: "paused",
  Completed: "completed",
  Archived: "archived",
} as const;
export type CampaignStatus = (typeof CampaignStatus)[keyof typeof CampaignStatus];

export const MessageDirection = {
  Inbound: "inbound",
  Outbound: "outbound",
} as const;
export type MessageDirection = (typeof MessageDirection)[keyof typeof MessageDirection];

export const RawEventStatus = {
  Pending: "pending",
  Processed: "processed",
  Failed: "failed",
} as const;
export type RawEventStatus = (typeof RawEventStatus)[keyof typeof RawEventStatus];

export const AgentRunStatus = {
  Pending: "pending",
  Running: "running",
  Completed: "completed",
  Failed: "failed",
} as const;
export type AgentRunStatus = (typeof AgentRunStatus)[keyof typeof AgentRunStatus];

export const IntegrationProvider = {
  Anthropic: "anthropic",
  OpenAI: "openai",
  Twilio: "twilio",
  Resend: "resend",
  Salesforce: "salesforce",
  Hubspot: "hubspot",
  Gmail: "gmail",
  Outlook: "outlook",
  Apollo: "apollo",
  Ga4: "ga4",
  Internal: "internal",
} as const;
export type IntegrationProvider =
  (typeof IntegrationProvider)[keyof typeof IntegrationProvider];
