"use client";

import { useCallback, useEffect, useState } from "react";

type StrategySlot =
  | "mission"
  | "target_markets"
  | "icp_buyers"
  | "icp_suppliers"
  | "brand_voice"
  | "pricing_philosophy"
  | "no_go_zones"
  | "growth_priorities"
  | "additional_guidance";

/**
 * Shape mirror of `WorkspaceStrategy` from `@vex/db`. We duplicate
 * the type here so the web bundle doesn't need to pull the DB
 * package's server-only transitive deps (drizzle, pg).
 */
interface Strategy {
  mission?: string;
  target_markets?: string[];
  icp_buyers?: string;
  icp_suppliers?: string;
  brand_voice?: string;
  pricing_philosophy?: string;
  no_go_zones?: string[];
  growth_priorities?: string[];
  additional_guidance?: string;
  updated_at?: string;
  updated_by?: string | null;
}

const EMPTY: Strategy = {
  mission: "",
  target_markets: [],
  icp_buyers: "",
  icp_suppliers: "",
  brand_voice: "",
  pricing_philosophy: "",
  no_go_zones: [],
  growth_priorities: [],
  additional_guidance: "",
};

export function StrategyConsole() {
  const [strategy, setStrategy] = useState<Strategy>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/strategy");
        if (!res.ok) throw new Error(`GET /strategy → ${res.status}`);
        const body = (await res.json()) as { strategy: Strategy };
        if (!cancelled) {
          setStrategy({ ...EMPTY, ...body.strategy });
          setLastSavedAt(body.strategy.updated_at ?? null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = stripEmpties(strategy);
      const res = await fetch("/api/strategy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`PUT /strategy → ${res.status}: ${text}`);
      }
      const body = (await res.json()) as { strategy: Strategy };
      setStrategy({ ...EMPTY, ...body.strategy });
      setLastSavedAt(body.strategy.updated_at ?? new Date().toISOString());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [strategy]);

  if (loading) {
    return (
      <main className="mx-auto max-w-4xl px-8 py-10 text-white/60">
        Loading strategy…
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-8 py-10 text-white">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Strategy</h1>
          <p className="mt-2 max-w-2xl text-sm text-white/60">
            Your company&apos;s guiding principles. Vex reads this on every
            chat turn and drafts every email, proposal, and action
            inside your framing. Save updates to apply immediately.
          </p>
        </div>
        {lastSavedAt ? (
          <p className="text-xs text-white/40">
            Last saved {new Date(lastSavedAt).toLocaleString()}
          </p>
        ) : null}
      </header>

      {error ? (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <div className="space-y-4">
        <TextCard
          slot="mission"
          title="Mission"
          hint="One paragraph. Why this company exists and who it serves."
          value={strategy.mission ?? ""}
          onChange={(v) => setStrategy({ ...strategy, mission: v })}
          rows={3}
        />

        <ListCard
          slot="target_markets"
          title="Target markets"
          hint="Regions / countries / corridors. Vex biases evidence and proposals toward these."
          values={strategy.target_markets ?? []}
          onChange={(v) => setStrategy({ ...strategy, target_markets: v })}
        />

        <TextCard
          slot="icp_buyers"
          title="ICP buyers"
          hint="Who's the ideal buyer? Size, geography, buying behaviour."
          value={strategy.icp_buyers ?? ""}
          onChange={(v) => setStrategy({ ...strategy, icp_buyers: v })}
          rows={4}
        />

        <TextCard
          slot="icp_suppliers"
          title="ICP suppliers"
          hint="Who's the ideal supplier? Capabilities, logistics, reliability signals."
          value={strategy.icp_suppliers ?? ""}
          onChange={(v) => setStrategy({ ...strategy, icp_suppliers: v })}
          rows={4}
        />

        <TextCard
          slot="brand_voice"
          title="Brand voice"
          hint="How should drafts and responses sound? Vex mirrors this on every email."
          value={strategy.brand_voice ?? ""}
          onChange={(v) => setStrategy({ ...strategy, brand_voice: v })}
          rows={3}
        />

        <TextCard
          slot="pricing_philosophy"
          title="Pricing philosophy"
          hint="Floor margins, payment terms, LC posture, discount rules."
          value={strategy.pricing_philosophy ?? ""}
          onChange={(v) => setStrategy({ ...strategy, pricing_philosophy: v })}
          rows={3}
        />

        <ListCard
          slot="no_go_zones"
          title="No-go zones"
          hint="Vex will not propose actions that touch these. One entry per line."
          values={strategy.no_go_zones ?? []}
          onChange={(v) => setStrategy({ ...strategy, no_go_zones: v })}
          tone="danger"
        />

        <ListCard
          slot="growth_priorities"
          title="Growth priorities this quarter"
          hint="Specific goals. Vex biases proposals toward advancing these."
          values={strategy.growth_priorities ?? []}
          onChange={(v) => setStrategy({ ...strategy, growth_priorities: v })}
          tone="success"
        />

        <TextCard
          slot="additional_guidance"
          title="Additional guidance"
          hint="Anything else Vex should always apply. Free-form."
          value={strategy.additional_guidance ?? ""}
          onChange={(v) =>
            setStrategy({ ...strategy, additional_guidance: v })
          }
          rows={4}
        />
      </div>

      <footer className="sticky bottom-0 flex items-center justify-end gap-3 border-t border-line bg-bg/95 py-4 backdrop-blur">
        <button
          type="button"
          disabled={saving}
          onClick={save}
          className="rounded-md bg-white px-5 py-2 text-sm font-medium text-black transition hover:bg-white/90 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save strategy"}
        </button>
      </footer>
    </main>
  );
}

function TextCard(props: {
  slot: StrategySlot;
  title: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <section className="rounded-lg border border-line bg-muted/20 p-5">
      <CardHeader title={props.title} hint={props.hint} />
      <HelpMeWriteThis
        slot={props.slot}
        onAccept={(draft) => {
          if (typeof draft === "string") props.onChange(draft);
        }}
      />
      <textarea
        className="mt-3 w-full resize-y rounded-md border border-line bg-bg/50 px-3 py-2 text-sm text-white/90 placeholder-white/30 focus:border-white/30 focus:outline-none"
        rows={props.rows ?? 3}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder="Leave blank to skip this section."
      />
    </section>
  );
}

function ListCard(props: {
  slot: StrategySlot;
  title: string;
  hint: string;
  values: string[];
  onChange: (v: string[]) => void;
  tone?: "danger" | "success" | "default";
}) {
  const text = props.values.join("\n");
  const pillTone =
    props.tone === "danger"
      ? "border-red-500/30 bg-red-500/10 text-red-200"
      : props.tone === "success"
        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
        : "border-line bg-muted/40 text-white/80";
  return (
    <section className="rounded-lg border border-line bg-muted/20 p-5">
      <CardHeader title={props.title} hint={props.hint} />
      <HelpMeWriteThis
        slot={props.slot}
        onAccept={(draft) => {
          if (Array.isArray(draft)) props.onChange(draft);
        }}
      />
      <textarea
        className="mt-3 w-full resize-y rounded-md border border-line bg-bg/50 px-3 py-2 font-mono text-xs text-white/90 placeholder-white/30 focus:border-white/30 focus:outline-none"
        rows={Math.max(3, props.values.length + 1)}
        value={text}
        onChange={(e) =>
          props.onChange(
            e.target.value
              .split("\n")
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
          )
        }
        placeholder="One entry per line."
      />
      {props.values.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {props.values.map((v) => (
            <span
              key={v}
              className={`rounded-full border px-2 py-0.5 text-xs ${pillTone}`}
            >
              {v}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function CardHeader(props: { title: string; hint: string }) {
  return (
    <>
      <h2 className="text-sm font-semibold text-white/80">{props.title}</h2>
      <p className="mt-1 text-xs text-white/50">{props.hint}</p>
    </>
  );
}

/**
 * Per-slot collaborative drafter. Click "Help me write this" → inline
 * hints input + Generate button. Result renders with Use / Discard.
 * Nothing persists until the parent strategy Save fires.
 */
function HelpMeWriteThis(props: {
  slot: StrategySlot;
  onAccept: (draft: string | string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hints, setHints] = useState("");
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<string | string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDraft(null);
    try {
      const body: Record<string, unknown> = { slot: props.slot };
      if (hints.trim()) body.hints = hints.trim();
      const res = await fetch("/api/strategy/draft-slot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`draft-slot → ${res.status}: ${text.slice(0, 200)}`);
      }
      const payload = (await res.json()) as { draft: string | string[] };
      setDraft(payload.draft);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [hints, props.slot]);

  const accept = useCallback(() => {
    if (draft === null) return;
    props.onAccept(draft);
    setOpen(false);
    setDraft(null);
    setHints("");
  }, [draft, props]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 inline-flex items-center gap-1 rounded-md border border-line bg-muted/40 px-2.5 py-1 text-xs text-white/70 transition hover:border-white/30 hover:text-white"
      >
        <span aria-hidden>✨</span> Help me write this
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-line bg-bg/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-white/60">
          Give Vex a hint (optional) — a theme, a constraint, or what
          you already know. Vex grounds the draft in your counterparty
          + deal evidence plus any slots you&apos;ve already written.
        </p>
        <button
          type="button"
          aria-label="Close drafter"
          onClick={() => {
            setOpen(false);
            setDraft(null);
            setError(null);
          }}
          className="text-white/40 transition hover:text-white/80"
        >
          ×
        </button>
      </div>
      <input
        type="text"
        value={hints}
        onChange={(e) => setHints(e.target.value)}
        placeholder="e.g. focus on Caribbean bunkering"
        className="mt-2 w-full rounded-md border border-line bg-bg/50 px-3 py-1.5 text-sm text-white/90 placeholder-white/30 focus:border-white/30 focus:outline-none"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={loading}
          onClick={generate}
          className="rounded-md bg-white/90 px-3 py-1 text-xs font-medium text-black transition hover:bg-white disabled:opacity-50"
        >
          {loading ? "Drafting…" : draft ? "Regenerate" : "Draft"}
        </button>
        {draft !== null ? (
          <button
            type="button"
            onClick={accept}
            className="rounded-md border border-emerald-500/40 bg-emerald-500/20 px-3 py-1 text-xs font-medium text-emerald-100 transition hover:bg-emerald-500/30"
          >
            Use this
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="mt-2 text-xs text-red-200">{error}</p>
      ) : null}
      {draft !== null ? (
        <div className="mt-3 rounded-md border border-line bg-muted/40 p-3 text-xs text-white/80">
          {Array.isArray(draft) ? (
            <ul className="list-disc space-y-1 pl-4">
              {draft.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          ) : (
            <p className="whitespace-pre-wrap">{draft}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Drop empty strings / empty arrays so the PUT body sends only what
 * the operator populated. Keeps the server-side Zod validator happy
 * (empty string would fail `.min(1)` on array items if we sent them).
 */
function stripEmpties(s: Strategy): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (s.mission?.trim()) out.mission = s.mission.trim();
  if (s.target_markets?.length) out.target_markets = s.target_markets;
  if (s.icp_buyers?.trim()) out.icp_buyers = s.icp_buyers.trim();
  if (s.icp_suppliers?.trim()) out.icp_suppliers = s.icp_suppliers.trim();
  if (s.brand_voice?.trim()) out.brand_voice = s.brand_voice.trim();
  if (s.pricing_philosophy?.trim())
    out.pricing_philosophy = s.pricing_philosophy.trim();
  if (s.no_go_zones?.length) out.no_go_zones = s.no_go_zones;
  if (s.growth_priorities?.length)
    out.growth_priorities = s.growth_priorities;
  if (s.additional_guidance?.trim())
    out.additional_guidance = s.additional_guidance.trim();
  return out;
}
