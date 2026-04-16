"use client";

import { useMemo, useState } from "react";
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
 * Sprint 5 chat surface. Three-pane layout:
 *   - Left:   conversation list (local state — Sprint 6 will persist)
 *   - Center: streaming message thread + adaptive ManifestCanvas
 *   - Right:  evidence inspection
 *
 * State lives entirely in the client per Sprint 5 spec.
 */
export default function ChatPage() {
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

  const lastAssistantTurn = [...active.turns].reverse().find((t) => t.role === "assistant");
  const evidenceRefs = lastAssistantTurn?.manifest?.evidence_refs ?? [];

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
        <header className="flex items-center justify-between border-b border-line px-6 py-3">
          <input
            value={active.title}
            onChange={(e) =>
              setConversations((prev) =>
                prev.map((c) =>
                  c.id === active.id ? { ...c, title: e.target.value, updatedAt: Date.now() } : c,
                ),
              )
            }
            aria-label="Conversation title"
            className="bg-transparent text-sm font-semibold text-white outline-none focus:underline"
          />
        </header>
        <ConversationThread
          turns={active.turns}
          onTurns={(turns) =>
            setConversations((prev) =>
              prev.map((c) =>
                c.id === active.id ? { ...c, turns, updatedAt: Date.now() } : c,
              ),
            )
          }
        />
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
