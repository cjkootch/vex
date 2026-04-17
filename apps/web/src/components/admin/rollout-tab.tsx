"use client";

import { useEffect, useState } from "react";
import type { WorkspaceSettings } from "./admin-console";

interface FeatureDescriptor {
  name: string;
  label: string;
  description: string;
}

// Known rollout flags. Adding a flag here exposes it in the UI; keys
// not listed still work at the store level — they just aren't
// surfaced as a slider.
const KNOWN_FEATURES: FeatureDescriptor[] = [
  {
    name: "voice_alpha",
    label: "Voice alpha",
    description: "Browser voice via OpenAI Realtime API (Sprint 9).",
  },
  {
    name: "outbound_call",
    label: "PSTN outbound",
    description:
      "T3 outbound Twilio calls (Sprint 12). Requires the outbound_call agent to be enabled too.",
  },
  {
    name: "deal_canvas",
    label: "Deal canvas",
    description: "Fuel-deal scorecard + cost waterfall panels (Sprint 11).",
  },
  {
    name: "marketing_analyst",
    label: "Marketing anomalies",
    description: "Hourly GA4 anomaly scan (Sprint 8).",
  },
  {
    name: "sharing_v1",
    label: "Object-level sharing",
    description:
      "OpenFGA-backed object sharing (deferred per ADR-006 — leaving at 0% until binding ships).",
  },
];

export interface RolloutTabProps {
  settings: WorkspaceSettings | null;
  onPatch: (patch: Partial<WorkspaceSettings>) => Promise<boolean>;
}

/**
 * Per-feature rollout sliders. Every flag maps to an integer 0..100
 * that the server stores verbatim; `isFeatureEnabled` in @vex/config
 * gates tenants on a deterministic SHA-256 bucket.
 */
export function RolloutTab({ settings, onPatch }: RolloutTabProps) {
  const [draft, setDraft] = useState<Record<string, number>>({});

  useEffect(() => {
    if (settings?.feature_rollout) setDraft(settings.feature_rollout);
  }, [settings]);

  if (!settings) {
    return <p className="text-sm text-white/50">Loading settings…</p>;
  }

  const rollout = settings.feature_rollout ?? {};

  const setPct = (name: string, pct: number): void => {
    setDraft((d) => ({ ...d, [name]: pct }));
  };

  const save = async (name: string): Promise<void> => {
    const next: Record<string, number> = { ...rollout };
    const value = draft[name];
    if (value === undefined) return;
    next[name] = Math.max(0, Math.min(100, Math.round(value)));
    await onPatch({ feature_rollout: next });
  };

  return (
    <section className="space-y-6">
      <p className="text-xs text-white/60">
        Rollouts are deterministic — a tenant that&rsquo;s in the rollout at
        30% stays in until the number drops below their bucket. SHA-256
        of <code className="font-mono text-white/80">{"${tenantId}:${featureName}"}</code>
        {" "}&rarr; first 4 bytes mod 100.
      </p>

      <ul className="space-y-3" data-block="rollout-sliders">
        {KNOWN_FEATURES.map((feature) => {
          const stored = rollout[feature.name] ?? 0;
          const current = draft[feature.name] ?? stored;
          const dirty = current !== stored;
          return (
            <li
              key={feature.name}
              data-feature={feature.name}
              className="rounded-lg border border-line bg-muted/20 p-4"
            >
              <header className="mb-2 flex items-start justify-between gap-4">
                <div>
                  <div className="font-medium text-white">{feature.label}</div>
                  <p className="mt-1 text-xs text-white/60">
                    {feature.description}
                  </p>
                </div>
                <span className="rounded-full border border-line bg-canvas/40 px-2 py-0.5 font-mono text-xs text-white/70">
                  {current}%
                </span>
              </header>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={current}
                  onChange={(e) => setPct(feature.name, Number(e.target.value))}
                  aria-label={`${feature.label} rollout percentage`}
                  className="flex-1 accent-teal-400"
                />
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={current}
                  onChange={(e) => setPct(feature.name, Number(e.target.value))}
                  className="w-16 rounded-md border border-line bg-canvas/40 px-2 py-1 text-sm text-white"
                />
                <button
                  type="button"
                  disabled={!dirty}
                  onClick={() => void save(feature.name)}
                  className="rounded-md border border-line bg-muted/40 px-3 py-1 text-xs text-white/80 transition hover:border-white/30 hover:text-white disabled:opacity-30"
                >
                  Save
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
