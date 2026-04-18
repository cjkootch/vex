"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
import { EvidenceDetail } from "@/components/chat/evidence-detail";
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
export default function ChatPage() {
  return (
    <WorkspaceModeProvider>
      <PinnedPanelsProvider>
        <ChatPageInner />
      </PinnedPanelsProvider>
    </WorkspaceModeProvider>
  );
}

function ChatPageInner() {
  const { mode, config, contextId, contextLabel, contextSublabel, setMode } =
    useWorkspaceMode();
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>(() => [
    initialConversation(),
  ]);
  const [activeId, setActiveId] = useState<string>(() => conversations[0]!.id);

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? conversations[0]!,
    [conversations, activeId],
  );

  const sidebarItems: ConversationListItem[] = conversations
    .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const lastAssistantTurn = [...active.turns]
    .reverse()
    .find((t) => t.role === "assistant");
  const evidenceRefs = lastAssistantTurn?.manifest?.evidence_refs ?? [];

  const isDealWarRoom = mode === WorkspaceMode.DealWarRoom;
  const showBreadcrumb = mode !== WorkspaceMode.Global;

  return (
    <div className="flex h-full w-full overflow-hidden">
      <ConversationSidebar
        items={sidebarItems}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={() => {
          const fresh = newConversation();
          setConversations((prev) => [fresh, ...prev]);
          setActiveId(fresh.id);
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
        <header className="flex flex-shrink-0 items-center justify-between border-b border-line bg-canvas/95 px-6 py-3 backdrop-blur">
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
            className="bg-transparent text-sm font-semibold text-white outline-none focus:underline"
          />
        </header>
        <div
          className="grid min-h-0 flex-1"
          style={{
            gridTemplateColumns: isDealWarRoom ? "2fr 3fr" : "1fr 0fr",
            transition: "grid-template-columns 300ms ease",
          }}
        >
          <div className="min-h-0 min-w-0">
            <ConversationThread
              turns={active.turns}
              onTurns={(turns) =>
                setConversations((prev) =>
                  prev.map((c) =>
                    c.id === active.id
                      ? { ...c, turns, updatedAt: Date.now() }
                      : c,
                  ),
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

      <EvidenceDetail
        evidenceRefs={evidenceRefs}
        {...(typeof lastAssistantTurn?.manifest?.cost_usd === "number"
          ? { costUsd: lastAssistantTurn.manifest.cost_usd }
          : {})}
        {...(typeof lastAssistantTurn?.manifest?.cache_hit === "boolean"
          ? { cacheHit: lastAssistantTurn.manifest.cache_hit }
          : {})}
      />
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
      className="flex h-9 flex-shrink-0 items-center gap-1 border-b border-line bg-muted/20 px-4 text-xs"
    >
      <button
        type="button"
        onClick={onHome}
        className="rounded px-1.5 py-0.5 text-white/60 transition hover:bg-white/5 hover:text-white"
      >
        Home
      </button>
      <span aria-hidden="true" className="text-white/30">
        ›
      </span>
      <button
        type="button"
        onClick={onClearContext}
        aria-current={contextLabel ? undefined : "page"}
        className={`rounded px-1.5 py-0.5 transition ${
          contextLabel
            ? "text-white/60 hover:bg-white/5 hover:text-white"
            : "text-white"
        }`}
      >
        {config.label}
      </button>
      {contextLabel ? (
        <>
          <span aria-hidden="true" className="text-white/30">
            ›
          </span>
          <span aria-current="page" className="px-1.5 py-0.5 text-white">
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
      className="flex h-full min-w-0 flex-col overflow-auto border-l border-line bg-canvas/40"
    >
      <header className="border-b border-line px-5 py-4">
        <div className="text-xs uppercase tracking-wider text-white/40">
          {config.label}
        </div>
        <h2 className="mt-1 text-lg font-semibold text-white">
          {dealRef ?? "No deal selected"}
        </h2>
        {sublabel ? (
          <p className="mt-1 text-sm text-white/60">{sublabel}</p>
        ) : null}
      </header>
      <div className="flex-1 p-5 text-sm text-white/70">
        <p className="mb-3">{config.description}</p>
        <div className="mb-2 text-xs uppercase tracking-wider text-white/40">
          Panels loading for this mode
        </div>
        <ul className="space-y-1">
          {config.defaultPanels.map((p) => (
            <li key={p} className="font-mono text-xs text-white/60">
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
