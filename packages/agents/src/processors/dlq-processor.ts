import type { Job, Queue } from "bullmq";
import { metrics } from "@opentelemetry/api";
import { withTenant, type Db, type RawEventRepository } from "@vex/db";
import type { DlqJobData } from "../queues.js";

export interface DlqProcessorDeps {
  db: Db;
  rawEvents: RawEventRepository;
  /**
   * The DLQ Queue handle. Used to register an OpenTelemetry asynchronous
   * gauge that observes the current queue depth.
   */
  dlqQueue: Queue<DlqJobData>;
}

const meter = metrics.getMeter("vex.dlq", "0.0.0");

/**
 * Wire the OTel asynchronous gauge `vex.dlq.depth` to BullMQ's queue counts.
 * Call this once at worker startup. The gauge is updated whenever the OTel
 * exporter polls — typically every 60s.
 */
export function registerDlqDepthGauge(dlqQueue: Queue<DlqJobData>): void {
  const gauge = meter.createObservableGauge("vex.dlq.depth", {
    description: "Number of jobs sitting in the DLQ awaiting manual review.",
    unit: "{job}",
  });
  gauge.addCallback(async (result) => {
    const counts = await dlqQueue.getJobCounts(
      "waiting",
      "active",
      "delayed",
      "failed",
    );
    const total =
      (counts["waiting"] ?? 0) +
      (counts["active"] ?? 0) +
      (counts["delayed"] ?? 0) +
      (counts["failed"] ?? 0);
    result.observe(total);
  });
}

/**
 * DLQ-side processor. Records the failure to telemetry, marks the originating
 * raw_event as `failed`, and never re-throws — DLQ jobs are terminal until a
 * human runs the replay CLI.
 */
export function buildDlqProcessor(deps: DlqProcessorDeps) {
  registerDlqDepthGauge(deps.dlqQueue);

  return async function dlq(job: Job<DlqJobData>): Promise<void> {
    const data = job.data;
    // Structured log — this is the DLQ audit trail.
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        level: "error",
        msg: "raw_event normalization terminally failed",
        raw_event_id: data.raw_event_id,
        tenant_id: data.tenant_id,
        error: data.error,
        stack: data.stack,
        failed_at: data.failed_at,
      }),
    );

    if (!data.tenant_id) return;
    try {
      await withTenant(deps.db, data.tenant_id, async (tx) => {
        await deps.rawEvents.updateStatus(tx, data.raw_event_id, "failed");
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify({
          level: "error",
          msg: "dlq: failed to mark raw_event status",
          raw_event_id: data.raw_event_id,
          error: (err as Error).message,
        }),
      );
    }
  };
}
