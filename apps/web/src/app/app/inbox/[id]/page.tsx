"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";

/**
 * /app/inbox/:id — activity drill-in.
 *
 * Renders the raw voice_call (or touchpoint-linked activity) row:
 * status + duration, contact link if one is attached, recording
 * playback link if Twilio's recording webhook has fired, and a full
 * metadata dump for operator triage.
 *
 * Polls every 3s while the status is non-terminal so demo calls can
 * progress queued → ringing → in-progress → completed without a page
 * reload.
 */

const TERMINAL_STATUSES = new Set([
  "completed",
  "canceled",
  "busy",
  "failed",
  "no-answer",
]);
const POLL_MS = 3_000;

interface ActivityDetail {
  id: string;
  type: string;
  occurredAt: string;
  result: string | null;
  durationSeconds: number | null;
  transcriptRef: string | null;
  metadata: Record<string, unknown>;
  relatedObjectIds: Record<string, unknown>;
}

export default function InboxDetailPage({
  params,
}: {
  params: { id: string };
}): React.ReactElement {
  const [detail, setDetail] = useState<ActivityDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/communications/activities/${params.id}`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as ActivityDetail;
      setDetail(body);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!detail) return;
    if (detail.result && TERMINAL_STATUSES.has(detail.result)) return;
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [detail, load]);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          Couldn&apos;t load activity: {error}
        </div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8 text-sm text-white/50">
        Loading…
      </div>
    );
  }

  const meta = detail.metadata;
  const related = detail.relatedObjectIds;
  const callSid = typeof meta["call_sid"] === "string" ? meta["call_sid"] : null;
  const recordingUrl =
    typeof meta["recording_url"] === "string" ? meta["recording_url"] : null;
  const recordingDuration =
    typeof meta["recording_duration_seconds"] === "number"
      ? meta["recording_duration_seconds"]
      : null;
  const toNumber =
    typeof meta["to_number"] === "string" ? meta["to_number"] : null;
  const fromNumber =
    typeof meta["from_number"] === "string" ? meta["from_number"] : null;
  const demoMode = typeof meta["demo_mode"] === "string" ? meta["demo_mode"] : null;
  const contactId =
    typeof related["contact_id"] === "string" ? related["contact_id"] : null;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <Link
            href="/app/inbox"
            className="text-xs text-white/50 hover:text-white/80"
          >
            ← Inbox
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-white">
            {detail.type === "voice_call" ? "Phone call" : detail.type}
          </h1>
          <p className="mt-1 text-xs text-white/50">
            {formatDistanceToNow(new Date(detail.occurredAt), { addSuffix: true })}
            {callSid && <span className="ml-2 font-mono">· {callSid}</span>}
          </p>
        </div>
        <StatusPill status={detail.result ?? "unknown"} />
      </header>

      <section className="grid grid-cols-2 gap-3 rounded-lg border border-line bg-muted/20 p-4 text-sm">
        {toNumber && <Field label="To" value={toNumber} mono />}
        {fromNumber && <Field label="From" value={fromNumber} mono />}
        {demoMode && <Field label="Mode" value={demoMode} />}
        {detail.durationSeconds !== null && (
          <Field
            label="Duration"
            value={formatDuration(detail.durationSeconds)}
          />
        )}
        {contactId && (
          <div className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-white/40">
              Contact
            </span>
            <Link
              href={`/app/contacts/${contactId}`}
              className="w-fit rounded-md border border-line bg-muted/40 px-2 py-1 font-mono text-xs text-white/80 hover:bg-muted/60"
            >
              {contactId} →
            </Link>
          </div>
        )}
      </section>

      {recordingUrl ? (
        <section className="rounded-lg border border-line bg-muted/20 p-4">
          <div className="text-[11px] uppercase tracking-wide text-white/40">
            Recording
          </div>
          <audio
            controls
            src={`${recordingUrl}.mp3`}
            className="mt-2 w-full"
            data-testid="activity-recording"
          />
          <div className="mt-2 flex items-center gap-3 text-xs text-white/50">
            <a
              href={`${recordingUrl}.mp3`}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-white/80"
            >
              Open in new tab
            </a>
            {recordingDuration !== null && (
              <span>{recordingDuration}s</span>
            )}
          </div>
        </section>
      ) : (
        detail.type === "voice_call" &&
        detail.result &&
        TERMINAL_STATUSES.has(detail.result) && (
          <section className="rounded-lg border border-line bg-muted/10 p-4 text-xs text-white/50">
            No recording URL attached. If recording was enabled, Twilio&apos;s
            recording callback may still be pending (up to ~30s after the
            call ends).
          </section>
        )
      )}

      {typeof meta["script"] === "string" && (
        <section className="rounded-lg border border-line bg-muted/20 p-4">
          <div className="text-[11px] uppercase tracking-wide text-white/40">
            Script
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-white/80">
            {meta["script"] as string}
          </p>
        </section>
      )}

      <section className="rounded-lg border border-line bg-muted/10 p-4">
        <div className="text-[11px] uppercase tracking-wide text-white/40">
          Raw metadata
        </div>
        <pre className="mt-2 overflow-x-auto text-[11px] text-white/60">
          {JSON.stringify(detail.metadata, null, 2)}
        </pre>
      </section>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wide text-white/40">
        {label}
      </span>
      <span className={`text-sm text-white/80 ${mono ? "font-mono" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function StatusPill({ status }: { status: string }): React.ReactElement {
  const palette: Record<string, string> = {
    queued: "bg-warn/20 text-warn",
    ringing: "bg-warn/20 text-warn",
    "in-progress": "bg-good/20 text-good",
    completed: "bg-muted/60 text-white/80",
    canceled: "bg-muted/60 text-white/60",
    busy: "bg-bad/20 text-bad",
    failed: "bg-bad/20 text-bad",
    "no-answer": "bg-bad/20 text-bad",
  };
  return (
    <span
      className={`rounded px-2 py-1 text-xs ${palette[status] ?? "bg-muted/60 text-white/70"}`}
    >
      {status}
    </span>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
