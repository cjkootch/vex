"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { buildAskVexHref, type AskVexSubjectType } from "@/lib/ask-vex";

/**
 * Primary "Ask Vex" CTA used on every detail page. Bigger, accent-
 * styled, and hosts a small popover of scoped suggested prompts so
 * operators see what Vex can do from here without having to think
 * of the right phrasing.
 *
 * Click the main button to jump to chat with the default prompt.
 * Click the chevron to open a menu of alternate prompts (all still
 * inside the same entity scope).
 */
export interface AskVexAction {
  /** Short label shown in the menu — "Score this deal". */
  label: string;
  /** Longer prompt that actually gets sent to chat. */
  ask: string;
  /** Optional one-liner explaining what this does. */
  hint?: string;
}

export interface AskVexButtonProps {
  type: AskVexSubjectType;
  id: string;
  label: string;
  /** The prompt fired by the primary click. */
  defaultAsk: string;
  /** Alternate prompts exposed via the chevron menu. */
  actions?: AskVexAction[];
  /** Optional extra className for layout positioning. */
  className?: string;
}

export function AskVexButton({
  type,
  id,
  label,
  defaultAsk,
  actions,
  className,
}: AskVexButtonProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(
    null,
  );
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  // SSR guard for createPortal.
  useEffect(() => {
    setMounted(true);
  }, []);

  // Position the portal-rendered dropdown directly under the button.
  // The hero wraps the button in `overflow-hidden` (so its gradient
  // banner stays inside the rounded corners) — that clips an
  // absolutely-positioned popover. Rendering via portal escapes the
  // clip; we just have to compute the right coordinates ourselves.
  useLayoutEffect(() => {
    if (!open || !wrapperRef.current) return;
    const recompute = () => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;
      setCoords({
        top: rect.bottom + 6,
        right: window.innerWidth - rect.right,
      });
    };
    recompute();
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    return () => {
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
    };
  }, [open]);

  // Close on outside click / Escape. Outside-click check now also
  // ignores clicks inside the portaled dropdown itself.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (wrapperRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const hasActions = (actions?.length ?? 0) > 0;
  const primaryHref = buildAskVexHref({ type, id, label, ask: defaultAsk });

  return (
    <div ref={wrapperRef} className={`relative inline-flex ${className ?? ""}`}>
      <Link
        href={primaryHref}
        className="inline-flex items-center gap-1.5 rounded-l-md bg-accent px-3 py-1.5 text-sm font-medium text-bg transition-colors hover:bg-accent/85"
        title={defaultAsk}
      >
        <SparkIcon />
        Ask Vex
      </Link>
      {hasActions ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label="More Ask Vex actions"
          aria-expanded={open}
          className="inline-flex items-center rounded-r-md border-l border-bg/20 bg-accent px-2 py-1.5 text-bg transition-colors hover:bg-accent/85"
        >
          <ChevronIcon open={open} />
        </button>
      ) : (
        <Link
          href={primaryHref}
          className="ml-px inline-flex items-center rounded-r-md bg-accent px-2 py-1.5 text-bg transition-colors hover:bg-accent/85"
          aria-hidden="true"
          tabIndex={-1}
        >
          <ArrowIcon />
        </Link>
      )}
      {mounted && open && hasActions && coords
        ? createPortal(
            <div
              ref={dropdownRef}
              style={{
                position: "fixed",
                top: coords.top,
                right: coords.right,
                maxHeight: `calc(100vh - ${coords.top + 16}px)`,
              }}
              className="z-50 w-72 overflow-y-auto rounded-lg border border-line-strong bg-surface-2/95 shadow-overlay backdrop-blur-xl"
            >
              <div className="flex items-center justify-between border-b border-line-soft bg-intel-soft/40 px-3 py-2">
                <span className="text-eyebrow text-accent-strong">
                  Vex can do from here
                </span>
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_6px_currentColor]"
                />
              </div>
              <ul className="flex flex-col">
                {actions?.map((a) => (
                  <li key={a.label}>
                    <Link
                      href={buildAskVexHref({ type, id, label, ask: a.ask })}
                      onClick={() => setOpen(false)}
                      className="block border-b border-line-soft/60 px-3 py-2.5 text-sm text-text-primary transition-colors last:border-b-0 hover:bg-white/[0.04]"
                    >
                      <div className="font-medium">{a.label}</div>
                      {a.hint ? (
                        <div className="mt-0.5 text-[11px] text-text-muted">
                          {a.hint}
                        </div>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function SparkIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2v6M12 16v6M4 12h6M14 12h6" />
      <path d="M6 6l3 3M15 15l3 3M6 18l3-3M15 9l3-3" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14M13 5l7 7-7 7" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
