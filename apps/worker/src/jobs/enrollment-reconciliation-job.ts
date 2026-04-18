import type { Client as TemporalClient } from "@temporalio/client";
import {
  withTenant,
  type CampaignEnrollmentRepository,
  type Db,
  type EventRepository,
} from "@vex/db";
import { TEMPORAL_TASK_QUEUE, WorkflowId } from "@vex/integrations";
import { createLogger, withSpan } from "@vex/telemetry";

const log = createLogger("worker.enrollment-reconciliation");

export interface EnrollmentReconciliationDeps {
  db: Db;
  enrollments: CampaignEnrollmentRepository;
  events: EventRepository;
  temporal: TemporalClient | null;
  /** Clock override for tests. */
  now?: () => Date;
}

export interface EnrollmentReconciliationInput {
  tenantId: string;
  /** How stale must an enrollment be before we consider it orphaned.
   *  Default 30 minutes — long enough to outlast a normal workflow
   *  startup, short enough to catch a botched enroll within the hour. */
  staleMinutes?: number;
  /** Max enrollments to reconcile per tick. Default 50 — keeps the
   *  Temporal describe calls bounded. */
  maxBatch?: number;
}

export interface EnrollmentReconciliationResult {
  scanned: number;
  /** Enrollments that already had a running workflow — no action. */
  healthy: number;
  /** Enrollments whose workflow was missing; we started a fresh one. */
  restarted: number;
  /** Describe / start failures, logged for investigation. */
  failures: number;
}

const DEFAULT_STALE_MINUTES = 30;
const DEFAULT_MAX_BATCH = 50;

/**
 * Orphaned-enrollment reconciliation tick. Finds enrollments stuck
 * in `state=enrolled` that haven't advanced in a while, checks
 * whether Temporal has a workflow for them, and restarts when
 * missing.
 *
 * Restart is safe because:
 *   - WorkflowId.campaignEnrollment is deterministic, so a duplicate
 *     start against a running workflow gets rejected cleanly
 *     (WorkflowExecutionAlreadyStarted — we treat it as "healthy").
 *   - CampaignEnrollmentWorkflow's first activity reloads state from
 *     the DB; it picks up at current_step, not step 0.
 *   - Signals from the intent classifier are re-deliverable — a
 *     restart doesn't miss them permanently.
 *
 * No Temporal client → tick returns all zeros without touching the
 * DB. Nothing to reconcile against.
 */
export async function runEnrollmentReconciliationTick(
  deps: EnrollmentReconciliationDeps,
  input: EnrollmentReconciliationInput,
): Promise<EnrollmentReconciliationResult> {
  return withSpan(
    "worker.enrollment_reconciliation.tick",
    { tenant_id: input.tenantId },
    async () => {
      if (!deps.temporal) {
        return { scanned: 0, healthy: 0, restarted: 0, failures: 0 };
      }
      const clock = deps.now ?? (() => new Date());
      const staleMinutes = input.staleMinutes ?? DEFAULT_STALE_MINUTES;
      const maxBatch = input.maxBatch ?? DEFAULT_MAX_BATCH;
      const cutoff = new Date(clock().getTime() - staleMinutes * 60_000);

      const candidates = await withTenant(
        deps.db,
        input.tenantId,
        async (tx) => deps.enrollments.listStaleEnrolled(tx, cutoff, maxBatch),
      );

      let healthy = 0;
      let restarted = 0;
      let failures = 0;

      for (const enrollment of candidates) {
        const workflowId = WorkflowId.campaignEnrollment(enrollment.id);
        const handle = deps.temporal.workflow.getHandle(workflowId);
        // describe() returns metadata when the workflow exists.
        // A NotFound error means we need to start it.
        let running = false;
        try {
          await handle.describe();
          running = true;
        } catch (err) {
          const message = (err as Error).message ?? "";
          if (!/not\s*found/i.test(message)) {
            failures += 1;
            log.warn("reconciler: describe failed unexpectedly", {
              workflow_id: workflowId,
              error: message,
            });
            continue;
          }
          running = false;
        }

        if (running) {
          healthy += 1;
          continue;
        }

        try {
          await deps.temporal.workflow.start("campaignEnrollmentWorkflow", {
            taskQueue: TEMPORAL_TASK_QUEUE,
            workflowId,
            args: [
              { tenantId: enrollment.tenantId, enrollmentId: enrollment.id },
            ],
          });
          restarted += 1;
          await withTenant(deps.db, input.tenantId, async (tx) => {
            await deps.events.insertIfNotExists(tx, input.tenantId, {
              verb: "campaign.enrollment_workflow_restarted",
              subjectType: "campaign_enrollment",
              subjectId: enrollment.id,
              actorType: "system",
              actorId: "enrollment_reconciler",
              objectType: "campaign_enrollment",
              objectId: enrollment.id,
              occurredAt: clock(),
              idempotencyKey: `campaign.enrollment_workflow_restarted:${enrollment.id}:${clock().toISOString().slice(0, 13)}`,
              metadata: {
                enrollment_id: enrollment.id,
                campaign_id: enrollment.campaignId,
                workflow_id: workflowId,
                cutoff: cutoff.toISOString(),
              },
            });
          });
        } catch (err) {
          const message = (err as Error).message ?? "";
          if (/already/i.test(message)) {
            // Race condition — another ticker or the API beat us to it.
            // Count as healthy.
            healthy += 1;
            continue;
          }
          failures += 1;
          log.warn("reconciler: start failed", {
            workflow_id: workflowId,
            error: message,
          });
        }
      }

      return {
        scanned: candidates.length,
        healthy,
        restarted,
        failures,
      };
    },
  );
}
