import { defineSignal } from "@temporalio/workflow";

/** Sent by `apps/api` when a reviewer decides on an approval. */
export interface ApprovalDecisionSignal {
  approvalId: string;
  decision: "approved" | "rejected";
  reviewerId: string;
  reason?: string;
}

export const approvalDecisionSignal = defineSignal<[ApprovalDecisionSignal]>(
  "approval.decision",
);

// ---------------------------------------------------------------------------
// Sprint 12 — outbound-call lifecycle signals
// ---------------------------------------------------------------------------

/**
 * Emitted by the Twilio status-callback webhook every time Twilio tells
 * us the call moved state. Values map to Twilio's call lifecycle;
 * `durationSeconds` is populated on terminal events only.
 */
export interface CallStatusSignal {
  callSid: string;
  status:
    | "initiated"
    | "ringing"
    | "in-progress"
    | "answered"
    | "completed"
    | "busy"
    | "failed"
    | "no-answer"
    | "canceled";
  durationSeconds?: number;
  /** ISO timestamp Twilio reported the transition at (webhook `Timestamp`). */
  at: string;
}

export const callStatusSignal = defineSignal<[CallStatusSignal]>(
  "call.status.update",
);

/**
 * Emitted by the Twilio recording-status-callback webhook when a
 * recording finishes. The webhook handler downloads the audio, uploads
 * to S3, and surfaces the resulting storage key here; the workflow
 * never sees the raw Twilio URL — matches the invariant that no
 * provider URL is the canonical reference.
 */
export interface CallRecordingSignal {
  callSid: string;
  recordingSid: string;
  /** S3 object key the handler wrote the audio to. */
  storageKey: string;
  durationSeconds: number;
  /** Optional transcript text if the webhook fronted a transcription step. */
  transcriptText?: string;
}

export const callRecordingSignal = defineSignal<[CallRecordingSignal]>(
  "call.recording.available",
);

// ---------------------------------------------------------------------------
// Sprint D — campaign enrollment signals
// ---------------------------------------------------------------------------

/**
 * Operator action — pause or resume a recipient mid-plan without
 * unenrolling them. Paused enrollments halt at the next step gate.
 */
export interface EnrollmentControlSignal {
  action: "pause" | "resume" | "unsubscribe";
  /** Free-form note appended to branch_history so the reason survives. */
  note?: string;
}

export const enrollmentControlSignal = defineSignal<[EnrollmentControlSignal]>(
  "enrollment.control",
);

/**
 * Surfaced by the ResendNormalizer + TwilioNormalizer when an inbound
 * touchpoint lands on the enrolled contact. The workflow forwards
 * this into its gate evaluation cache so `opened_in_last_days` etc.
 * can see fresh events without a DB re-read.
 */
export interface EnrollmentTouchpointSignal {
  kind:
    | "email_open"
    | "email_click"
    | "email_bounce"
    | "inbound_reply"
    | "intent_classified";
  /** ISO timestamp. */
  occurredAt: string;
  /** For `intent_classified`: the classifier's label. */
  intent?: string;
}

export const enrollmentTouchpointSignal = defineSignal<[EnrollmentTouchpointSignal]>(
  "enrollment.touchpoint",
);
