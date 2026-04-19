import {
  schema,
  withTenant,
  type Db,
  type EventRepository,
  type SignalRepository,
} from "@vex/db";
import { and, desc, eq, gte, isNull, lt } from "drizzle-orm";
import type { createResendClient } from "@vex/integrations";
import { createLogger, withSpan } from "@vex/telemetry";

const log = createLogger("worker.daily-digest");

type ResendClient = ReturnType<typeof createResendClient>;

export interface DailyDigestDeps {
  db: Db;
  events: EventRepository;
  signals: SignalRepository;
  resend: ResendClient | null;
}

export interface DailyDigestInput {
  tenantId: string;
  /** Address the digest is sent to. When null we skip the send but still build the digest for the log. */
  to: string | null;
  now?: () => Date;
}

export interface DailyDigestResult {
  sent: boolean;
  skippedReason: string | null;
  signals_open: number;
  events_last_24h: number;
  followups_due_today: number;
}

/**
 * Sprint U — morning briefing email. Runs once per day, rolls up:
 *   - open critical/warn signals
 *   - events in the last 24h (status changes, milestones, ack'd signals)
 *   - follow-ups coming due today
 * Emails the tenant owner via Resend. Skips cleanly when Resend or
 * the recipient address isn't configured — the digest is still
 * assembled for log inspection.
 */
export async function runDailyDigest(
  deps: DailyDigestDeps,
  input: DailyDigestInput,
): Promise<DailyDigestResult> {
  return withSpan(
    "worker.daily_digest.run",
    { tenant_id: input.tenantId },
    async () => {
      const clock = input.now ?? (() => new Date());
      const now = clock();
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const endOfDay = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          23,
          59,
          59,
        ),
      );

      const digest = await withTenant(deps.db, input.tenantId, async (tx) => {
        const openSignals = await deps.signals.listOpen(tx, 50);
        const recentEvents = await tx
          .select({
            id: schema.events.id,
            verb: schema.events.verb,
            subjectType: schema.events.subjectType,
            subjectId: schema.events.subjectId,
            occurredAt: schema.events.occurredAt,
            metadata: schema.events.metadata,
          })
          .from(schema.events)
          .where(gte(schema.events.occurredAt, dayAgo))
          .orderBy(desc(schema.events.occurredAt))
          .limit(100);
        const followUpsDueToday = await tx
          .select({
            id: schema.followUps.id,
            title: schema.followUps.title,
            dueAt: schema.followUps.dueAt,
            assignedTo: schema.followUps.assignedTo,
          })
          .from(schema.followUps)
          .where(
            and(
              eq(schema.followUps.status, "open"),
              lt(schema.followUps.dueAt, endOfDay),
            ),
          )
          .orderBy(schema.followUps.dueAt)
          .limit(30);
        return { openSignals, recentEvents, followUpsDueToday };
      });

      const html = buildDigestHtml(digest, now);
      const text = buildDigestText(digest, now);

      if (!deps.resend) {
        log.info("daily-digest: Resend not configured, skipping send");
        return {
          sent: false,
          skippedReason: "resend_unconfigured",
          signals_open: digest.openSignals.length,
          events_last_24h: digest.recentEvents.length,
          followups_due_today: digest.followUpsDueToday.length,
        };
      }
      if (!input.to) {
        return {
          sent: false,
          skippedReason: "no_recipient",
          signals_open: digest.openSignals.length,
          events_last_24h: digest.recentEvents.length,
          followups_due_today: digest.followUpsDueToday.length,
        };
      }

      const subject = `Vex morning brief · ${now.toISOString().slice(0, 10)} · ${digest.openSignals.length} open signal(s)`;
      const result = await deps.resend.send({
        to: input.to,
        subject,
        text,
        html,
      });
      if (result.error) {
        log.warn("daily-digest: Resend error", {
          error: `${result.error.name}: ${result.error.message}`,
        });
        return {
          sent: false,
          skippedReason: `resend_error:${result.error.name}`,
          signals_open: digest.openSignals.length,
          events_last_24h: digest.recentEvents.length,
          followups_due_today: digest.followUpsDueToday.length,
        };
      }
      return {
        sent: true,
        skippedReason: null,
        signals_open: digest.openSignals.length,
        events_last_24h: digest.recentEvents.length,
        followups_due_today: digest.followUpsDueToday.length,
      };
    },
  );
}

function buildDigestText(
  digest: {
    openSignals: Array<{
      title: string;
      severity: string;
      ruleId: string;
      body: string | null;
    }>;
    recentEvents: Array<{
      verb: string;
      subjectType: string;
      subjectId: string;
      occurredAt: Date;
    }>;
    followUpsDueToday: Array<{
      title: string;
      dueAt: Date;
      assignedTo: string | null;
    }>;
  },
  now: Date,
): string {
  const lines: string[] = [];
  lines.push(`Vex morning brief — ${now.toISOString().slice(0, 10)}`);
  lines.push("");

  lines.push(`Open signals (${digest.openSignals.length}):`);
  if (digest.openSignals.length === 0) {
    lines.push("  — none");
  } else {
    for (const s of digest.openSignals.slice(0, 10)) {
      lines.push(`  [${s.severity.toUpperCase()}] ${s.title}`);
    }
  }
  lines.push("");

  lines.push(`Follow-ups due today (${digest.followUpsDueToday.length}):`);
  if (digest.followUpsDueToday.length === 0) {
    lines.push("  — none");
  } else {
    for (const f of digest.followUpsDueToday.slice(0, 10)) {
      lines.push(
        `  ${f.title}${f.assignedTo ? ` [${f.assignedTo}]` : ""} — due ${f.dueAt.toISOString()}`,
      );
    }
  }
  lines.push("");

  lines.push(`Events in the last 24h (${digest.recentEvents.length}):`);
  const verbCounts = new Map<string, number>();
  for (const e of digest.recentEvents) {
    verbCounts.set(e.verb, (verbCounts.get(e.verb) ?? 0) + 1);
  }
  const sorted = [...verbCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [verb, count] of sorted.slice(0, 10)) {
    lines.push(`  ${verb}: ${count}`);
  }
  lines.push("");
  lines.push("Open your Vex workspace: https://www.vexhq.ai/app");
  lines.push("— Vex");
  return lines.join("\n");
}

function buildDigestHtml(
  digest: {
    openSignals: Array<{
      title: string;
      severity: string;
      ruleId: string;
      body: string | null;
    }>;
    recentEvents: Array<{
      verb: string;
      subjectType: string;
      subjectId: string;
      occurredAt: Date;
    }>;
    followUpsDueToday: Array<{
      title: string;
      dueAt: Date;
      assignedTo: string | null;
    }>;
  },
  now: Date,
): string {
  const sevColor = (s: string): string =>
    s === "critical" ? "#b91c1c" : s === "warn" ? "#b45309" : "#6b7280";
  const verbCounts = new Map<string, number>();
  for (const e of digest.recentEvents) {
    verbCounts.set(e.verb, (verbCounts.get(e.verb) ?? 0) + 1);
  }
  const sorted = [...verbCounts.entries()].sort((a, b) => b[1] - a[1]);
  const esc = (s: string): string =>
    s.replace(/[&<>]/g, (m) =>
      m === "&" ? "&amp;" : m === "<" ? "&lt;" : "&gt;",
    );
  return `<!doctype html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; background:#0b0d10; color:#e5e7eb; padding:24px; max-width:640px; margin:0 auto;">
<h1 style="margin:0 0 16px; font-size:20px;">Vex morning brief</h1>
<p style="margin:0 0 24px; color:#9ca3af; font-size:13px;">${now.toISOString().slice(0, 10)}</p>

<h2 style="margin:24px 0 8px; font-size:14px; text-transform:uppercase; letter-spacing:0.05em; color:#9ca3af;">Open signals (${digest.openSignals.length})</h2>
${
  digest.openSignals.length === 0
    ? `<p style="color:#6b7280; font-size:13px;">None — nice.</p>`
    : `<ul style="list-style:none; padding:0; margin:0;">${digest.openSignals
        .slice(0, 10)
        .map(
          (s) => `
<li style="padding:10px 12px; margin-bottom:6px; background:#111418; border-left:3px solid ${sevColor(s.severity)}; border-radius:4px; font-size:14px;">
  <strong style="color:${sevColor(s.severity)}; text-transform:uppercase; font-size:10px; letter-spacing:0.05em;">${esc(s.severity)}</strong>
  <span style="margin-left:8px;">${esc(s.title)}</span>
</li>`,
        )
        .join("")}</ul>`
}

<h2 style="margin:24px 0 8px; font-size:14px; text-transform:uppercase; letter-spacing:0.05em; color:#9ca3af;">Follow-ups due today (${digest.followUpsDueToday.length})</h2>
${
  digest.followUpsDueToday.length === 0
    ? `<p style="color:#6b7280; font-size:13px;">Nothing scheduled.</p>`
    : `<ul style="list-style:none; padding:0; margin:0;">${digest.followUpsDueToday
        .slice(0, 10)
        .map(
          (f) => `
<li style="padding:8px 12px; margin-bottom:4px; background:#111418; border-radius:4px; font-size:13px;">
  <div>${esc(f.title)}</div>
  <div style="color:#9ca3af; font-size:11px; margin-top:2px;">due ${esc(f.dueAt.toISOString())}${f.assignedTo ? ` · ${esc(f.assignedTo)}` : ""}</div>
</li>`,
        )
        .join("")}</ul>`
}

<h2 style="margin:24px 0 8px; font-size:14px; text-transform:uppercase; letter-spacing:0.05em; color:#9ca3af;">Activity (last 24h)</h2>
<table style="width:100%; border-collapse:collapse; font-size:13px;">
${sorted
  .slice(0, 10)
  .map(
    ([verb, count]) => `
<tr><td style="padding:4px 0; color:#d1d5db;">${esc(verb)}</td><td style="padding:4px 0; text-align:right; color:#9ca3af; font-variant-numeric:tabular-nums;">${count}</td></tr>`,
  )
  .join("")}
</table>

<p style="margin:32px 0 0; font-size:12px; color:#6b7280;">
  <a href="https://www.vexhq.ai/app" style="color:#a78bfa; text-decoration:none;">Open your Vex workspace →</a>
</p>
</body></html>`;
}

void isNull;
