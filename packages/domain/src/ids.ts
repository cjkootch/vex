/**
 * Branded ID types.
 *
 * Each entity gets a nominally-typed string so the compiler rejects accidental
 * cross-type assignments (e.g., passing a `UserId` where a `TenantId` is
 * expected). At runtime these are plain strings.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type TenantId = Brand<string, "TenantId">;
export type UserId = Brand<string, "UserId">;
export type AccountId = Brand<string, "AccountId">;
export type ContactId = Brand<string, "ContactId">;
export type OpportunityId = Brand<string, "OpportunityId">;
export type ConversationId = Brand<string, "ConversationId">;
export type MessageId = Brand<string, "MessageId">;
export type CallId = Brand<string, "CallId">;
export type ApprovalId = Brand<string, "ApprovalId">;
export type AgentRunId = Brand<string, "AgentRunId">;
export type ViewManifestId = Brand<string, "ViewManifestId">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeBrand<T extends string>(name: string) {
  return (raw: string): Brand<string, T> => {
    if (!UUID_RE.test(raw)) {
      throw new TypeError(`Invalid ${name}: expected UUID, got ${JSON.stringify(raw)}`);
    }
    return raw as Brand<string, T>;
  };
}

export const TenantId = makeBrand<"TenantId">("TenantId");
export const UserId = makeBrand<"UserId">("UserId");
export const AccountId = makeBrand<"AccountId">("AccountId");
export const ContactId = makeBrand<"ContactId">("ContactId");
export const OpportunityId = makeBrand<"OpportunityId">("OpportunityId");
export const ConversationId = makeBrand<"ConversationId">("ConversationId");
export const MessageId = makeBrand<"MessageId">("MessageId");
export const CallId = makeBrand<"CallId">("CallId");
export const ApprovalId = makeBrand<"ApprovalId">("ApprovalId");
export const AgentRunId = makeBrand<"AgentRunId">("AgentRunId");
export const ViewManifestId = makeBrand<"ViewManifestId">("ViewManifestId");
