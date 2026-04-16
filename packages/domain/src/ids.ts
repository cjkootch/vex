import { ulid } from "ulid";

/**
 * Branded ID types.
 *
 * IDs are ULIDs — 26-character Crockford base32, time-sortable. Branded
 * nominally so the compiler rejects accidental cross-type assignments
 * (e.g., passing a `UserId` where a `WorkspaceId` is expected). At runtime
 * these are plain strings.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type WorkspaceId = Brand<string, "WorkspaceId">;
export type TenantId = Brand<string, "TenantId">;
export type UserId = Brand<string, "UserId">;
export type OrganizationId = Brand<string, "OrganizationId">;
export type ContactId = Brand<string, "ContactId">;
export type LeadId = Brand<string, "LeadId">;
export type CampaignId = Brand<string, "CampaignId">;
export type TouchpointId = Brand<string, "TouchpointId">;
export type ThreadId = Brand<string, "ThreadId">;
export type MessageId = Brand<string, "MessageId">;
export type ActivityId = Brand<string, "ActivityId">;
export type DocumentId = Brand<string, "DocumentId">;
export type SummaryId = Brand<string, "SummaryId">;
export type RawEventId = Brand<string, "RawEventId">;
export type EventId = Brand<string, "EventId">;
export type EmbeddingChunkId = Brand<string, "EmbeddingChunkId">;
export type AgentRunId = Brand<string, "AgentRunId">;
export type ApprovalId = Brand<string, "ApprovalId">;
export type ViewManifestId = Brand<string, "ViewManifestId">;

// Crockford base32, excluding I, L, O, U.
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * True iff the given string is a valid ULID. Used by the branded ID
 * constructors and by input-validation code at the API boundary.
 */
export function isUlid(raw: string): boolean {
  return ULID_RE.test(raw);
}

/**
 * Generate a new ULID. All persisted IDs in Vex are ULIDs. Callers that
 * need a branded ID should cast via the corresponding constructor.
 */
export function createId(): string {
  return ulid();
}

function makeBrand<T extends string>(name: string) {
  return (raw: string): Brand<string, T> => {
    if (!isUlid(raw)) {
      throw new TypeError(`Invalid ${name}: expected ULID, got ${JSON.stringify(raw)}`);
    }
    return raw as Brand<string, T>;
  };
}

export const WorkspaceId = makeBrand<"WorkspaceId">("WorkspaceId");
export const TenantId = makeBrand<"TenantId">("TenantId");
export const UserId = makeBrand<"UserId">("UserId");
export const OrganizationId = makeBrand<"OrganizationId">("OrganizationId");
export const ContactId = makeBrand<"ContactId">("ContactId");
export const LeadId = makeBrand<"LeadId">("LeadId");
export const CampaignId = makeBrand<"CampaignId">("CampaignId");
export const TouchpointId = makeBrand<"TouchpointId">("TouchpointId");
export const ThreadId = makeBrand<"ThreadId">("ThreadId");
export const MessageId = makeBrand<"MessageId">("MessageId");
export const ActivityId = makeBrand<"ActivityId">("ActivityId");
export const DocumentId = makeBrand<"DocumentId">("DocumentId");
export const SummaryId = makeBrand<"SummaryId">("SummaryId");
export const RawEventId = makeBrand<"RawEventId">("RawEventId");
export const EventId = makeBrand<"EventId">("EventId");
export const EmbeddingChunkId = makeBrand<"EmbeddingChunkId">("EmbeddingChunkId");
export const AgentRunId = makeBrand<"AgentRunId">("AgentRunId");
export const ApprovalId = makeBrand<"ApprovalId">("ApprovalId");
export const ViewManifestId = makeBrand<"ViewManifestId">("ViewManifestId");
