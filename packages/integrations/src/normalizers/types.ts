import type {
  ActivityRepository,
  ContactRepository,
  EventRepository,
  TouchpointRepository,
} from "@vex/db";

/**
 * Dependency surface that every normalizer needs. Passed in rather than
 * imported so processors can wire test fakes.
 */
export interface NormalizerDeps {
  contacts: ContactRepository;
  touchpoints: TouchpointRepository;
  activities: ActivityRepository;
  events: EventRepository;
}

/**
 * Outcome of a normalization run. Captures the canonical event id (or marks
 * skip) so the caller can update the originating raw_event row.
 */
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
