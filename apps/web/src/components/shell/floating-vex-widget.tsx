"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ConversationThread,
  type ChatTurn,
} from "@/components/chat/conversation-thread";
import { buildAskVexHref } from "@/lib/ask-vex";
import type { QueryScope } from "@/lib/use-vex-query";

/**
 * Floating Vex widget. Bottom-right fab on every /app/* route EXCEPT
 * /app/chat (where the full-page chat owns the surface). Click → right
 * side drawer with a lightweight ConversationThread.
 *
 * Scope is auto-detected from the current route:
 *   /app/contacts/:id   → contact scope
 *   /app/deals/:id      → deal scope
 *   /app/companies/:id  → organization scope
 *   /app/marketing/:id  → campaign scope
 *   anywhere else       → no scope (global chat)
 *
 * "View full chat →" deep-links to /app/chat with the current scope +
 * a suggested prompt so operators can escalate to the richer surface
 * when a manifest (table, map, chart) won't fit the 420px drawer.
 */

const HIDE_ON_PATHS: readonly string[] = ["/app/chat"];

interface WidgetState {
  turns: ChatTurn[];
  lastUserMessage: string;
}

function deriveScope(pathname: string | null): QueryScope | null {
  if (!pathname) return null;
  const rules: Array<{ re: RegExp; type: QueryScope["type"] }> = [
    { re: /^\/app\/contacts\/([^/]+)/, type: "contact" },
    { re: /^\/app\/deals\/([^/]+)/, type: "deal" },
    { re: /^\/app\/companies\/([^/]+)/, type: "organization" },
    { re: /^\/app\/marketing\/([^/]+)/, type: "campaign" },
  ];
  for (const { re, type } of rules) {
    const match = pathname.match(re);
    if (match && match[1] && match[1].length > 0) {
      return { type, id: match[1] };
    }
  }
  return null;
}

function scopeChipStyles(type: QueryScope["type"]): string {
  switch (type) {
    case "contact":
      return "border-purple-500/40 bg-purple-500/10 text-purple-100";
    case "deal":
      return "border-teal-500/40 bg-teal-500/10 text-teal-100";
    case "organization":
      return "border-blue-500/40 bg-blue-500/10 text-blue-100";
    case "campaign":
      return "border-amber-500/40 bg-amber-500/10 text-amber-100";
  }
}

export function FloatingVexWidget() {
  const pathname = usePathname();
  const router = useRouter();
  const scope = useMemo(() => deriveScope(pathname), [pathname]);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<WidgetState>({
    turns: [],
    lastUserMessage: "",
  });
  const drawerRef = useRef<HTMLDivElement>(null);

  // When scope changes (operator navigates to a different subject
  // while drawer is open), clear the previous conversation — mixing
  // scopes within one thread confuses Vex's retrieval and the
  // operator's mental model.
  const lastScopeKey = useRef<string | null>(
    scope ? `${scope.type}:${scope.id}` : null,
  );
  useEffect(() => {
    const nextKey = scope ? `${scope.type}:${scope.id}` : null;
    if (nextKey !== lastScopeKey.current) {
      lastScopeKey.current = nextKey;
      setState({ turns: [], lastUserMessage: "" });
    }
  }, [scope]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Hide on the full-page chat and on non-app routes.
  if (!pathname) return null;
  if (HIDE_ON_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return null;
  }
  if (!pathname.startsWith("/app")) return null;

  const handleViewInChat = () => {
    const href = scope
      ? buildAskVexHref({
          type: scope.type,
          id: scope.id,
          ask: state.lastUserMessage || undefined,
        })
      : state.lastUserMessage
        ? `/app/chat?ask=${encodeURIComponent(state.lastUserMessage)}`
        : "/app/chat";
    setOpen(false);
    router.push(href);
  };

  return (
    <>
      {/* FAB — always visible on /app/*, hidden on /app/chat */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close Vex widget" : "Ask Vex"}
        aria-expanded={open}
        className="fixed bottom-6 right-6 z-40 inline-flex h-12 w-12 items-center justify-center rounded-full bg-accent text-white shadow-lg transition hover:scale-105 hover:bg-accent/90 md:h-14 md:w-14"
      >
        <span className="text-lg font-semibold md:text-xl">V</span>
      </button>

      {/* Drawer */}
      {open ? (
        <div
          className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            ref={drawerRef}
            role="dialog"
            aria-label="Vex chat widget"
            className="absolute bottom-0 right-0 top-0 flex w-full max-w-[440px] flex-col border-l border-line bg-bg shadow-2xl"
          >
            <header className="flex flex-shrink-0 items-center justify-between border-b border-line bg-muted/30 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-white">
                  Ask Vex
                </span>
                {scope ? (
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] ${scopeChipStyles(scope.type)}`}
                  >
                    <span className="uppercase tracking-wide opacity-80">
                      {scope.type}
                    </span>
                  </span>
                ) : (
                  <span className="rounded-full border border-line bg-muted/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-white/50">
                    global
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleViewInChat}
                  className="text-xs text-white/60 transition hover:text-white"
                  title="Open the full chat page with this scope + thread"
                >
                  View full chat →
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="text-white/40 transition hover:text-white"
                >
                  ✕
                </button>
              </div>
            </header>
            <div className="min-h-0 flex-1">
              <ConversationThread
                turns={state.turns}
                {...(scope ? { scope } : {})}
                onTurns={(turns) => {
                  // Capture the last user message so "View full chat"
                  // deep-links with a pre-filled continuation prompt.
                  const lastUser = [...turns]
                    .reverse()
                    .find((t) => t.role === "user");
                  setState({
                    turns,
                    lastUserMessage: lastUser?.text ?? "",
                  });
                }}
              />
            </div>
            {scope ? (
              <footer className="flex-shrink-0 border-t border-line bg-muted/20 px-4 py-2 text-xs text-white/50">
                Answers bias toward this {scope.type}.{" "}
                <Link
                  href={buildAskVexHref({
                    type: scope.type,
                    id: scope.id,
                    ask: state.lastUserMessage || undefined,
                  })}
                  onClick={() => setOpen(false)}
                  className="text-white/70 transition hover:text-white"
                >
                  Escalate to full chat →
                </Link>
              </footer>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

// Re-export for type consumers that don't need the whole lib.
export type { QueryScope };
