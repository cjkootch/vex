"use client";

interface FallbackPanelProps {
  /** When the registry returned no match, the unsupported panel `type`. */
  type?: string;
  /** When ManifestValidator failed, the original answer text we still want
   *  to show the user instead of a blank canvas. */
  text?: string;
  /** When a panel threw at render time, the captured error message. */
  error?: string;
}

/**
 * The "always renders something" panel. Used in three situations:
 *   - registry has no component for the manifest's panel type
 *   - ManifestValidator rejected the model output (we show the raw text)
 *   - one of the registered panels threw at render time (PanelErrorBoundary)
 */
export function FallbackPanel({ type, text, error }: FallbackPanelProps) {
  return (
    <section
      data-panel="fallback"
      className="rounded-lg border border-line bg-muted/40 p-4 text-sm text-white/70"
    >
      <div className="mb-1 text-xs uppercase tracking-wider text-white/40">
        {error ? "Panel error" : type ? "Unsupported panel" : "Answer"}
      </div>
      {type && (
        <div className="mb-2">
          Panel type not supported: <code className="text-white/90">{type}</code>
        </div>
      )}
      {error && (
        <div className="mb-2 text-bad/90">
          Render failed: <code className="text-bad">{error}</code>
        </div>
      )}
      {text && <p className="whitespace-pre-wrap text-white/90">{text}</p>}
    </section>
  );
}
