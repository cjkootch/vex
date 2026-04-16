import type {
  ActivityRepository,
  ContactRepository,
  EventRepository,
  TouchpointRepository,
  Tx,
} from "@vex/db";

/**
 * Dependency surface that every normalizer needs. The transaction is passed
 * in by the caller (the BullMQ processor wraps each job in `withTenant`),
 * so the normalizer never sees the parent `Db` and can't escape RLS.
 */
export interface NormalizerDeps {
  tx: Tx;
  contacts: ContactRepository;
  touchpoints: TouchpointRepository;
  activities: ActivityRepository;
  events: EventRepository;
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
