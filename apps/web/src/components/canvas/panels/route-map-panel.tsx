"use client";

import { useId } from "react";

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
 * Route map widget — Meridian's "show the trade lane" pattern.
 * Renders origin + destination pins on a stylized world map with a
 * curved great-circle-ish arc between them, plus optional deal
 * metadata in a side rail.
 *
 * The map is a public-domain Natural Earth-derived continents
 * silhouette, simplified to ~2KB of SVG path. Equirectangular
 * projection (lon → x, lat → y) — fine for the demo + matches the
 * coordinate system the path was simplified into.
 */
export function RouteMapPanel({
  title,
  origin,
  destination,
  deal,
}: RouteMapPanelProps) {
  const gradId = useId().replace(/:/g, "");
  const o = project(origin);
  const d = project(destination);
  const arc = arcPath(o, d);

  return (
    <section className="overflow-hidden rounded-lg border border-line bg-muted/20">
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/50">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          {title ?? "Trade lane"}
        </div>
        <span className="font-mono text-[10px] text-white/40">
          {origin.label} → {destination.label}
        </span>
      </header>

      <div
        className={
          deal
            ? "grid grid-cols-1 lg:grid-cols-[1fr_220px]"
            : "grid grid-cols-1"
        }
      >
        <div className="relative aspect-[2/1] bg-canvas/60">
          <svg
            viewBox="0 0 1000 500"
            className="absolute inset-0 h-full w-full"
            preserveAspectRatio="xMidYMid meet"
          >
            <defs>
              <linearGradient id={`${gradId}-arc`} x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="currentColor" stopOpacity="0.2" />
                <stop offset="50%" stopColor="currentColor" stopOpacity="1" />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0.2" />
              </linearGradient>
              <radialGradient id={`${gradId}-glow`}>
                <stop offset="0%" stopColor="currentColor" stopOpacity="0.5" />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
              </radialGradient>
            </defs>

            {/* Continents silhouette — desaturated so pins + arc dominate. */}
            <g
              className="text-white/15"
              fill="currentColor"
              fillRule="evenodd"
            >
              <path d={CONTINENTS_PATH} />
            </g>

            {/* Faint graticule — three latitude lines + meridian. */}
            <g
              className="text-white/8"
              stroke="currentColor"
              strokeWidth="0.6"
              fill="none"
            >
              <line x1="0" y1="125" x2="1000" y2="125" />
              <line x1="0" y1="250" x2="1000" y2="250" />
              <line x1="0" y1="375" x2="1000" y2="375" />
              <line x1="500" y1="0" x2="500" y2="500" />
            </g>

            {/* Route arc */}
            <g className="text-accent">
              <path
                d={arc}
                stroke={`url(#${gradId}-arc)`}
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeDasharray="4 6"
              >
                <animate
                  attributeName="stroke-dashoffset"
                  from="0"
                  to="-20"
                  dur="2s"
                  repeatCount="indefinite"
                />
              </path>
            </g>

            {/* Origin pin (accent) */}
            <Pin
              x={o.x}
              y={o.y}
              tone="accent"
              label={origin.label}
              align="left"
            />
            {/* Destination pin (warn) */}
            <Pin
              x={d.x}
              y={d.y}
              tone="warn"
              label={destination.label}
              align="right"
            />
          </svg>
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
  );
}

interface Projected {
  x: number;
  y: number;
}

/** Equirectangular projection over a 1000×500 viewBox. */
function project(p: { lat: number; lon: number }): Projected {
  return {
    x: ((p.lon + 180) / 360) * 1000,
    y: ((90 - p.lat) / 180) * 500,
  };
}

/**
 * Quadratic bezier with control point pulled "north" of the
 * midpoint for an arc that suggests a great-circle without doing
 * the spherical math. Northern routes arc north, southern arc
 * south — purely cosmetic.
 */
function arcPath(a: Projected, b: Projected): string {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  // Lift the control point perpendicular to the segment, north on
  // northern-hemisphere routes (smaller y).
  const lift = Math.min(120, distance * 0.25);
  const direction = my < 250 ? -1 : 1;
  const perpY = my + direction * lift;
  // Bias the perpendicular slightly so vertical routes still curve.
  const perpX = mx + (dx / distance || 0) * 8;
  return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${perpX.toFixed(1)} ${perpY.toFixed(1)}, ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

function Pin({
  x,
  y,
  tone,
  label,
  align,
}: {
  x: number;
  y: number;
  tone: "accent" | "warn";
  label: string;
  align: "left" | "right";
}) {
  const colorClass = tone === "warn" ? "text-warn" : "text-accent";
  const labelX = align === "left" ? x + 10 : x - 10;
  const anchor = align === "left" ? "start" : "end";
  return (
    <g className={colorClass}>
      <circle cx={x} cy={y} r="14" fill="currentColor" opacity="0.18">
        <animate
          attributeName="r"
          from="10"
          to="22"
          dur="2.4s"
          repeatCount="indefinite"
        />
        <animate
          attributeName="opacity"
          from="0.35"
          to="0"
          dur="2.4s"
          repeatCount="indefinite"
        />
      </circle>
      <circle cx={x} cy={y} r="5" fill="currentColor" />
      <text
        x={labelX}
        y={y + 3}
        textAnchor={anchor}
        className="fill-current font-mono text-[11px]"
      >
        {label}
      </text>
    </g>
  );
}

// Public-domain Natural Earth-derived simplified continents path,
// projected to the same 1000×500 equirectangular viewBox the pins
// use. Kept as a single string to avoid adding a topojson dep.
const CONTINENTS_PATH =
  // North America
  "M 105 100 L 230 95 L 295 130 L 310 175 L 290 215 L 250 240 L 200 245 L 175 230 L 145 195 L 120 165 L 100 130 Z " +
  // Central America + Caribbean band
  "M 250 245 L 285 260 L 295 285 L 270 300 L 240 280 L 235 260 Z " +
  // South America
  "M 285 295 L 325 310 L 345 360 L 335 410 L 305 440 L 280 425 L 270 380 L 275 335 Z " +
  // Europe
  "M 470 110 L 540 100 L 565 140 L 555 175 L 510 185 L 475 165 L 460 135 Z " +
  // Africa
  "M 490 200 L 565 200 L 595 245 L 590 305 L 555 360 L 520 365 L 490 320 L 475 270 L 480 230 Z " +
  // Middle East / Asia mainland
  "M 575 145 L 720 130 L 815 165 L 850 215 L 815 260 L 750 270 L 690 250 L 625 230 L 595 195 L 580 170 Z " +
  // Southeast Asia / India peninsula
  "M 720 270 L 770 285 L 790 320 L 760 340 L 720 320 L 705 295 Z " +
  // Australia
  "M 825 360 L 910 355 L 935 395 L 905 425 L 850 425 L 820 395 Z";
