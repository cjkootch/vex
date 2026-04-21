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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className={`w-full rounded-lg border border-line bg-canvas p-6 shadow-xl ${
          size === "xl" ? "max-w-6xl" : "max-w-lg"
        }`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          {description && (
            <p className="mt-1 text-sm text-white/60">{description}</p>
          )}
        </div>
        <div className="flex flex-col gap-3">{children}</div>
        {footer && (
          <div className="mt-5 flex justify-end gap-2 border-t border-line pt-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
