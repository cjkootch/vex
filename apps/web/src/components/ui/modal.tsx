"use client";

import { useEffect, type ReactNode } from "react";

/**
 * Minimal modal. Renders a dimmed backdrop + centered panel. Escape
 * closes. Not a portal — the component mounts inline, so callers are
 * responsible for rendering it as the last child of their layout so
 * it sits above the rest of the UI. That's fine for Sprint 14 because
 * every caller is a page-level list surface.
 */
export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * Panel width. `md` matches the original Sprint-14 modal; `xl` widens
   * for two-pane workspaces (the deal creator dashboard). Keep the
   * default at `md` so existing callers are untouched.
   */
  size?: "md" | "xl";
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md"
      onClick={onClose}
      role="presentation"
    >
      <div
        className={`relative w-full overflow-hidden rounded-xl border border-line-strong bg-surface-2/95 p-6 shadow-overlay backdrop-blur-xl ${
          size === "xl" ? "max-w-6xl" : "max-w-lg"
        }`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {/* Subtle specular top edge — consistent premium chrome
            across palette, modal, drawer. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.08] to-transparent"
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 rounded-md p-1 text-text-muted transition-colors hover:bg-white/[0.05] hover:text-text-primary"
        >
          <svg
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-4 w-4"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>
        <div className="mb-4 pr-8">
          <h2 className="text-h1 text-text-primary">{title}</h2>
          {description && (
            <p className="mt-1 text-sm text-text-secondary">{description}</p>
          )}
        </div>
        <div className="flex flex-col gap-3">{children}</div>
        {footer && (
          <div className="mt-5 flex justify-end gap-2 border-t border-line-soft pt-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
