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

/**
 * Dispatch channel for a campaign step. `manual` is the escape hatch
 * for steps that need a human to take an off-platform action
 * ("book the demo") — the executor still lands a touchpoint but the
 * actual send is a no-op. One row per step; see campaign_steps.
 */
export const CampaignChannel = {
  Email: "email",
  Sms: "sms",
  Whatsapp: "whatsapp",
  Voice: "voice",
  Manual: "manual",
} as const;
export type CampaignChannel =
  (typeof CampaignChannel)[keyof typeof CampaignChannel];

/**
 * Lifecycle state for a contact's enrollment in a campaign plan.
 *   - `enrolled` is the active state — the workflow is currently
 *     advancing through steps.
 *   - `paused` halts step advancement without unenrolling.
 *   - `completed` is reached when the recipient runs off the end of
 *     the plan or the workflow hits a terminal branch.
 *   - `unsubscribed` is a permanent opt-out, set when the inbound
 *     intent classifier flags an unsubscribe signal.
 *   - `errored` is a terminal state for unrecoverable execution
 *     failures — ops has to re-enroll to retry.
 */
export const EnrollmentState = {
  Enrolled: "enrolled",
  Paused: "paused",
  Completed: "completed",
  Unsubscribed: "unsubscribed",
  Errored: "errored",
} as const;
export type EnrollmentState =
  (typeof EnrollmentState)[keyof typeof EnrollmentState];

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
