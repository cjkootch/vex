import type {
  ActivityRepository,
  ContactOrgMembershipRepository,
  ContactRepository,
  DocumentRepository,
  EventRepository,
  LeadRepository,
  OrganizationRepository,
  TouchpointRepository,
  Tx,
} from "@vex/db";

/**
 * Dependency surface that every normalizer needs. The transaction is passed
 * in by the caller (the BullMQ processor wraps each job in `withTenant`),
 * so the normalizer never sees the parent `Db` and can't escape RLS.
 *
 * `organizations`, `memberships`, `leads`, and `documents` are optional
 * because the older Resend/Twilio normalizers don't need them; the
 * website-chat normalizer does. Accessing a missing dep throws a clear
 * error at call time rather than passing the check for undefined
 * through to Postgres.
 */
export interface NormalizerDeps {
  tx: Tx;
  contacts: ContactRepository;
  touchpoints: TouchpointRepository;
  activities: ActivityRepository;
  events: EventRepository;
  organizations?: OrganizationRepository;
  memberships?: ContactOrgMembershipRepository;
  leads?: LeadRepository;
  documents?: DocumentRepository;
}

/** Outcome of a single normalization run. */
export type NormalizerOutcome =
  | { status: "ok"; eventId: string; isNewEvent: boolean }
  | { status: "skipped"; reason: string };

export interface RawEventInput {
  id: string;
  tenantId: string;
  provider: string;
  providerEventId: string;
  receivedAt: Date;
  headers: Record<string, unknown>;
  payload: Record<string, unknown>;
}
