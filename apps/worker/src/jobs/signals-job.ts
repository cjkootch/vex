import {
  schema,
  withTenant,
  type Db,
  type SignalRepository,
} from "@vex/db";
import { and, eq, lt, sql } from "drizzle-orm";
import { createLogger, withSpan } from "@vex/telemetry";

const log = createLogger("worker.signals");

export interface SignalsJobDeps {
  db: Db;
  signals: SignalRepository;
}

export interface SignalsJobInput {
  tenantId: string;
  /** Clock override for tests. */
  now?: () => Date;
}

export interface SignalsJobResult {
  fired: number;
  resolved: number;
  rulesRun: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sprint T — proactive-signal rule engine. Runs on a cron, evaluates
 * every rule against current DB state, fires (or resolves) signals
 * via SignalRepository. The repository's unique-index on
 * (tenant, rule, subject) WHERE acknowledged_at IS NULL gives us
 * idempotent fires — re-running the same rule on the same subject
 * before the operator acknowledges is a no-op.
 *
 * Rules are intentionally simple SQL + heuristics — the value is in
 * surfacing the condition, not in being clever. Add more rules by
 * appending to the RULES array.
 */
export async function runSignalsTick(
  deps: SignalsJobDeps,
  input: SignalsJobInput,
): Promise<SignalsJobResult> {
  return withSpan(
    "worker.signals.tick",
    { tenant_id: input.tenantId },
    async () => {
      const clock = input.now ?? (() => new Date());
      let fired = 0;
      let resolved = 0;

      for (const rule of RULES) {
        try {
          await withTenant(deps.db, input.tenantId, async (tx) => {
            const verdict = await rule.run(tx, clock());
            for (const fire of verdict.fire) {
              const before = await deps.signals.fire(tx, input.tenantId, {
                ruleId: rule.id,
                severity: rule.severity,
                subjectType: fire.subjectType,
                subjectId: fire.subjectId,
                title: fire.title,
                body: fire.body ?? null,
                metadata: fire.metadata ?? {},
              });
              if (
                before.createdAt.getTime() >
                clock().getTime() - 5_000
              ) {
                fired += 1;
              }
            }
            for (const subjectId of verdict.resolve) {
              await deps.signals.resolve(
                tx,
                input.tenantId,
                rule.id,
                subjectId,
              );
              resolved += 1;
            }
          });
        } catch (err) {
          log.warn("signals rule failed", {
            rule_id: rule.id,
            error: (err as Error).message,
          });
        }
      }

      return { fired, resolved, rulesRun: RULES.length };
    },
  );
}

interface RuleFire {
  subjectType: string | null;
  subjectId: string | null;
  title: string;
  body?: string;
  metadata?: Record<string, unknown>;
}

interface RuleVerdict {
  fire: RuleFire[];
  /** Subject ids whose open signal (for this rule) should be cleared. */
  resolve: Array<string | null>;
}

interface Rule {
  id: string;
  severity: "info" | "warn" | "critical";
  run: (tx: Parameters<Parameters<typeof withTenant>[2]>[0], now: Date) => Promise<RuleVerdict>;
}

const RULES: Rule[] = [
  // 1. Laycan approaching (< 5 days) with BIS licence still required
  //    and number missing. Critical because an export without BIS is a
  //    material compliance breach.
  {
    id: "deal.laycan_approaching_without_bis",
    severity: "critical",
    async run(tx, now) {
      const horizon = new Date(now.getTime() + 5 * DAY_MS);
      const rows = await tx
        .select({
          id: schema.fuelDeals.id,
          dealRef: schema.fuelDeals.dealRef,
          laycanEnd: schema.fuelDeals.laycanEnd,
          bisLicenseNumber: schema.fuelDeals.bisLicenseNumber,
          bisLicenseRequired: schema.fuelDeals.bisLicenseRequired,
          status: schema.fuelDeals.status,
        })
        .from(schema.fuelDeals)
        .where(
          and(
            eq(schema.fuelDeals.bisLicenseRequired, true),
            sql`${schema.fuelDeals.status} NOT IN ('closed_won', 'closed_lost', 'cancelled')`,
          ),
        );

      const fire: RuleFire[] = [];
      const resolve: Array<string | null> = [];
      for (const row of rows) {
        const laycanDate = row.laycanEnd ? new Date(row.laycanEnd) : null;
        const missingBis = !row.bisLicenseNumber;
        const approaching =
          laycanDate !== null && laycanDate.getTime() <= horizon.getTime();
        if (missingBis && approaching) {
          fire.push({
            subjectType: "fuel_deal",
            subjectId: row.id,
            title: `${row.dealRef}: laycan within 5 days, BIS licence missing`,
            body: `Deal ${row.dealRef} has laycan_end ${row.laycanEnd ?? "unset"} and BIS licence is required but no licence number is on file. Export without the licence is a compliance breach.`,
            metadata: {
              deal_ref: row.dealRef,
              laycan_end: row.laycanEnd,
              status: row.status,
            },
          });
        } else {
          resolve.push(row.id);
        }
      }
      return { fire, resolve };
    },
  },
  // 2. Deal stuck in "negotiating" for > 14 days without any touchpoint
  //    or event movement. Signals attention is needed.
  {
    id: "deal.stale_negotiating",
    severity: "warn",
    async run(tx, now) {
      const staleHorizon = new Date(now.getTime() - 14 * DAY_MS);
      const rows = await tx
        .select({
          id: schema.fuelDeals.id,
          dealRef: schema.fuelDeals.dealRef,
          updatedAt: schema.fuelDeals.updatedAt,
        })
        .from(schema.fuelDeals)
        .where(eq(schema.fuelDeals.status, "negotiating"));

      const fire: RuleFire[] = [];
      const resolve: Array<string | null> = [];
      for (const row of rows) {
        if (row.updatedAt.getTime() < staleHorizon.getTime()) {
          fire.push({
            subjectType: "fuel_deal",
            subjectId: row.id,
            title: `${row.dealRef}: no movement in 14+ days`,
            body: `Deal ${row.dealRef} is still in "negotiating" and hasn't been updated since ${row.updatedAt.toISOString().slice(0, 10)}. Worth a check-in or status change.`,
            metadata: {
              deal_ref: row.dealRef,
              last_updated: row.updatedAt.toISOString(),
            },
          });
        } else {
          resolve.push(row.id);
        }
      }
      return { fire, resolve };
    },
  },
  // 3. Open follow-ups past due by > 24h and not yet notified. Layers
  //    on top of the existing follow-up notifier — notifier emails the
  //    assignee; this fires a workspace-visible signal so the team
  //    sees overdue tasks without watching their inbox.
  {
    id: "follow_up.overdue_24h",
    severity: "warn",
    async run(tx, now) {
      const cutoff = new Date(now.getTime() - DAY_MS);
      const rows = await tx
        .select({
          id: schema.followUps.id,
          title: schema.followUps.title,
          dueAt: schema.followUps.dueAt,
          assignedTo: schema.followUps.assignedTo,
          subjectType: schema.followUps.subjectType,
          subjectId: schema.followUps.subjectId,
        })
        .from(schema.followUps)
        .where(
          and(
            eq(schema.followUps.status, "open"),
            lt(schema.followUps.dueAt, cutoff),
          ),
        );

      const fire: RuleFire[] = rows.map((r) => ({
        subjectType: "follow_up",
        subjectId: r.id,
        title: `Overdue: ${r.title}`,
        body: `Due ${r.dueAt.toISOString()}${r.assignedTo ? ` · assigned to ${r.assignedTo}` : ""}.`,
        metadata: {
          due_at: r.dueAt.toISOString(),
          assigned_to: r.assignedTo,
          linked_subject_type: r.subjectType,
          linked_subject_id: r.subjectId,
        },
      }));
      // No proactive resolve here — completing/cancelling the
      // follow-up in the UI is the resolution path, and the cron
      // naturally stops re-firing because closed rows don't match
      // the query. Operators acknowledge from the signals page to
      // clear the row.
      return { fire, resolve: [] };
    },
  },
  // 4. Contact hasn't replied after 3+ outbound touchpoints in the
   //   last 30 days — a silence signal that suggests the thread has
   //   gone cold.
  {
    id: "contact.silent_after_3_outbound",
    severity: "info",
    async run(tx, now) {
      const horizon = new Date(now.getTime() - 30 * DAY_MS);
      const rows = (await tx.execute(sql`
        SELECT
          contact_id,
          COUNT(*) FILTER (
            WHERE metadata->>'direction' = 'outbound'
          ) AS outbound_count,
          COUNT(*) FILTER (
            WHERE metadata->>'direction' = 'inbound'
          ) AS inbound_count
        FROM touchpoints
        WHERE occurred_at >= ${horizon}
          AND contact_id IS NOT NULL
        GROUP BY contact_id
        HAVING
          COUNT(*) FILTER (
            WHERE metadata->>'direction' = 'outbound'
          ) >= 3
          AND COUNT(*) FILTER (
            WHERE metadata->>'direction' = 'inbound'
          ) = 0
      `)) as unknown as Array<{
        contact_id: string;
        outbound_count: string | number;
        inbound_count: string | number;
      }>;

      const fire: RuleFire[] = [];
      for (const row of rows) {
        const outboundCount = Number(row.outbound_count);
        fire.push({
          subjectType: "contact",
          subjectId: row.contact_id,
          title: `${outboundCount} outbound touches, no reply (30d)`,
          body: `Contact ${row.contact_id} has ${outboundCount} outbound messages in the last 30 days without a single inbound reply. Consider pausing the sequence or switching channel.`,
          metadata: {
            outbound_count: outboundCount,
          },
        });
      }
      return { fire, resolve: [] };
    },
  },
  // 5. Food-line deal: laycan within the configured production lead
  //    time and no production_started milestone on file. VTC's
  //    pork/chicken deals run 4–5 wks between PO and shipment-
  //    ready; if the factory isn't on the clock this late, the
  //    cargo won't make laycan.
  {
    id: "food.production_window_risk",
    severity: "warn",
    async run(tx, now) {
      const rows = await tx
        .select({
          id: schema.fuelDeals.id,
          dealRef: schema.fuelDeals.dealRef,
          laycanEnd: schema.fuelDeals.laycanEnd,
          productionLeadTimeWeeks:
            schema.fuelDeals.productionLeadTimeWeeks,
          status: schema.fuelDeals.status,
        })
        .from(schema.fuelDeals)
        .where(
          and(
            eq(schema.fuelDeals.lineOfBusiness, "food"),
            sql`${schema.fuelDeals.productionLeadTimeWeeks} IS NOT NULL`,
            sql`${schema.fuelDeals.status} NOT IN ('closed_won', 'closed_lost', 'cancelled', 'settled', 'delivered')`,
          ),
        );

      const fire: RuleFire[] = [];
      const resolve: Array<string | null> = [];
      for (const row of rows) {
        const weeks = row.productionLeadTimeWeeks ?? 0;
        const laycan = row.laycanEnd ? new Date(row.laycanEnd) : null;
        if (!laycan || weeks === 0) {
          resolve.push(row.id);
          continue;
        }
        const windowStart = new Date(
          laycan.getTime() - weeks * 7 * DAY_MS,
        );
        if (now.getTime() < windowStart.getTime()) {
          resolve.push(row.id);
          continue;
        }
        // Inside the window — check if production_started event fired
        // for this deal. If so, the factory is running on time.
        const startedCount = (await tx.execute(sql`
          SELECT COUNT(*)::int AS c
          FROM events
          WHERE subject_type = 'fuel_deal'
            AND subject_id = ${row.id}
            AND verb = 'deal.milestone.production_started'
        `)) as unknown as Array<{ c: number }>;
        const started = Number(startedCount[0]?.c ?? 0) > 0;
        if (started) {
          resolve.push(row.id);
        } else {
          fire.push({
            subjectType: "fuel_deal",
            subjectId: row.id,
            title: `${row.dealRef}: inside ${weeks}-week production window, factory hasn't started`,
            body: `Food deal ${row.dealRef} has laycan_end ${row.laycanEnd} and a ${weeks}-week production lead time. The window opened ${windowStart.toISOString().slice(0, 10)} and no deal.milestone.production_started event has been recorded. Ping the supplier — shipment-ready risk.`,
            metadata: {
              deal_ref: row.dealRef,
              laycan_end: row.laycanEnd,
              lead_time_weeks: weeks,
              window_start: windowStart.toISOString(),
            },
          });
        }
      }
      return { fire, resolve };
    },
  },
];
