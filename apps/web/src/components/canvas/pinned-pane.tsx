"use client";

import { AnimatePresence, motion } from "framer-motion";
import { usePinnedPanels } from "@/lib/pinned-panels";
import { PanelErrorBoundary } from "./panel-error-boundary";
import { resolvePanel } from "./registry";

/**
 * Right-side "pinned dashboard" pane. Hidden when no panels are
 * pinned. Each pinned panel re-renders via the same registry the
 * inline manifest uses, so the visual is identical to the source
 * panel in the chat thread.
 */
export function PinnedPane() {
  const { pins, unpin, clear } = usePinnedPanels();

  if (pins.length === 0) return null;

  return (
    <aside
      aria-label="Pinned panels"
      className="hidden w-[340px] flex-shrink-0 flex-col border-l border-line bg-canvas/40 lg:flex"
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-white/50">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
          Pinned · {pins.length}
        </div>
        <button
          type="button"
          onClick={clear}
          className="text-[10px] uppercase tracking-wider text-white/40 hover:text-bad"
        >
          Clear
        </button>
      </div>

      <div className="flex flex-col gap-3 overflow-y-auto px-3 py-3">
        <AnimatePresence initial={false}>
          {pins.map((p) => {
            const panelType = ((p.panel as { type?: string }).type ??
              "") as Parameters<typeof resolvePanel>[0];
            const Component = resolvePanel(
              panelType,
            ) as React.ComponentType<Record<string, unknown>>;
            return (
              <motion.div
                key={p.id}
                layout
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 16 }}
                transition={{ duration: 0.2 }}
                className="relative rounded-md border border-line bg-canvas/80"
              >
                <button
                  type="button"
                  onClick={() => unpin(p.id)}
                  className="absolute right-2 top-2 z-10 rounded border border-line bg-canvas/80 px-1.5 py-0.5 text-[10px] text-white/60 hover:border-bad hover:text-bad"
                  aria-label="Unpin"
                >
                  × unpin
                </button>
                <PanelErrorBoundary panelType={p.label}>
                  <Component {...(p.panel as Record<string, unknown>)} />
                </PanelErrorBoundary>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </aside>
  );
}
