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
  | {
      status: "ok";
      eventId: string;
      isNewEvent: boolean;
      /**
       * Lead the normalizer created or re-used. Present on outcomes
       * where a lead landed (website-chat, website-form). The downstream
       * BullMQ processor uses this to fan out follow-up agent work
       * (e.g. lead_qualification) without re-querying.
       */
      leadId?: string;
      /**
       * Touchpoint the normalizer wrote. Populated by EmailInboundNormalizer
       * so the processor can fan-out an `email_reply_draft` agent job keyed
       * off the specific inbound message.
       */
      touchpointId?: string;
    }
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
