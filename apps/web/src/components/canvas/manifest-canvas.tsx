"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  WORKSPACE_MODE_CONFIGS,
  formatVexCopy,
  validateManifest,
  vexCopy,
  type ManifestPanel,
  type WorkspaceMode,
} from "@vex/ui";
import { useWorkspaceMode } from "@/lib/workspace-mode-context";
import {
  panelLabel,
  panelPinId,
  usePinnedPanels,
} from "@/lib/pinned-panels";
import { resolvePanel } from "./registry";
import { PanelErrorBoundary } from "./panel-error-boundary";
import { FallbackPanel } from "./panels/fallback-panel";

interface Props {
  manifest: unknown;
  rawAnswer?: string;
}

interface ModeSwitchSignal {
  mode: WorkspaceMode;
  contextId?: string;
  contextLabel?: string;
  reason?: string;
}

// How long the mode-switch toast stays on screen (fade-in + hold + fade-out).
const TOAST_DURATION_MS = 3000;

/**
 * Single entry point for rendering a model-produced manifest.
 *
 * Pipeline:
 *   1. Validate via ManifestValidator. On failure, render a single
 *      FallbackPanel with the raw answer text.
 *   2. Intercept `workspace_mode_switch` signal panels — they never
 *      render in the thread; instead they call setMode on the workspace
 *      context and surface a brief Framer Motion toast.
 *   3. Resolve every other panel through the ComponentRegistry; the
 *      workspace_mode_switch registry entry returns null so a stray
 *      signal that escapes the filter never draws stray JSON.
 *   4. Wrap each panel in PanelErrorBoundary; animate with a stagger.
 */
export function ManifestCanvas({ manifest, rawAnswer }: Props) {
  const result = validateManifest(manifest);
  const { setMode } = useWorkspaceMode();
  const [toast, setToast] = useState<string | null>(null);

  // Extract the latest mode-switch signal (the last one in the manifest
  // wins when multiple are present — matches a streaming model that
  // may revise course mid-response).
  const signal = useMemo<ModeSwitchSignal | null>(() => {
    if (!result.success) return null;
    for (let i = result.manifest.panels.length - 1; i >= 0; i--) {
      const p = result.manifest.panels[i]!;
      if (p.type === "workspace_mode_switch") {
        return {
          mode: p.mode as WorkspaceMode,
          ...(p.contextId !== undefined ? { contextId: p.contextId } : {}),
          ...(p.contextLabel !== undefined
            ? { contextLabel: p.contextLabel }
            : {}),
          ...(p.reason !== undefined ? { reason: p.reason } : {}),
        };
      }
    }
    return null;
  }, [result]);

  // Stable identity so the effect fires once per distinct signal — a
  // re-render with the same manifest shouldn't re-trigger setMode.
  const signalKey = signal
    ? `${signal.mode}|${signal.contextId ?? ""}|${signal.contextLabel ?? ""}|${signal.reason ?? ""}`
    : null;
  const lastKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!signal || signalKey === lastKeyRef.current) return;
    lastKeyRef.current = signalKey;
    setMode(signal.mode, signal.contextId, signal.contextLabel);
    setToast(reasonText(signal));
    const t = window.setTimeout(() => setToast(null), TOAST_DURATION_MS);
    return () => window.clearTimeout(t);
  }, [signal, signalKey, setMode]);

  if (!result.success) {
    return (
      <div data-canvas="invalid" className="space-y-3">
        <FallbackPanel
          type="(validation failed)"
          text={rawAnswer ?? "Vex couldn't compose a response."}
          error={result.error.slice(0, 200)}
        />
      </div>
    );
  }

  // Drop signal panels before rendering — the registry entry returns
  // null for them anyway, but filtering avoids empty <motion.div> shells
  // in the thread layout.
  const visible = result.manifest.panels.filter(
    (p) => p.type !== "workspace_mode_switch",
  );

  return (
    <div data-canvas="valid" className="relative space-y-3">
      <AnimatePresence>
        {toast !== null ? (
          <motion.div
            key="mode-switch-toast"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25 }}
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute -top-10 left-1/2 z-10 -translate-x-1/2 rounded-full border border-line bg-muted/80 px-3 py-1.5 text-xs text-white/80 backdrop-blur"
          >
            {toast}
          </motion.div>
        ) : null}
      </AnimatePresence>
      {visible.map((panel, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, y: 14, scale: 0.97, filter: "blur(4px)" }}
          animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
          transition={{
            type: "spring",
            stiffness: 220,
            damping: 26,
            mass: 0.7,
            delay: i * 0.07,
          }}
          className="relative origin-top"
        >
          <PinButton panel={panel} />
          <PanelErrorBoundary panelType={panel.type}>
            <PanelHost panel={panel} />
          </PanelErrorBoundary>
        </motion.div>
      ))}
    </div>
  );
}

function PanelHost({ panel }: { panel: ManifestPanel }) {
  const Component = resolvePanel(panel.type) as React.ComponentType<
    Record<string, unknown>
  >;
  return <Component {...(panel as unknown as Record<string, unknown>)} />;
}

/**
 * Floating pin button over the top-right corner of each panel.
 * Click to pin the panel into the persistent right-side dashboard
 * (see PinnedPane). Content-hash id keeps re-pins idempotent.
 */
function PinButton({ panel }: { panel: ManifestPanel }) {
  const { isPinned, pin, unpin } = usePinnedPanels();
  const id = panelPinId(panel);
  const pinned = isPinned(id);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (pinned) {
          unpin(id);
        } else {
          pin({
            id,
            panel,
            pinnedAt: new Date().toISOString(),
            label: panelLabel(panel),
          });
        }
      }}
      title={pinned ? "Unpin" : "Pin to dashboard"}
      aria-label={pinned ? "Unpin panel" : "Pin panel"}
      className={`absolute right-2 top-2 z-10 rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
        pinned
          ? "border-accent/60 bg-accent/20 text-accent"
          : "border-line bg-canvas/60 text-white/50 hover:border-accent hover:text-accent"
      }`}
    >
      {pinned ? "◆ pinned" : "◇ pin"}
    </button>
  );
}

/**
 * Compose the toast text. When the model provides `reason`, surface it
 * verbatim — it's written in the Vex voice. Otherwise build a default
 * "Switching to {mode} · {context}" line, falling back to the
 * context_chip_mode vexCopy template when no context is known.
 */
function reasonText(signal: ModeSwitchSignal): string {
  if (signal.reason && signal.reason.length > 0) return signal.reason;
  const label = WORKSPACE_MODE_CONFIGS[signal.mode].label;
  if (signal.contextLabel) return `Switching to ${label} · ${signal.contextLabel}`;
  return formatVexCopy(vexCopy.navigation.context_chip_mode, { mode: label });
}
