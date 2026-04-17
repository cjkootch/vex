"use client";

import { useEffect, useState } from "react";

export interface ActivityEvent {
  id: string;
  verb: string;
  subjectType: string;
  subjectId: string;
  actorType: string | null;
  actorId: string | null;
  objectType: string | null;
  objectId: string | null;
  occurredAt: string;
  metadata: Record<string, unknown>;
}

export interface ActivityTimelineProps {
  subjectType: string;
  subjectId: string;
  /** Max rows to show before "load more". Defaults to 10. */
  pageSize?: number;
}

/**
 * Read-only audit timeline for a single subject. Reads `/api/events`
 * and renders newest-first. Each verb gets a short human label +
 * optional metadata summary (e.g. deal ref, from→to status).
 */
export function ActivityTimeline({
  subjectType,
  subjectId,
  pageSize = 10,
}: ActivityTimelineProps) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    fetch(
      `/api/events?subject_type=${encodeURIComponent(subjectType)}&subject_id=${encodeURIComponent(subjectId)}&limit=${pageSize}`,
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
      })
      .then((body: { events: ActivityEvent[] }) => {
        if (cancelled) return;
        setEvents(body.events);
        setHasMore(body.events.length >= pageSize);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
          setEvents([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [subjectType, subjectId, pageSize]);

  async function loadMore(): Promise<void> {
    if (!events || events.length === 0 || loadingMore) return;
    setLoadingMore(true);
    try {
      const oldest = events[events.length - 1];
      const res = await fetch(
        `/api/events?subject_type=${encodeURIComponent(subjectType)}&subject_id=${encodeURIComponent(subjectId)}&limit=${pageSize}&before=${encodeURIComponent(oldest!.occurredAt)}`,
      );
      if (!res.ok) throw new Error(`${res.status}`);
      const body = (await res.json()) as { events: ActivityEvent[] };
      setEvents((prev) => [...(prev ?? []), ...body.events]);
      setHasMore(body.events.length >= pageSize);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  if (events === null) {
    return (
      <div className="rounded-md border border-line bg-muted/20 px-3 py-4 text-sm text-white/40">
        Loading activity…
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="rounded-md border border-line bg-muted/20 px-3 py-4 text-sm text-white/50">
        No activity yet. Every mutation recorded on this record will appear here.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <div className="rounded-md border border-bad/40 bg-bad/10 px-2 py-1 text-xs text-bad">
          {error}
        </div>
      )}

      <ol className="flex flex-col">
        {events.map((event) => (
          <EventRow key={event.id} event={event} />
        ))}
      </ol>

      {hasMore && (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className="mt-1 self-start rounded-md border border-line px-3 py-1 text-xs text-white/70 hover:border-accent hover:text-white disabled:opacity-40"
        >
          {loadingMore ? "Loading…" : "Load older"}
        </button>
      )}
    </div>
  );
}

function EventRow({ event }: { event: ActivityEvent }) {
  return (
    <li className="flex items-start gap-3 border-l-2 border-line py-2 pl-4">
      <div className="flex-1 text-sm">
        <div className="font-medium text-white/90">{verbLabel(event.verb)}</div>
        <div className="mt-0.5 text-xs text-white/50">
          {formatActor(event.actorType, event.actorId)} · {formatRelative(event.occurredAt)}
        </div>
        {renderMetadata(event)}
      </div>
    </li>
  );
}

const VERB_LABELS: Record<string, string> = {
  "deal.created": "Deal created",
  "deal.evaluated": "Deal evaluated",
  "deal.status_changed": "Status changed",
  "deal.status_change_requested": "Status-change approval requested",
  "contact.created": "Contact created",
  "contact.opted_out": "Contact opted out",
  "contact.membership_added": "Company membership added",
  "contact.membership_removed": "Company membership removed",
  "contact.primary_changed": "Primary company changed",
  "organization.created": "Company created",
  "approval.executor.received": "Approval routed to executor",
  "approval.executor.failed": "Approval executor failed",
};

function verbLabel(verb: string): string {
  return VERB_LABELS[verb] ?? verb;
}

function formatActor(actorType: string | null, actorId: string | null): string {
  if (!actorType) return "system";
  if (actorType === "user" && actorId)
    return `user ${actorId.slice(-6)}`;
  if (actorType === "agent" && actorId) return `${actorId} agent`;
  if (actorType === "system") return "system";
  return actorType;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function renderMetadata(event: ActivityEvent) {
  const md = event.metadata ?? {};
  const bits: string[] = [];
  const from = md["from_status"];
  const to = md["to_status"];
  if (typeof from === "string" && typeof to === "string") {
    bits.push(`${from} → ${to}`);
  }
  const rationale = md["rationale"];
  if (typeof rationale === "string" && rationale.trim().length > 0) {
    bits.push(`“${rationale}”`);
  }
  const reason = md["reason"];
  if (typeof reason === "string" && reason.trim().length > 0) {
    bits.push(`reason: ${reason}`);
  }
  const score = md["score"];
  if (typeof score === "number") bits.push(`score ${score}`);
  const recommendation = md["recommendation"];
  if (typeof recommendation === "string") bits.push(recommendation);
  if (bits.length === 0) return null;
  return (
    <div className="mt-0.5 text-xs text-white/60">{bits.join(" · ")}</div>
  );
}
