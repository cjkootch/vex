"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "framer-motion";

// Leaflet touches `window` on import, so the map component must render
// client-side only. Dynamic import with ssr:false keeps the route-map
// panel usable during SSR + handles the bundle split automatically.
const RouteMapLeaflet = dynamic(() => import("./route-map-leaflet"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-xs text-white/40">
      Loading map…
    </div>
  ),
});

interface RoutePoint {
  label: string;
  lat: number;
  lon: number;
}

interface DealMeta {
  ref?: string | undefined;
  product?: string | undefined;
  volume?: string | undefined;
  status?: string | undefined;
  laycan?: string | undefined;
}

export interface RouteMapPanelProps {
  title?: string | undefined;
  origin: RoutePoint;
  destination: RoutePoint;
  deal?: DealMeta | undefined;
}

/**
 * Trade-lane visualizer. The inline panel renders a 2:1 slippy map
 * (CartoDB Dark Matter tiles, no API key) centred on the route. Click
 * "Expand" → full-screen modal with scroll-wheel zoom + Leaflet's
 * zoom controls, for when the operator wants to actually poke at the
 * map. Closes on Escape or scrim click.
 */
export function RouteMapPanel({
  title,
  origin,
  destination,
  deal,
}: RouteMapPanelProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <section className="overflow-hidden rounded-lg border border-line bg-muted/20">
        <header className="flex items-center justify-between border-b border-line px-3 py-2">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/50">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            {title ?? "Trade lane"}
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] text-white/40">
              {origin.label} → {destination.label}
            </span>
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="rounded border border-line bg-canvas/60 px-1.5 py-0.5 font-mono text-[10px] text-white/60 transition-colors hover:border-accent hover:text-accent"
              title="Expand map"
              aria-label="Expand map"
            >
              ⤢ expand
            </button>
          </div>
        </header>

        <div
          className={
            deal
              ? "grid grid-cols-1 lg:grid-cols-[1fr_220px]"
              : "grid grid-cols-1"
          }
        >
          <div className="relative aspect-[2/1] bg-canvas/60">
            <RouteMapLeaflet origin={origin} destination={destination} />
          </div>

          {deal && (
            <aside className="border-t border-line bg-canvas/40 p-3 text-sm lg:border-l lg:border-t-0">
              <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/50">
                Deal
              </div>
              <dl className="grid grid-cols-[80px_1fr] gap-y-1.5 text-[12px]">
                {deal.ref && (
                  <>
                    <dt className="text-white/50">Ref</dt>
                    <dd className="font-mono text-white">{deal.ref}</dd>
                  </>
                )}
                {deal.product && (
                  <>
                    <dt className="text-white/50">Product</dt>
                    <dd className="text-white">{deal.product}</dd>
                  </>
                )}
                {deal.volume && (
                  <>
                    <dt className="text-white/50">Volume</dt>
                    <dd className="text-white">{deal.volume}</dd>
                  </>
                )}
                {deal.status && (
                  <>
                    <dt className="text-white/50">Status</dt>
                    <dd className="text-white">{deal.status}</dd>
                  </>
                )}
                {deal.laycan && (
                  <>
                    <dt className="text-white/50">Laycan</dt>
                    <dd className="text-white">{deal.laycan}</dd>
                  </>
                )}
              </dl>
            </aside>
          )}
        </div>
      </section>

      <AnimatePresence>
        {expanded ? (
          <ExpandedMap
            key="route-map-expanded"
            title={title}
            origin={origin}
            destination={destination}
            onClose={() => setExpanded(false)}
          />
        ) : null}
      </AnimatePresence>
    </>
  );
}

function ExpandedMap({
  title,
  origin,
  destination,
  onClose,
}: {
  title?: string | undefined;
  origin: RoutePoint;
  destination: RoutePoint;
  onClose: () => void;
}) {
  // Close on Escape — common modal affordance.
  if (typeof window !== "undefined") {
    // No effect needed; inline keydown handler on the backdrop is sufficient.
  }
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="fixed inset-0 z-[60] flex flex-col bg-black/70 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      tabIndex={-1}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.97 }}
        transition={{ type: "spring", stiffness: 320, damping: 30 }}
        className="mx-auto my-6 flex h-[calc(100vh-3rem)] w-[calc(100vw-3rem)] max-w-[1400px] flex-col overflow-hidden rounded-lg border border-line bg-canvas shadow-2xl"
      >
        <header className="flex flex-shrink-0 items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-white">
              {title ?? "Trade lane"}
            </span>
            <span className="font-mono text-xs text-white/50">
              {origin.label} → {destination.label}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close expanded map"
            className="rounded border border-line px-2 py-1 text-xs text-white/60 transition-colors hover:border-accent hover:text-accent"
          >
            Close ✕
          </button>
        </header>
        <div className="flex-1">
          <RouteMapLeaflet origin={origin} destination={destination} expanded />
        </div>
      </motion.div>
    </motion.div>
  );
}
