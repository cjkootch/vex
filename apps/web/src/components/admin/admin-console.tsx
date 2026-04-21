"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWithRetry } from "@/lib/fetch-with-retry";
import { AgentsTab } from "./agents-tab";
import { HealthTab } from "./health-tab";
import { CostLedgerTab } from "./cost-ledger-tab";
import { RolloutTab } from "./rollout-tab";
import { EvalsTab } from "./evals-tab";
import { OfacTab } from "./ofac-tab";

export interface WorkspaceSettings {
  source_priority: string[];
  enabled_agents: string[];
  daily_cost_limit: number;
  kill_all_agents: boolean;
  feature_rollout?: Record<string, number>;
  sharing_enabled?: boolean;
}

type TabKey = "agents" | "health" | "cost" | "rollout" | "evals" | "ofac";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "agents", label: "Agents" },
  { key: "health", label: "Health" },
  { key: "cost", label: "Cost" },
  { key: "rollout", label: "Rollout" },
  { key: "evals", label: "Evals" },
  { key: "ofac", label: "OFAC" },
];

/**
 * Top-level admin console. Owns the WorkspaceSettings state — every
 * settings mutation flows through `patchSettings` here so all tabs
 * see the updated shape after a single round-trip, without re-
 * fetching.
 */
export function AdminConsole() {
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("agents");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithRetry("/api/admin/settings", {
          credentials: "include",
          cache: "no-store",
          onWaking: () => {
            if (!cancelled) setSettingsError("API is waking up…");
          },
        });
        if (res.status === 502 || res.status === 503) {
          throw new Error("API is still waking up. Try again in a moment.");
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { settings: WorkspaceSettings };
        if (!cancelled) {
          setSettings(body.settings);
          setSettingsError(null);
        }
      } catch (err) {
        if (!cancelled) setSettingsError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const patchSettings = useCallback(
    async (patch: Partial<WorkspaceSettings>): Promise<boolean> => {
      try {
        const res = await fetchWithRetry("/api/admin/settings", {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
          onWaking: () => setSettingsError("API is waking up…"),
        });
        if (res.status === 502 || res.status === 503) {
          setSettingsError("API is still waking up. Try again in a moment.");
          return false;
        }
        if (!res.ok) {
          const errBody = (await res.json().catch(() => null)) as
            | { message?: string }
            | null;
          setSettingsError(errBody?.message ?? `HTTP ${res.status}`);
          return false;
        }
        const body = (await res.json()) as { settings: WorkspaceSettings };
        setSettings(body.settings);
        setSettingsError(null);
        return true;
      } catch (err) {
        setSettingsError((err as Error).message);
        return false;
      }
    },
    [],
  );

  return (
    <main className="mx-auto max-w-5xl px-8 py-10 text-white">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="mt-1 text-sm text-white/60">
          Workspace-level controls — you are the owner.
        </p>
      </header>

      <nav
        role="tablist"
        aria-label="Admin sections"
        className="mb-6 flex gap-1 border-b border-line"
      >
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={activeTab === key}
            data-tab={key}
            onClick={() => setActiveTab(key)}
            className={`rounded-t-md border border-b-0 px-3 py-2 text-sm transition ${
              activeTab === key
                ? "border-line bg-muted/40 text-white"
                : "border-transparent text-white/60 hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {settingsError ? (
        <p className="mb-4 text-sm text-red-400" role="alert">
          Settings error: {settingsError}
        </p>
      ) : null}

      {activeTab === "agents" ? (
        <AgentsTab settings={settings} onPatch={patchSettings} />
      ) : null}
      {activeTab === "health" ? <HealthTab /> : null}
      {activeTab === "cost" ? <CostLedgerTab /> : null}
      {activeTab === "rollout" ? (
        <RolloutTab settings={settings} onPatch={patchSettings} />
      ) : null}
      {activeTab === "evals" ? <EvalsTab /> : null}
      {activeTab === "ofac" ? <OfacTab /> : null}
    </main>
  );
}
