/**
 * Domain enums. Keep these as `const` objects so they're compatible with both
 * drizzle-orm pgEnum declarations (string tuple) and runtime checks.
 */

export const UserRole = {
  Owner: "owner",
  Admin: "admin",
  Member: "member",
  Viewer: "viewer",
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const OpportunityStage = {
  Lead: "lead",
  Qualified: "qualified",
  Proposal: "proposal",
  Negotiation: "negotiation",
  ClosedWon: "closed_won",
  ClosedLost: "closed_lost",
} as const;
export type OpportunityStage = (typeof OpportunityStage)[keyof typeof OpportunityStage];

export const ConversationChannel = {
  Email: "email",
  Voice: "voice",
  Chat: "chat",
  Sms: "sms",
} as const;
export type ConversationChannel = (typeof ConversationChannel)[keyof typeof ConversationChannel];

export const AgentStatus = {
  Queued: "queued",
  Running: "running",
  Succeeded: "succeeded",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;
export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];

export const IntegrationProvider = {
  Anthropic: "anthropic",
  OpenAI: "openai",
  Twilio: "twilio",
  Resend: "resend",
  Salesforce: "salesforce",
  Hubspot: "hubspot",
  Gmail: "gmail",
  Outlook: "outlook",
} as const;
export type IntegrationProvider =
  (typeof IntegrationProvider)[keyof typeof IntegrationProvider];
