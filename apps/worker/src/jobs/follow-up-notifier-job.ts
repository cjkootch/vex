import {
  withTenant,
  type Db,
  type EventRepository,
  type FollowUpRepository,
} from "@vex/db";
import type { createResendClient } from "@vex/integrations";
import { createLogger, withSpan } from "@vex/telemetry";

const log = createLogger("worker.follow-up-notifier");

type ResendClient = ReturnType<typeof createResendClient>;

export interface FollowUpNotifierDeps {
  db: Db;
  followUps: FollowUpRepository;
  events: EventRepository;
  /**
   * Resend client for the "follow-up is due" email. Null when
   * RESEND_API_KEY isn't set — the tick still marks rows as
   * notified (so the cron doesn't spin forever on a growing
   * backlog) but emits an `approval.executor.failed`-style audit
   * event flagged with `reason=resend_unconfigured`.
   */
  resend: ResendClient | null;
  /** Clock override for tests. */
  now?: () => Date;
}

export interface FollowUpNotifierInput {
  tenantId: string;
  /**
   * Upper bound on how far before due_at we should fire. Default 0 —
   * notifications fire at/after due time. A positive value turns
   * this into "notify N minutes before due", useful for time-
   * sensitive reminders.
   */
  leadMinutes?: number;
  /** Max rows processed per tick. Default 50. */
  maxBatch?: number;
}

export interface FollowUpNotifierResult {
  scanned: number;
  notified: number;
  skipped: number;
  failures: number;
}

const DEFAULT_MAX_BATCH = 50;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Sprint Q — cron tick that emails the assignee when a follow-up
 * comes due. Guards against duplicate notifications via
 * `follow_ups.notified_at`; markNotified uses a conditional UPDATE
 * that only succeeds when notified_at is still null, so concurrent
 * workers can't double-send.
 *
 * `assignedTo` is a free-form string. We send email only when it
 * looks like an email address; non-email assignees are treated as
 * "human eyes only" and logged without a send.
 */
export async function runFollowUpNotifierTick(
  deps: FollowUpNotifierDeps,
  input: FollowUpNotifierInput,
): Promise<FollowUpNotifierResult> {
  return withSpan(
    "worker.follow_up_notifier.tick",
    { tenant_id: input.tenantId },
    async () => {
      const clock = deps.now ?? (() => new Date());
      const maxBatch = input.maxBatch ?? DEFAULT_MAX_BATCH;
      const horizon = new Date(
        clock().getTime() + (input.leadMinutes ?? 0) * 60_000,
      );

      const due = await withTenant(deps.db, input.tenantId, async (tx) =>
        deps.followUps.listDueForNotification(tx, horizon, maxBatch),
      );

      if (due.length === 0) {
        return { scanned: 0, notified: 0, skipped: 0, failures: 0 };
      }

      let notified = 0;
      let skipped = 0;
      let failures = 0;

      for (const row of due) {
        try {
          await withTenant(deps.db, input.tenantId, async (tx) => {
            const assignee = row.assignedTo ?? "";
            const isEmail = EMAIL_RE.test(assignee);

            if (isEmail && deps.resend) {
              const subject = `Reminder: ${row.title}`;
              const body = buildEmailBody(row);
              const result = await deps.resend.send({
                to: assignee,
                subject,
                text: body,
              });
              if (result.error) {
                failures += 1;
                await emitAudit(deps, tx, input.tenantId, row.id, {
                  verb: "follow_up.notification_failed",
                  reason: `${result.error.name}: ${result.error.message}`,
                });
                return;
              }
              await deps.followUps.markNotified(tx, row.id);
              await emitAudit(deps, tx, input.tenantId, row.id, {
                verb: "follow_up.notified",
                channel: "email",
                provider_message_id: result.data?.id ?? null,
                to: assignee,
              });
              notified += 1;
              return;
            }

            // Non-email assignee (or no Resend configured). Mark
            // notified so the cron doesn't spin on this row forever;
            // audit says we had nowhere to send it.
            await deps.followUps.markNotified(tx, row.id);
            await emitAudit(deps, tx, input.tenantId, row.id, {
              verb: "follow_up.notified",
              channel: "skipped",
              reason: !deps.resend
                ? "resend_unconfigured"
                : "assignee_not_email",
              assignee,
            });
            skipped += 1;
          });
        } catch (err) {
          failures += 1;
          log.warn("follow-up notifier: row failed", {
            follow_up_id: row.id,
            error: (err as Error).message,
          });
        }
      }

      return { scanned: due.length, notified, skipped, failures };
    },
  );
}

function buildEmailBody(row: {
  title: string;
  note: string | null;
  dueAt: Date;
  subjectType: string | null;
  subjectId: string | null;
}): string {
  const lines: string[] = [
    row.title,
    "",
    `Due: ${row.dueAt.toISOString()}`,
  ];
  if (row.note) {
    lines.push("", row.note);
  }
  if (row.subjectType && row.subjectId) {
    lines.push("", `Linked to ${row.subjectType} ${row.subjectId}.`);
  }
  lines.push(
    "",
    "Open your Vex workspace to mark it complete or cancel:",
    "https://www.vexhq.ai/app/follow-ups",
    "",
    "— Vex",
  );
  return lines.join("\n");
}

async function emitAudit(
  deps: FollowUpNotifierDeps,
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  tenantId: string,
  followUpId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const verb =
    typeof metadata["verb"] === "string"
      ? (metadata["verb"] as string)
      : "follow_up.notified";
  const { verb: _verb, ...rest } = metadata;
  void _verb;
  await deps.events.insertIfNotExists(tx, tenantId, {
    verb,
    subjectType: "follow_up",
    subjectId: followUpId,
    actorType: "system",
    actorId: "follow_up_notifier",
    objectType: "follow_up",
    objectId: followUpId,
    occurredAt: new Date(),
    idempotencyKey: `follow_up.notify:${followUpId}`,
    metadata: rest,
  });
}
