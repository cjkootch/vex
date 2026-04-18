"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Tabs } from "@/components/ui/tabs";

interface CampaignTouchpoint {
  id: string;
  channel: string;
  actor: string | null;
  occurredAt: string;
  contactId: string | null;
  orgId: string | null;
  leadId: string | null;
  campaignId: string | null;
  metadata: Record<string, unknown>;
}

interface CampaignDetail {
  id: string;
  channel: string;
  source: string | null;
  medium: string | null;
  accountRef: string | null;
  spend: number | null;
  objective: string | null;
  status: string;
  touchpointCount: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  createdAt: string;
  updatedAt: string;
  touchpoints: CampaignTouchpoint[];
}

export default function CampaignDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("overview");

  useEffect(() => {
    let cancelled = false;
    setCampaign(null);
    fetch(`/api/marketing/campaigns/${params.id}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((body: { campaign: CampaignDetail }) => {
        if (!cancelled) {
          setCampaign(body.campaign);
          setError(null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <Breadcrumb ref={null} />
        <div className="mt-4 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          Couldn&apos;t load campaign: {error}
        </div>
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <Breadcrumb ref={null} />
        <div className="mt-4 text-sm text-white/40">Loading campaign…</div>
      </div>
    );
  }

  const ref = campaignRef(campaign);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-6">
      <Breadcrumb ref={ref} />

      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-2xl text-white">{ref}</h1>
            <StatusPill status={campaign.status} />
          </div>
          <p className="mt-1 text-sm text-white/60">
            {campaign.objective ?? "No stated objective."}
          </p>
        </div>
        <Link
          href={`/app/chat?ask=${encodeURIComponent(`Why did ${ref} drop in opens?`)}`}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-white/80 hover:border-accent hover:text-white"
        >
          Ask Vex →
        </Link>
      </header>

      {/* KPI rail — rollup metrics. */}
      <KpiRail campaign={campaign} />

      <Tabs
        active={activeTab}
        onChange={setActiveTab}
        tabs={[
          {
            id: "overview",
            label: "Overview",
            content: <OverviewTab campaign={campaign} />,
          },
          {
            id: "plan",
            label: "Plan",
            content: <PlanTab campaignId={campaign.id} />,
          },
          {
            id: "enrollments",
            label: "Enrollments",
            content: <EnrollmentsTab campaignId={campaign.id} />,
          },
          {
            id: "touchpoints",
            label: "Touchpoints",
            count: campaign.touchpoints.length,
            content: <TouchpointsTab touchpoints={campaign.touchpoints} />,
          },
        ]}
      />
    </div>
  );
}

interface CampaignStepRow {
  id: string;
  campaignId: string;
  position: number;
  channel: string;
  delayAfterPriorMs: number;
  templateRef: string | null;
  gateConditionJson: Record<string, unknown>;
  tier: string;
  autoApprove: boolean;
  createdAt: string;
  updatedAt: string;
}

function PlanTab({ campaignId }: { campaignId: string }) {
  const [steps, setSteps] = useState<CampaignStepRow[] | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const refresh = (): void => {
    setFetchError(null);
    fetch(`/api/marketing/campaigns/${campaignId}/steps`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((body: { steps: CampaignStepRow[]; validation: string | null }) => {
        setSteps(body.steps);
        setValidation(body.validation);
      })
      .catch((err: Error) => setFetchError(err.message));
  };
  useEffect(refresh, [campaignId]);

  if (fetchError) {
    return (
      <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
        Couldn&apos;t load plan: {fetchError}
      </div>
    );
  }
  if (steps === null) {
    return <div className="text-sm text-white/40">Loading plan…</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      {validation && (
        <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          {validation}
        </div>
      )}
      {steps.length === 0 ? (
        <div className="rounded-md border border-line bg-muted/20 px-3 py-6 text-center text-sm text-white/50">
          No steps yet. Add the first step to define the plan.
        </div>
      ) : (
        <ol className="flex flex-col gap-2">
          {steps.map((s) => (
            <li
              key={s.id}
              className="rounded-lg border border-line/60 bg-muted/20 px-3 py-3"
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-mono text-sm text-accent">
                  #{s.position}
                </span>
                <span className="text-sm font-semibold text-white">
                  {s.channel}
                </span>
                <span className="text-xs uppercase tracking-wide text-white/50">
                  {s.tier}
                  {s.autoApprove ? " · auto-approve" : ""}
                </span>
                <span className="text-xs text-white/40">
                  wait {formatDelay(s.delayAfterPriorMs)}
                </span>
              </div>
              {s.templateRef && (
                <div className="mt-1 text-xs text-white/60">
                  template: <span className="font-mono">{s.templateRef}</span>
                </div>
              )}
              {Object.keys(s.gateConditionJson ?? {}).length > 0 && (
                <pre className="mt-1 overflow-x-auto rounded bg-canvas/40 px-2 py-1 text-[11px] text-white/70">
                  {JSON.stringify(s.gateConditionJson, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ol>
      )}
      <AddStepForm
        campaignId={campaignId}
        nextPosition={steps.length}
        onCreated={refresh}
      />
    </div>
  );
}

const CHANNELS = ["email", "sms", "whatsapp", "voice", "manual"] as const;
const TIERS = ["T0", "T1", "T2", "T3"] as const;

function AddStepForm({
  campaignId,
  nextPosition,
  onCreated,
}: {
  campaignId: string;
  nextPosition: number;
  onCreated: () => void;
}) {
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]>("email");
  const [tier, setTier] = useState<(typeof TIERS)[number]>("T2");
  const [delayHours, setDelayHours] = useState("0");
  const [templateRef, setTemplateRef] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSubmitting(true);
    setErr(null);
    try {
      const hours = Number.parseFloat(delayHours);
      const body = {
        position: nextPosition,
        channel,
        tier,
        autoApprove,
        delayAfterPriorMs: Number.isFinite(hours)
          ? Math.round(hours * 3600_000)
          : 0,
        ...(templateRef.trim() ? { templateRef: templateRef.trim() } : {}),
      };
      const res = await fetch(
        `/api/marketing/campaigns/${campaignId}/steps`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(payload.message ?? `${res.status} ${res.statusText}`);
      }
      setTemplateRef("");
      setAutoApprove(false);
      onCreated();
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="rounded-lg border border-line bg-muted/10 p-3"
    >
      <div className="mb-2 text-xs uppercase tracking-wider text-white/50">
        Add step #{nextPosition}
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
        <label className="text-xs text-white/60">
          Channel
          <select
            value={channel}
            onChange={(e) =>
              setChannel(e.target.value as (typeof CHANNELS)[number])
            }
            className="mt-1 h-9 w-full rounded-md border border-line bg-canvas/40 px-2 text-sm text-white"
          >
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-white/60">
          Wait (hours)
          <input
            type="number"
            step="0.5"
            min="0"
            value={delayHours}
            onChange={(e) => setDelayHours(e.target.value)}
            className="mt-1 h-9 w-full rounded-md border border-line bg-canvas/40 px-2 text-sm text-white"
          />
        </label>
        <label className="text-xs text-white/60">
          Tier
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value as (typeof TIERS)[number])}
            className="mt-1 h-9 w-full rounded-md border border-line bg-canvas/40 px-2 text-sm text-white"
          >
            {TIERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-white/60">
          Template ref
          <input
            type="text"
            value={templateRef}
            onChange={(e) => setTemplateRef(e.target.value)}
            placeholder="(email template id / whatsapp content_sid)"
            className="mt-1 h-9 w-full rounded-md border border-line bg-canvas/40 px-2 text-sm text-white"
          />
        </label>
      </div>
      <label className="mt-2 flex items-center gap-2 text-xs text-white/60">
        <input
          type="checkbox"
          checked={autoApprove}
          onChange={(e) => setAutoApprove(e.target.checked)}
        />
        Auto-approve this step (skip ApprovalGate — use sparingly)
      </label>
      {err && (
        <div className="mt-2 rounded-md border border-bad/40 bg-bad/10 px-2 py-1 text-xs text-bad">
          {err}
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <button
          type="submit"
          disabled={submitting}
          data-testid="add-step-submit"
          className="h-8 rounded-md bg-accent px-3 text-xs font-medium text-white hover:bg-accent/80 disabled:opacity-60"
        >
          {submitting ? "Adding…" : "Add step"}
        </button>
      </div>
    </form>
  );
}

function formatDelay(ms: number): string {
  if (ms <= 0) return "immediately";
  const hours = ms / 3600_000;
  if (hours < 1) return `${Math.round(ms / 60_000)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours / 24)}d`;
}

interface EnrollmentRow {
  id: string;
  contactId: string;
  currentStep: number;
  state: string;
  lastEventAt: string | null;
  error: string | null;
  createdAt: string;
  /** Sprint G — per-step narrative from the workflow. */
  branchHistoryJson?: Array<Record<string, unknown>>;
}

interface BranchHistoryEntry {
  step_id?: string;
  position?: number;
  outcome?: string;
  gate_reason?: string;
  skip_reason?: string;
  approval_id?: string;
}

function EnrollmentsTab({ campaignId }: { campaignId: string }) {
  const [rows, setRows] = useState<EnrollmentRow[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/marketing/campaigns/${campaignId}/enrollments`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then(
        (body: {
          enrollments: EnrollmentRow[];
          counts: Record<string, number>;
        }) => {
          if (!cancelled) {
            setRows(body.enrollments);
            setCounts(body.counts ?? {});
          }
        },
      )
      .catch((e: Error) => {
        if (!cancelled) setErr(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  if (err) {
    return (
      <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
        Couldn&apos;t load enrollments: {err}
      </div>
    );
  }
  if (rows === null) {
    return <div className="text-sm text-white/40">Loading enrollments…</div>;
  }
  const stateBadges: { state: string; label: string; palette: string }[] = [
    { state: "enrolled", label: "Enrolled", palette: "bg-good/20 text-good" },
    { state: "paused", label: "Paused", palette: "bg-warn/20 text-warn" },
    { state: "completed", label: "Completed", palette: "bg-muted/60 text-white/70" },
    { state: "unsubscribed", label: "Unsubscribed", palette: "bg-muted/60 text-white/50" },
    { state: "errored", label: "Errored", palette: "bg-bad/20 text-bad" },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {stateBadges.map((b) => (
          <span
            key={b.state}
            className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs ${b.palette}`}
          >
            {b.label}: <span className="font-mono">{counts[b.state] ?? 0}</span>
          </span>
        ))}
      </div>
      {rows.length === 0 ? (
        <div className="rounded-md border border-line bg-muted/20 px-3 py-6 text-center text-sm text-white/50">
          No contacts enrolled yet.
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <EnrollmentRowItem key={r.id} row={r} />
          ))}
        </ul>
      )}
    </div>
  );
}

function EnrollmentRowItem({ row }: { row: EnrollmentRow }) {
  const [open, setOpen] = useState(false);
  const history = Array.isArray(row.branchHistoryJson)
    ? (row.branchHistoryJson as BranchHistoryEntry[])
    : [];
  const hasHistory = history.length > 0;

  return (
    <li className="rounded-md border border-line/60 bg-muted/20 text-sm">
      <button
        type="button"
        onClick={() => hasHistory && setOpen(!open)}
        disabled={!hasHistory}
        className={`flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left ${
          hasHistory ? "cursor-pointer hover:bg-muted/30" : "cursor-default"
        }`}
        aria-expanded={open}
        data-testid="enrollment-row"
      >
        <span className="flex items-baseline gap-2 text-xs">
          {hasHistory && (
            <span className="inline-block w-3 text-white/40">
              {open ? "▾" : "▸"}
            </span>
          )}
          <span className="font-mono text-accent">
            {row.contactId.slice(0, 12)}…
          </span>
        </span>
        <span className="text-xs text-white/70">
          step {row.currentStep} · {row.state}
        </span>
        <span className="text-xs text-white/40">
          {hasHistory ? `${history.length} step${history.length === 1 ? "" : "s"}` : "—"}
          {" · "}
          {row.lastEventAt ? new Date(row.lastEventAt).toLocaleString() : "—"}
        </span>
        {row.error && (
          <span className="truncate text-xs text-bad">{row.error}</span>
        )}
      </button>
      {open && hasHistory && (
        <BranchHistoryTimeline history={history} />
      )}
    </li>
  );
}

/**
 * Sprint G — renders `branchHistoryJson` as a vertical step timeline.
 * Each entry is one of:
 *   outcome=auto_approved | approved     → green badge
 *   outcome=rejected                     → red badge
 *   outcome=skipped_gate                 → muted + gate_reason
 *   outcome=skipped_dispatch             → muted + skip_reason
 *   outcome=approval_timed_out           → warn badge + approval_id
 */
function BranchHistoryTimeline({ history }: { history: BranchHistoryEntry[] }) {
  const sorted = [...history].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return (
    <ol
      data-testid="branch-history-timeline"
      className="border-t border-line/40 bg-canvas/30 px-4 py-3"
    >
      {sorted.map((entry, i) => {
        const palette = outcomePalette(entry.outcome);
        return (
          <li
            key={`${entry.step_id ?? i}:${i}`}
            className="flex items-baseline gap-3 py-1 text-xs"
          >
            <span className="font-mono text-accent">
              #{entry.position ?? i}
            </span>
            <span className={`rounded px-1.5 py-0.5 font-mono ${palette}`}>
              {entry.outcome ?? "unknown"}
            </span>
            {entry.gate_reason && (
              <span className="text-white/60">gate: {entry.gate_reason}</span>
            )}
            {entry.skip_reason && (
              <span className="text-white/60">skip: {entry.skip_reason}</span>
            )}
            {entry.approval_id && (
              <span className="font-mono text-[10px] text-white/40">
                approval {entry.approval_id.slice(0, 12)}…
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function outcomePalette(outcome?: string): string {
  switch (outcome) {
    case "approved":
    case "auto_approved":
      return "bg-good/20 text-good";
    case "rejected":
      return "bg-bad/20 text-bad";
    case "approval_timed_out":
      return "bg-warn/20 text-warn";
    case "skipped_gate":
    case "skipped_dispatch":
      return "bg-muted/60 text-white/50";
    default:
      return "bg-muted/60 text-white/70";
  }
}

function KpiRail({ campaign }: { campaign: CampaignDetail }) {
  const items: { label: string; value: string }[] = [
    { label: "Sent", value: formatCount(campaign.sent) },
    { label: "Delivered", value: formatCount(campaign.delivered) },
    { label: "Opened", value: formatCount(campaign.opened) },
    { label: "Clicked", value: formatCount(campaign.clicked) },
    { label: "Bounced", value: formatCount(campaign.bounced) },
    { label: "Touchpoints", value: formatCount(campaign.touchpointCount) },
  ];
  return (
    <div className="-mx-6 overflow-x-auto px-6 md:mx-0 md:px-0">
      <div className="grid min-w-[640px] grid-cols-6 gap-2 md:min-w-0">
        {items.map((item) => (
          <div
            key={item.label}
            className="rounded-lg border border-line bg-muted/20 px-3 py-3"
          >
            <div className="text-[10px] uppercase tracking-wide text-white/50">
              {item.label}
            </div>
            <div className="mt-1 font-mono text-lg text-white">
              {item.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OverviewTab({ campaign }: { campaign: CampaignDetail }) {
  return (
    <div className="flex flex-col gap-4">
      <Card title="Rollups">
        <Field label="Sent" value={formatCount(campaign.sent)} />
        <Field label="Delivered" value={formatCount(campaign.delivered)} />
        <Field label="Opened" value={formatCount(campaign.opened)} />
        <Field label="Clicked" value={formatCount(campaign.clicked)} />
        <Field label="Bounced" value={formatCount(campaign.bounced)} />
        <Field
          label="Open rate"
          value={rate(campaign.opened, campaign.delivered || campaign.sent)}
        />
        <Field
          label="Click rate"
          value={rate(campaign.clicked, campaign.delivered || campaign.sent)}
        />
      </Card>

      <Card title="Config">
        <Field label="Channel" value={campaign.channel} />
        <Field label="Source" value={campaign.source ?? "—"} />
        <Field label="Medium" value={campaign.medium ?? "—"} />
        <Field label="Account" value={campaign.accountRef ?? "—"} />
        <Field label="Spend" value={formatSpend(campaign.spend)} />
        <Field label="Objective" value={campaign.objective ?? "—"} />
        <Field label="Created" value={shortDateTime(campaign.createdAt)} />
        <Field label="Updated" value={shortDateTime(campaign.updatedAt)} />
      </Card>
    </div>
  );
}

function TouchpointsTab({
  touchpoints,
}: {
  touchpoints: CampaignTouchpoint[];
}) {
  if (touchpoints.length === 0) {
    return (
      <div className="rounded-md border border-line bg-muted/20 px-3 py-6 text-center text-sm text-white/40">
        No touchpoints recorded yet.
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {touchpoints.map((t) => (
        <li
          key={t.id}
          className="rounded-lg border border-line bg-muted/20 p-3"
        >
          <div className="flex items-start justify-between gap-3 text-sm">
            <div className="min-w-0">
              <span className="font-mono text-accent">{t.channel}</span>
              {t.actor && (
                <>
                  <span className="mx-2 text-white/30">·</span>
                  <span className="text-white/70">{t.actor}</span>
                </>
              )}
            </div>
            <span className="flex-shrink-0 text-xs text-white/50">
              {shortDateTime(t.occurredAt)}
            </span>
          </div>
          {(t.contactId || t.orgId) && (
            <div className="mt-1.5 flex flex-wrap gap-3 text-xs">
              {t.contactId && (
                <Link
                  href={`/app/contacts/${t.contactId}`}
                  className="text-accent hover:underline"
                >
                  contact: {t.contactId.slice(-6)}
                </Link>
              )}
              {t.orgId && (
                <Link
                  href={`/app/companies/${t.orgId}`}
                  className="text-accent hover:underline"
                >
                  org: {t.orgId.slice(-6)}
                </Link>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function Breadcrumb({ ref }: { ref: string | null }) {
  return (
    <nav className="text-xs text-white/50">
      <Link href="/app" className="hover:text-white/80">
        Home
      </Link>
      <span className="mx-1">/</span>
      <Link href="/app/marketing" className="hover:text-white/80">
        Marketing
      </Link>
      {ref && (
        <>
          <span className="mx-1">/</span>
          <span className="font-mono text-white/70">{ref}</span>
        </>
      )}
    </nav>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-muted/20 p-4">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/50">
        {title}
      </h3>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 text-sm">
      <span className="text-white/50">{label}</span>
      <span className="text-white/90">{value}</span>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const palette: Record<string, string> = {
    active: "bg-good/20 text-good",
    paused: "bg-warn/20 text-warn",
    completed: "bg-muted/80 text-white/60",
    archived: "bg-muted/60 text-white/50",
  };
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs ${
        palette[status] ?? "bg-muted/60 text-white/70"
      }`}
    >
      {status}
    </span>
  );
}

function campaignRef(c: CampaignDetail): string {
  const left = c.source ?? c.channel;
  const right = c.medium;
  if (right) return `${left} · ${right}`;
  return left;
}

function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (n < 1000) return n.toLocaleString("en-US");
  return `${(n / 1000).toFixed(1)}k`;
}

function formatSpend(n: number | null): string {
  if (n === null || n === undefined) return "—";
  if (n === 0) return "$0";
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toLocaleString("en-US")}`;
}

function rate(numerator: number, denominator: number): string {
  if (!denominator) return "—";
  const r = numerator / denominator;
  return `${(r * 100).toFixed(1)}%`;
}

function shortDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
