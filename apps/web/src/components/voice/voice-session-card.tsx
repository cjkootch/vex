"use client";

interface Props {
  sessionId: string;
  durationSeconds: number;
  status: "processing" | "processed";
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * Compact post-call card shown inline on /app/voice. Mirrors the
 * `voice_session` ViewManifest panel so the canvas and the voice page
 * render the same shape.
 */
export function VoiceSessionCard({ sessionId, durationSeconds, status }: Props) {
  return (
    <section className="rounded-lg border border-line bg-muted/40 p-4">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span aria-hidden className="h-2 w-2 rounded-full bg-white/70" />
          <span className="text-sm font-semibold text-white">Voice call</span>
          <span className="text-xs text-white/50">·</span>
          <span className="text-xs text-white/60">{formatDuration(durationSeconds)}</span>
        </div>
        <span className="text-xs text-white/50">
          {status === "processing" ? "Processing…" : "Ready"}
        </span>
      </header>
      <p className="mt-3 text-sm text-white/70">
        {status === "processing"
          ? "Vex is summarising the call and extracting action items."
          : "Summary stored on the activity timeline. Review action items in the approvals inbox."}
      </p>
      <footer className="mt-3 flex items-center justify-between text-xs">
        <code className="text-[11px] text-white/40">{sessionId}</code>
        <a
          href="/app/approvals"
          className="rounded border border-line px-2 py-1 text-white/70 hover:border-white/30 hover:text-white"
        >
          Open approvals →
        </a>
      </footer>
    </section>
  );
}
