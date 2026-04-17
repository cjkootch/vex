"use client";

import type { ManifestPanel } from "@vex/ui";

type VoiceSessionProps = Extract<ManifestPanel, { type: "voice_session" }>;

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export function VoiceSessionPanel({
  sessionId,
  durationSeconds,
  status,
  summary,
  actionItemsCount,
}: VoiceSessionProps) {
  const statusLabel = status === "processing" ? "Processing…" : "Ready";
  return (
    <section
      data-panel="voice_session"
      className="rounded-lg border border-line bg-muted/40 p-4"
    >
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span aria-hidden className="h-2 w-2 rounded-full bg-white/70" />
          <span className="text-sm font-semibold text-white">Voice call</span>
          <span className="text-xs text-white/50">·</span>
          <span className="text-xs text-white/60">{formatDuration(durationSeconds)}</span>
        </div>
        <span className="text-xs text-white/50">{statusLabel}</span>
      </header>

      <p className="mt-3 text-sm leading-relaxed text-white/80">{summary}</p>

      <footer className="mt-3 flex items-center justify-between text-xs text-white/50">
        <code className="text-[11px] text-white/40">{sessionId}</code>
        <a
          href="/app/approvals"
          className="rounded border border-line px-2 py-1 text-white/70 hover:border-white/30 hover:text-white"
        >
          {actionItemsCount} action {actionItemsCount === 1 ? "item" : "items"} →
        </a>
      </footer>
    </section>
  );
}
