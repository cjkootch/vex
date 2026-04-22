"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { WorkspaceMode, type WorkspaceModeConfig } from "@vex/ui";
import {
  WorkspaceModeProvider,
  useWorkspaceMode,
} from "@/lib/workspace-mode-context";
import {
  ConversationSidebar,
  type ConversationListItem,
} from "@/components/chat/conversation-sidebar";
import {
  ConversationThread,
  type ChatTurn,
} from "@/components/chat/conversation-thread";
import { PinnedPane } from "@/components/canvas/pinned-pane";
import { PinnedPanelsProvider } from "@/lib/pinned-panels";

interface Conversation {
  id: string;
  title: string;
  updatedAt: number;
  turns: ChatTurn[];
}

/**
 * Sprint 5 chat surface with Sprint 11 orientation additions.
 *
 * The outer <WorkspaceModeProvider> is local to the page: the /app
 * layout wrapper (AppShell) hasn't been wired yet, and the spec for
 * this turn is "stop after chat/page.tsx update only". When AppShell
 * lands its provider will be a parent of this one — React allows
 * nested providers and the inner wins, so nothing breaks.
 */
// useSearchParams needs a Suspense boundary under Next 14's static
// render path; marking the route dynamic skips prerender and keeps
// the existing hydrate-from-URL flow intact.
export const dynamic = "force-dynamic";

export default function ChatPage() {
  return (
    <WorkspaceModeProvider>
      <PinnedPanelsProvider>
        {/*
          useSearchParams() inside ChatPageInner forces a client-side
          bailout during static render; Suspense lets Next 14 tolerate
          that without failing prerender.
        */}
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-sm text-white/40">
              Loading chat…
            </div>
          }
        >
          <ChatPageInner />
        </Suspense>
      </PinnedPanelsProvider>
    </WorkspaceModeProvider>
  );
}

const STORAGE_KEY = "vex.chat.conversations.v1";
const DEFAULT_TITLES = new Set(["New conversation", "Untitled conversation"]);

interface StoredState {
  conversations: Conversation[];
  activeId: string;
}

function loadStoredState(): StoredState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    if (
      !Array.isArray(parsed.conversations) ||
      parsed.conversations.length === 0 ||
      typeof parsed.activeId !== "string"
    ) {
      return null;
    }
    return { conversations: parsed.conversations, activeId: parsed.activeId };
  } catch {
    return null;
  }
}

type ChatScope = {
  type: "contact" | "deal" | "organization" | "campaign";
  id: string;
};

function parseScopeParam(raw: string | null): ChatScope | null {
  if (!raw) return null;
  const [type, ...idParts] = raw.split(":");
  const id = idParts.join(":");
  if (!type || !id) return null;
  if (
    type !== "contact" &&
    type !== "deal" &&
    type !== "organization" &&
    type !== "campaign"
  ) {
    return null;
  }
  return { type, id };
}

function scopeChipStyles(type: ChatScope["type"]): string {
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

function ChatPageInner() {
  const { mode, config, contextId, contextLabel, contextSublabel, setMode } =
    useWorkspaceMode();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [scope, setScope] = useState<ChatScope | null>(() =>
    parseScopeParam(searchParams?.get("scope") ?? null),
  );
  const [scopeLabel, setScopeLabel] = useState<string | null>(() => {
    const raw = searchParams?.get("scopeLabel");
    return raw && raw.length > 0 ? raw : null;
  });
  const [initialDraft, setInitialDraft] = useState<string>(() => {
    const ask = searchParams?.get("ask");
    return ask ?? "";
  });
  // Sync state when the URL params change (e.g. operator clicks a
  // different contact's Ask Vex while staying on /app/chat).
  useEffect(() => {
    const nextScope = parseScopeParam(searchParams?.get("scope") ?? null);
    setScope(nextScope);
    const lbl = searchParams?.get("scopeLabel");
    setScopeLabel(lbl && lbl.length > 0 ? lbl : null);
    const ask = searchParams?.get("ask");
    if (ask) setInitialDraft(ask);
  }, [searchParams]);
  const [conversations, setConversations] = useState<Conversation[]>(() => [
    initialConversation(),
  ]);
  const [activeId, setActiveId] = useState<string>(() => conversations[0]!.id);

  // Hydrate from localStorage on mount. Next.js renders the initial
  // default-state client-side too, so setting state in an effect
  // avoids a hydration mismatch vs reading localStorage at init.
  useEffect(() => {
    const stored = loadStoredState();
    if (!stored) return;
    setConversations(stored.conversations);
    setActiveId(stored.activeId);
  }, []);

  // Persist on every change. Always wrap in try/catch — Safari
  // private mode and quota-exceeded scenarios shouldn't crash chat.
  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ conversations, activeId }),
      );
    } catch {
      /* quota / private mode — in-memory still works */
    }
  }, [conversations, activeId]);

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? conversations[0]!,
    [conversations, activeId],
  );

  const sidebarItems: ConversationListItem[] = conversations
    .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const isDealWarRoom = mode === WorkspaceMode.DealWarRoom;
  const showBreadcrumb = mode !== WorkspaceMode.Global;

  return (
    <div className="flex h-[calc(100dvh-3rem)] w-full overflow-hidden md:h-full">
      <ConversationSidebar
        items={sidebarItems}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={() => {
          const fresh = newConversation();
          setConversations((prev) => [fresh, ...prev]);
          setActiveId(fresh.id);
        }}
        onDelete={(id) => {
          setConversations((prev) => {
            const next = prev.filter((c) => c.id !== id);
            if (next.length === 0) {
              // Keep at least one conversation — seed a fresh one.
              const fresh = newConversation();
              setActiveId(fresh.id);
              return [fresh];
            }
            if (id === activeId) {
              setActiveId(next[0]!.id);
            }
            return next;
          });
        }}
      />

      <main className="flex h-full min-w-0 flex-1 flex-col">
        {showBreadcrumb ? (
          <Breadcrumb
            config={config}
            contextLabel={contextLabel}
            onHome={() => {
              setMode(WorkspaceMode.Global);
              router.push("/app");
            }}
            onClearContext={() => setMode(mode)}
          />
        ) : null}
        <header className="flex flex-shrink-0 items-center justify-between border-b border-line-soft bg-surface-1/80 px-6 py-3 backdrop-blur-xl">
          <input
            value={active.title}
            onChange={(e) =>
              setConversations((prev) =>
                prev.map((c) =>
                  c.id === active.id
                    ? { ...c, title: e.target.value, updatedAt: Date.now() }
                    : c,
                ),
              )
            }
            aria-label="Conversation title"
            className="bg-transparent text-sm font-semibold tracking-[-0.005em] text-text-primary outline-none placeholder:text-text-muted focus:underline"
          />
        </header>
        <div
          className="grid min-h-0 flex-1"
          style={{
            gridTemplateColumns: isDealWarRoom ? "2fr 3fr" : "1fr 0fr",
            transition: "grid-template-columns 300ms ease",
          }}
        >
          <div className="flex min-h-0 min-w-0 flex-col">
            {scope ? (
              <div className="flex items-center gap-2 border-b border-line-soft bg-intel-soft/30 px-6 py-2">
                <span
                  aria-hidden="true"
                  className="inline-block h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_6px_currentColor]"
                />
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${scopeChipStyles(scope.type)}`}
                >
                  <span className="text-eyebrow opacity-70">{scope.type}</span>
                  <span className="font-medium">
                    {scopeLabel ?? scope.id.slice(-8)}
                  </span>
                </span>
                <span className="text-xs text-text-secondary">
                  Vex is scoped to this {scope.type}. Answers and
                  proposed actions bias toward it.
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setScope(null);
                    setScopeLabel(null);
                    const sp = new URLSearchParams(
                      (searchParams?.toString() ?? ""),
                    );
                    sp.delete("scope");
                    sp.delete("scopeLabel");
                    const qs = sp.toString();
                    router.replace(`/app/chat${qs ? `?${qs}` : ""}`);
                  }}
                  className="ml-auto rounded p-0.5 text-xs text-text-muted transition-colors hover:bg-white/[0.05] hover:text-text-primary"
                  aria-label="Clear scope"
                >
                  Clear ✕
                </button>
              </div>
            ) : null}
            <ConversationThread
              turns={active.turns}
              {...(scope ? { scope } : {})}
              {...(initialDraft ? { initialDraft } : {})}
              onTurns={(turns) =>
                setConversations((prev) =>
                  prev.map((c) => {
                    if (c.id !== active.id) return c;
                    // Auto-derive title from the first user turn the
                    // first time one lands, so the sidebar shows
                    // something meaningful instead of "New
                    // conversation". Skip once the user has renamed
                    // the conversation manually (title no longer
                    // matches either default).
                    let title = c.title;
                    if (DEFAULT_TITLES.has(c.title)) {
                      const firstUser = turns.find((t) => t.role === "user");
                      if (firstUser?.text) {
                        title = firstUser.text.slice(0, 60);
                      }
                    }
                    return { ...c, turns, title, updatedAt: Date.now() };
                  }),
                )
              }
            />
          </div>
          {isDealWarRoom ? (
            <DealWorkspacePane
              dealId={contextId}
              dealRef={contextLabel}
              sublabel={contextSublabel}
              config={config}
            />
          ) : (
            <div aria-hidden="true" />
          )}
        </div>
      </main>

      <PinnedPane />
    </div>
  );
}

interface BreadcrumbProps {
  config: WorkspaceModeConfig;
  contextLabel: string | null;
  onHome: () => void;
  onClearContext: () => void;
}

/**
 * Three-segment crumb: Home (resets to global + navigates to /app) ›
 * mode-label (clears contextId while staying in mode) › context-label
 * (current position — plain text, not a link).
 */
function Breadcrumb({
  config,
  contextLabel,
  onHome,
  onClearContext,
}: BreadcrumbProps) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex h-9 flex-shrink-0 items-center gap-1 border-b border-line-soft bg-surface-2/40 px-4 text-xs"
    >
      <button
        type="button"
        onClick={onHome}
        className="rounded px-1.5 py-0.5 text-text-muted transition-colors hover:bg-white/[0.04] hover:text-text-primary"
      >
        Home
      </button>
      <span aria-hidden="true" className="text-text-muted/50">
        ›
      </span>
      <button
        type="button"
        onClick={onClearContext}
        aria-current={contextLabel ? undefined : "page"}
        className={`rounded px-1.5 py-0.5 transition-colors ${
          contextLabel
            ? "text-text-muted hover:bg-white/[0.04] hover:text-text-primary"
            : "text-text-primary"
        }`}
      >
        {config.label}
      </button>
      {contextLabel ? (
        <>
          <span aria-hidden="true" className="text-text-muted/50">
            ›
          </span>
          <span
            aria-current="page"
            className="px-1.5 py-0.5 font-medium text-text-primary"
          >
            {contextLabel}
          </span>
        </>
      ) : null}
    </nav>
  );
}

interface DealWorkspacePaneProps {
  dealId: string | null;
  dealRef: string | null;
  sublabel: string | null;
  config: WorkspaceModeConfig;
}

/**
 * Inline workspace pane shown in the 60% slot when mode=DEAL_WAR_ROOM.
 * Renders real data from the workspace context — deal ref, sublabel,
 * and the panel types the mode will surface as the evaluator's
 * results stream in. Becomes richer in a follow-up turn when the
 * dedicated DealWorkspace component and /deals/:id API ship.
 */
function DealWorkspacePane({
  dealId,
  dealRef,
  sublabel,
  config,
}: DealWorkspacePaneProps) {
  return (
    <section
      aria-label="Deal workspace"
      className="flex h-full min-w-0 flex-col overflow-auto border-l border-line-soft bg-surface-1/40"
    >
      <header className="border-b border-line-soft px-5 py-4">
        <div className="text-eyebrow text-text-muted">{config.label}</div>
        <h2 className="mt-1 num-mono text-h1 text-text-primary">
          {dealRef ?? "No deal selected"}
        </h2>
        {sublabel ? (
          <p className="mt-1 text-sm text-text-secondary">{sublabel}</p>
        ) : null}
      </header>
      <div className="flex-1 p-5 text-sm text-text-secondary">
        <p className="mb-3">{config.description}</p>
        <div className="mb-2 text-eyebrow text-text-muted">
          Panels loading for this mode
        </div>
        <ul className="space-y-1">
          {config.defaultPanels.map((p) => (
            <li key={p} className="num-mono text-xs text-text-muted">
              · {p}
            </li>
          ))}
        </ul>
        {dealId ? (
          <Link
            href={`/app/deals/${dealId}`}
            className="mt-4 inline-block rounded-md border border-line bg-muted/40 px-3 py-1.5 text-xs text-white/70 transition hover:border-white/30 hover:text-white"
          >
            Open full deal view →
          </Link>
        ) : null}
      </div>
    </section>
  );
}

function initialConversation(): Conversation {
  return newConversation("New conversation");
}

function newConversation(title = "Untitled conversation"): Conversation {
  return {
    id: crypto.randomUUID(),
    title,
    updatedAt: Date.now(),
    turns: [],
  };
}
