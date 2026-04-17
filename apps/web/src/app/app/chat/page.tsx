"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  WORKSPACE_MODE_CONFIGS,
  WorkspaceMode,
  type WorkspaceModeConfig,
} from "@vex/ui";
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
      <ChatPageInner />
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
    <div className="flex h-[calc(100vh-0px)] w-full overflow-hidden">
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
        <header className="flex items-center justify-between border-b border-line px-6 py-3">
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
          <div className="min-w-0">
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
