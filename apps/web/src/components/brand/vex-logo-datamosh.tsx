"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { VexLogoPaths } from "./vex-logo";

export interface VexLogoDatamoshProps {
  /**
   * Glitch intensity 0..1. 0 = static logo, 1 = full RGB separation /
   * slab tears. Defaults to 0.35 — noticeable without being loud.
   */
  intensity?: number;
  /** Loop duration in milliseconds. Defaults to 6000. */
  loopDurationMs?: number;
  /** Number of slab-tear clip pool slots. 8 is the original config. */
  slabCount?: number;
  className?: string;
  /** Optional title for screen readers. */
  title?: string;
}

interface SlabState {
  y: number;
  h: number;
  dx: number;
  opacity: number;
}

/**
 * React port of the three-layer datamosh effect:
 *   - RGB channel separation (three offset coloured copies of the logo)
 *   - Horizontal slab tears (random clipped slices translated laterally)
 *   - Occasional bright static bars at peak glitch
 *
 * Rendered entirely in SVG so it scales, animates on a single rAF
 * loop, and doesn't need a canvas context. Registers one
 * requestAnimationFrame that writes DOM attributes via refs to avoid
 * React re-renders inside the loop.
 */
export function VexLogoDatamosh({
  intensity = 0.35,
  loopDurationMs = 6000,
  slabCount = 8,
  className,
  title = "Vex",
}: VexLogoDatamoshProps) {
  const baseId = useId().replace(/:/g, "");
  const aRRef = useRef<SVGGElement | null>(null);
  const aGRef = useRef<SVGGElement | null>(null);
  const aBRef = useRef<SVGGElement | null>(null);
  const mainRef = useRef<SVGGElement | null>(null);
  const slabRefs = useRef<
    Array<{
      g: SVGGElement | null;
      rect: SVGRectElement | null;
    }>
  >([]);
  const staticRef = useRef<SVGGElement | null>(null);

  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent): void => setReducedMotion(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const slabIndexes = useMemo(
    () => Array.from({ length: slabCount }, (_, i) => i),
    [slabCount],
  );

  useEffect(() => {
    if (reducedMotion) return;
    let raf = 0;
    const start = performance.now();
    let lastShuffle = -1;
    let lastStatic = -1;
    const slabStates: SlabState[] = slabIndexes.map(() => ({
      y: 0,
      h: 0,
      dx: 0,
      opacity: 0,
    }));

    function frame(now: number): void {
      const elapsed = (now - start) % loopDurationMs;
      const t = elapsed / loopDurationMs; // 0..1
      // Smooth envelope — quiet at t=0 and t=1, peak at t=0.5.
      const env = Math.sin(t * Math.PI);
      const amp = env * intensity;

      const dx = amp * 28;
      aRRef.current?.setAttribute("transform", `translate(${-dx} ${amp * 2})`);
      aGRef.current?.setAttribute("transform", `translate(${dx * 0.3} 0)`);
      aBRef.current?.setAttribute("transform", `translate(${dx} ${-amp * 2})`);
      aRRef.current?.setAttribute("opacity", String(0.55 * env));
      aGRef.current?.setAttribute("opacity", String(0.25 * env));
      aBRef.current?.setAttribute("opacity", String(0.55 * env));
      mainRef.current?.setAttribute("opacity", String(1 - env * 0.2));

      // Slab tears — re-shuffle 6 times per loop.
      const phase = Math.floor(t * 6);
      if (phase !== lastShuffle) {
        lastShuffle = phase;
        slabStates.forEach((s, i) => {
          const ref = slabRefs.current[i];
          if (!ref?.g || !ref.rect) return;
          if (Math.random() < 0.4 + amp * 0.4) {
            s.y = Math.random() * 975;
            s.h = 20 + Math.random() * 120;
            s.dx = (Math.random() - 0.5) * 220 * amp;
            s.opacity = 0.85;
            ref.rect.setAttribute("y", String(s.y));
            ref.rect.setAttribute("height", String(s.h));
            ref.g.setAttribute("transform", `translate(${s.dx} 0)`);
            ref.g.setAttribute("opacity", String(s.opacity));
          } else {
            s.opacity = 0;
            ref.g.setAttribute("opacity", "0");
          }
        });
      }

      // Occasional bright static bar at peak glitch.
      const staticPhase = Math.floor(t * 30);
      if (staticPhase !== lastStatic) {
        lastStatic = staticPhase;
        const staticG = staticRef.current;
        if (staticG) {
          while (staticG.firstChild) staticG.removeChild(staticG.firstChild);
          if (env > 0.5 && Math.random() < 0.25 * intensity) {
            const rect = document.createElementNS(
              "http://www.w3.org/2000/svg",
              "rect",
            );
            rect.setAttribute("x", "0");
            rect.setAttribute("y", String(Math.random() * 800));
            rect.setAttribute("width", "1500");
            rect.setAttribute("height", String(20 + Math.random() * 80));
            rect.setAttribute(
              "fill",
              Math.random() < 0.5 ? "#78ffb2" : "#f5f5f4",
            );
            rect.setAttribute("opacity", "0.22");
            staticG.appendChild(rect);
          }
        }
      }

      raf = requestAnimationFrame(frame);
    }

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [intensity, loopDurationMs, slabIndexes, reducedMotion]);

  return (
    <svg
      viewBox="0 0 1500 975"
      preserveAspectRatio="xMidYMid meet"
      className={className}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <defs>
        {slabIndexes.map((i) => (
          <clipPath key={i} id={`${baseId}-slab-${i}`}>
            <rect
              x={0}
              width={1500}
              y={0}
              height={0}
              ref={(node) => {
                slabRefs.current[i] = {
                  g: slabRefs.current[i]?.g ?? null,
                  rect: node,
                };
              }}
            />
          </clipPath>
        ))}
      </defs>

      {/* RGB separation layers + main logo */}
      <g ref={aRRef} style={{ mixBlendMode: "screen" }}>
        <VexLogoPaths fill="#ff4a7a" />
      </g>
      <g ref={aGRef} style={{ mixBlendMode: "screen" }}>
        <VexLogoPaths fill="#4affa0" />
      </g>
      <g ref={aBRef} style={{ mixBlendMode: "screen" }}>
        <VexLogoPaths fill="#4aa4ff" />
      </g>
      <g ref={mainRef}>
        <VexLogoPaths fill="#f5f5f4" />
      </g>

      {/* Slab tear layers — each clipped to a slice that moves lateral. */}
      <g>
        {slabIndexes.map((i) => (
          <g
            key={i}
            clipPath={`url(#${baseId}-slab-${i})`}
            opacity={0}
            ref={(node) => {
              slabRefs.current[i] = {
                g: node,
                rect: slabRefs.current[i]?.rect ?? null,
              };
            }}
          >
            <VexLogoPaths fill="#f5f5f4" />
          </g>
        ))}
      </g>

      {/* Transient static bars */}
      <g ref={staticRef} />
    </svg>
  );
}
