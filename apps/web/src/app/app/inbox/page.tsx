"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";

/**
 * /app/inbox — unified communications log.
 *
 * Time-sorted stream that merges:
 *   - touchpoints (email.*, sms.*, whatsapp.*) with their event verb
 *     preserved in the channel suffix so the status badge is accurate
 *     (sent vs delivered vs opened vs replied etc.)
 *   - voice_call activities with live status + duration
 *
 * Filters are client-side state that re-fetch on change. The server
 * does the heavy lifting (SQL-level filter + keyset pagination); this
 * component just renders + fans out on `kind`.
 */

type ChannelFilter = "email" | "sms" | "whatsapp" | "call";
type DirectionFilter = "inbound" | "outbound";

interface TouchpointItem {
  kind: "touchpoint";
  id: string;
  channel: string;
  channelGroup: "email" | "sms" | "whatsapp" | "other";
  direction: DirectionFilter | null;
  occurredAt: string;
  contactId: string | null;
  campaignId: string | null;
  preview: string | null;
  metadata: Record<string, unknown>;
}

interface CallItem {
  kind: "call";
  id: string;
  occurredAt: string;
  contactId: string | null;
  workflowId: string | null;
  callSid: string | null;
  status: string | null;
  durationSeconds: number | null;
  transcriptRef: string | null;
}

type CommunicationItem = TouchpointItem | CallItem;

interface FeedResponse {
  items: CommunicationItem[];
  nextBefore: string | null;
}

const ALL_CHANNELS: ChannelFilter[] = ["call", "email", "sms", "whatsapp"];
const CHANNEL_LABEL: Record<ChannelFilter, string> = {
  call: "Calls",
  email: "Email",
  sms: "SMS",
  whatsapp: "WhatsApp",
};

export default function InboxPage(): React.ReactElement {
  const [channels, setChannels] = useState<Set<ChannelFilter>>(new Set());
  const [direction, setDirection] = useState<DirectionFilter | "all">("all");
  const [items, setItems] = useState<CommunicationItem[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const buildQuery = useCallback(
    (before: string | null): string => {
      const params = new URLSearchParams();
      for (const c of channels) params.append("channel", c);
      if (direction !== "all") params.set("direction", direction);
      if (before) params.set("before", before);
      params.set("limit", "50");
      return params.toString();
    },
    [channels, direction],
  );

  const load = useCallback(
    async (before: string | null, append: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/communications?${buildQuery(before)}`);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const body = (await res.json()) as FeedResponse;
        setItems((prev) => (append ? [...prev, ...body.items] : body.items));
        setNextBefore(body.nextBefore);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [buildQuery],
  );

  useEffect(() => {
    void load(null, false);
  }, [load]);

  const toggleChannel = (c: ChannelFilter) => {
    setChannels((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-white">Inbox</h1>
          <p className="mt-1 text-xs text-white/50">
            Every call, email, SMS, and WhatsApp event across the workspace,
            time-sorted.
          </p>
        </div>
        <div className="text-xs text-white/40">
          {loading ? "Loading…" : `${items.length} items`}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-muted/20 p-3">
        <span className="text-[11px] uppercase tracking-wide text-white/40">
          Channel
        </span>
        {ALL_CHANNELS.map((c) => {
          const active = channels.has(c);
          return (
            <button
              key={c}
              type="button"
              data-testid={`channel-filter-${c}`}
              data-active={active}
              onClick={() => toggleChannel(c)}
              className={`rounded-full px-3 py-1 text-xs ${
                active
                  ? "bg-accent text-canvas"
                  : "bg-muted/60 text-white/70 hover:bg-muted/80"
              }`}
            >
              {CHANNEL_LABEL[c]}
            </button>
          );
        })}
        <span className="ml-auto text-[11px] uppercase tracking-wide text-white/40">
          Direction
        </span>
        {(["all", "inbound", "outbound"] as const).map((d) => (
          <button
            key={d}
            type="button"
            data-testid={`direction-filter-${d}`}
            data-active={direction === d}
            onClick={() => setDirection(d)}
            className={`rounded-full px-3 py-1 text-xs ${
              direction === d
                ? "bg-accent text-canvas"
                : "bg-muted/60 text-white/70 hover:bg-muted/80"
            }`}
          >
            {d === "all" ? "All" : d.slice(0, 1).toUpperCase() + d.slice(1)}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          Couldn&apos;t load inbox: {error}
        </div>
      )}

      {!loading && items.length === 0 && !error && (
        <div className="rounded-lg border border-line bg-muted/20 p-6 text-center text-sm text-white/50">
          No communications match these filters.
        </div>
      )}

      <ol className="flex flex-col gap-2">
        {items.map((item) =>
          item.kind === "call" ? (
            <CallRow key={item.id} item={item} />
          ) : (
            <TouchpointRow key={item.id} item={item} />
          ),
        )}
      </ol>

      {nextBefore && (
        <button
          type="button"
          onClick={() => void load(nextBefore, true)}
          disabled={loading}
          data-testid="load-more"
          className="mx-auto mt-2 rounded-md border border-line bg-muted/40 px-3 py-1.5 text-sm text-white/70 hover:bg-muted/60 disabled:opacity-50"
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}

function CallRow({ item }: { item: CallItem }): React.ReactElement {
  const terminal = isTerminalStatus(item.status);
  const href = item.workflowId
    ? `/app/calls/${item.workflowId}`
    : `/app/inbox/${item.id}`;
  return (
    <li data-testid="inbox-row" data-kind="call">
      <Link
        href={href}
        className="flex items-center justify-between gap-3 rounded-lg border border-line bg-muted/20 px-3 py-2.5 hover:bg-muted/40"
      >
        <div className="flex min-w-0 items-center gap-3">
          <ChannelIcon group="call" />
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm text-white">
              <span>Phone call</span>
              <StatusBadge status={item.status ?? "unknown"} />
            </div>
            <div className="mt-0.5 font-mono text-[11px] text-white/40">
              {item.callSid ?? item.id}
              {item.durationSeconds !== null && (
                <span className="ml-2">{formatDuration(item.durationSeconds)}</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-3 text-xs text-white/50">
          <span>{relTime(item.occurredAt)}</span>
          <span className="rounded-md border border-line px-2 py-1 text-white/70">
            {item.workflowId ? (terminal ? "View" : "Live →") : "Details →"}
          </span>
        </div>
      </Link>
    </li>
  );
}

function TouchpointRow({
  item,
}: {
  item: TouchpointItem;
}): React.ReactElement {
  const verb = item.channel.includes(".") ? item.channel.split(".", 2)[1] : null;
  return (
    <li
      data-testid="inbox-row"
      data-kind="touchpoint"
      className="flex items-center justify-between gap-3 rounded-lg border border-line bg-muted/20 px-3 py-2.5"
    >
      <div className="flex min-w-0 items-center gap-3">
        <ChannelIcon group={item.channelGroup} />
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-white">
            <span className="capitalize">{item.channelGroup}</span>
            {item.direction && <DirectionArrow direction={item.direction} />}
            {verb && <StatusBadge status={verb} />}
          </div>
          {item.preview && (
            <div className="mt-0.5 truncate text-xs text-white/60">
              {item.preview}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-3 text-xs text-white/50">
        <span>{relTime(item.occurredAt)}</span>
        {item.contactId && (
          <Link
            href={`/app/contacts/${item.contactId}`}
            className="rounded-md border border-line px-2 py-1 text-white/70 hover:bg-muted/40"
          >
            Contact
          </Link>
        )}
      </div>
    </li>
  );
}

function ChannelIcon({
  group,
}: {
  group: "email" | "sms" | "whatsapp" | "call" | "other";
}): React.ReactElement {
  const palette: Record<string, string> = {
    call: "bg-good/20 text-good",
    email: "bg-accent/20 text-accent",
    sms: "bg-warn/20 text-warn",
    whatsapp: "bg-good/20 text-good",
    other: "bg-muted text-white/60",
  };
  const glyph: Record<string, string> = {
    call: "☎",
    email: "✉",
    sms: "💬",
    whatsapp: "📱",
    other: "•",
  };
  return (
    <span
      aria-hidden="true"
      className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm ${palette[group] ?? palette["other"]}`}
    >
      {glyph[group] ?? glyph["other"]}
    </span>
  );
}

function DirectionArrow({
  direction,
}: {
  direction: DirectionFilter;
}): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      className={`text-[11px] ${direction === "inbound" ? "text-good" : "text-white/40"}`}
    >
      {direction === "inbound" ? "↙ in" : "↗ out"}
    </span>
  );
}

function StatusBadge({ status }: { status: string }): React.ReactElement {
  const palette: Record<string, string> = {
    sent: "bg-accent/20 text-accent",
    queued: "bg-warn/20 text-warn",
    delivered: "bg-accent/20 text-accent",
    opened: "bg-good/20 text-good",
    clicked: "bg-good/20 text-good",
    replied: "bg-good/20 text-good",
    bounced: "bg-bad/20 text-bad",
    failed: "bg-bad/20 text-bad",
    "in-progress": "bg-good/20 text-good",
    ringing: "bg-warn/20 text-warn",
    completed: "bg-muted/60 text-white/60",
    canceled: "bg-muted/60 text-white/60",
    busy: "bg-bad/20 text-bad",
    "no-answer": "bg-bad/20 text-bad",
  };
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] ${
        palette[status] ?? "bg-muted/60 text-white/70"
      }`}
    >
      {status}
    </span>
  );
}

function isTerminalStatus(status: string | null): boolean {
  if (!status) return false;
  return ["completed", "canceled", "busy", "failed", "no-answer"].includes(
    status,
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function relTime(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}
