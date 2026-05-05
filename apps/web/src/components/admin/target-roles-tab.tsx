"use client";

import { useEffect, useMemo, useState } from "react";
import type { WorkspaceSettings } from "./admin-console";

/**
 * Admin → Target roles tab. Per-category title lists the chat agent
 * uses to (a) bias `research_contact` Tavily queries toward the
 * right people, and (b) populate options on a clarifying question
 * when the operator's enrichment intent is vague ("find someone at
 * Vitol" → "Which function — fuel procurement, trading desk, or
 * operations?").
 *
 * One section per category. Each category is a free-form key
 * matching the org's `kind` / product mix (fuel, food, etc.) plus
 * an ordered list of target titles. Save flows through
 * `onPatch({ target_roles_by_category })` — empty list per category
 * removes that category, empty record clears the registry entirely.
 */
export function TargetRolesTab({
  settings,
  onPatch,
}: {
  settings: WorkspaceSettings | null;
  onPatch: (patch: Partial<WorkspaceSettings>) => Promise<boolean>;
}): React.ReactElement {
  const stored = useMemo(
    () => settings?.target_roles_by_category ?? {},
    [settings?.target_roles_by_category],
  );

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    // Roundtrip stored map → editable text-area-friendly shape:
    // category → comma-separated string. Loaded from settings on
    // mount + on any external refresh.
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(stored)) {
      next[k] = (v ?? []).join(", ");
    }
    setDraft(next);
    setError(null);
    setSaved(false);
  }, [stored]);

  const [newKey, setNewKey] = useState("");

  const dirty = useMemo(() => {
    const a = serialiseDraft(draft);
    const b = stored;
    if (Object.keys(a).length !== Object.keys(b).length) return true;
    for (const [k, v] of Object.entries(a)) {
      const stored_v = b[k] ?? [];
      if (
        stored_v.length !== v.length ||
        stored_v.some((x, i) => x !== v[i])
      ) {
        return true;
      }
    }
    return false;
  }, [draft, stored]);

  const save = async (): Promise<void> => {
    setError(null);
    setSaving(true);
    setSaved(false);
    const next = serialiseDraft(draft);
    for (const k of Object.keys(next)) {
      if (!/^[a-z0-9_-]+$/.test(k)) {
        setSaving(false);
        setError(
          `Category key "${k}" must be lowercase letters, numbers, _ or -.`,
        );
        return;
      }
    }
    const ok = await onPatch({ target_roles_by_category: next });
    setSaving(false);
    if (ok) setSaved(true);
  };

  return (
    <section className="flex flex-col gap-8">
      <header>
        <h2 className="text-lg font-semibold text-text-primary">
          Target roles by category
        </h2>
        <p className="mt-1 max-w-2xl text-xs text-text-secondary">
          Per-category title lists Vex uses when enriching contacts.
          When you ask for an enrichment without naming a role
          (&ldquo;find someone at Vitol&rdquo;), the chat agent picks
          options from the matching category to ask which function
          you want — and biases the underlying Tavily search toward
          those titles. Order matters: titles higher on the list win
          when ranking enrichment candidates.
        </p>
        <p className="mt-2 max-w-2xl text-xs text-text-secondary/80">
          Category keys are workspace-defined and should match how
          you classify orgs (e.g. <code className="rounded bg-muted/40 px-1">fuel</code>,{" "}
          <code className="rounded bg-muted/40 px-1">food</code>,{" "}
          <code className="rounded bg-muted/40 px-1">petrochemical</code>).
        </p>
      </header>

      <div className="flex flex-col gap-4">
        {Object.keys(draft).length === 0 ? (
          <p className="rounded-md border border-line bg-muted/20 px-3 py-4 text-xs text-text-secondary">
            No categories registered yet. Add one below to start
            biasing enrichment toward the roles that matter to your
            workflow.
          </p>
        ) : (
          Object.entries(draft).map(([category, csv]) => (
            <CategoryCard
              key={category}
              category={category}
              csv={csv}
              onChange={(nextCsv) =>
                setDraft((d) => ({ ...d, [category]: nextCsv }))
              }
              onDelete={() => {
                if (
                  confirm(`Remove the "${category}" target-role list?`)
                ) {
                  setDraft((d) => {
                    const { [category]: _drop, ...rest } = d;
                    void _drop;
                    return rest;
                  });
                }
              }}
            />
          ))
        )}
      </div>

      <div className="flex items-end gap-2">
        <label className="flex flex-1 flex-col gap-1.5">
          <span className="text-xs uppercase tracking-wide text-text-secondary">
            Add category
          </span>
          <input
            className={INPUT}
            value={newKey}
            placeholder="e.g. fuel, food, petrochemical"
            spellCheck={false}
            onChange={(e) => setNewKey(e.target.value.toLowerCase().trim())}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newKey) {
                e.preventDefault();
                if (newKey in draft) {
                  setError(`Category "${newKey}" already exists.`);
                  return;
                }
                if (!/^[a-z0-9_-]+$/.test(newKey)) {
                  setError(
                    "Category key must be lowercase letters, numbers, _ or -.",
                  );
                  return;
                }
                setDraft((d) => ({ ...d, [newKey]: "" }));
                setNewKey("");
                setError(null);
              }
            }}
          />
        </label>
        <button
          type="button"
          onClick={() => {
            if (!newKey) return;
            if (newKey in draft) {
              setError(`Category "${newKey}" already exists.`);
              return;
            }
            if (!/^[a-z0-9_-]+$/.test(newKey)) {
              setError(
                "Category key must be lowercase letters, numbers, _ or -.",
              );
              return;
            }
            setDraft((d) => ({ ...d, [newKey]: "" }));
            setNewKey("");
            setError(null);
          }}
          className={SMALL_BUTTON}
        >
          + Add
        </button>
      </div>

      {error ? (
        <p className="rounded bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-3">
        {saved ? (
          <span className="text-xs text-good" role="status">
            Saved.
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => {
            void save();
          }}
          disabled={!dirty || saving}
          className={`${SMALL_BUTTON} bg-accent/80 text-white disabled:opacity-50`}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}

function CategoryCard({
  category,
  csv,
  onChange,
  onDelete,
}: {
  category: string;
  csv: string;
  onChange: (csv: string) => void;
  onDelete: () => void;
}): React.ReactElement {
  const titles = csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return (
    <div className="rounded-lg border border-line bg-muted/20 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-sm text-text-primary">{category}</span>
        <button
          type="button"
          onClick={onDelete}
          className={`${SMALL_BUTTON} text-red-400 hover:text-red-300`}
        >
          Delete
        </button>
      </div>
      <textarea
        className={`${INPUT} min-h-[60px] font-mono text-xs`}
        value={csv}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Fuel Procurement Manager, Trading Desk Lead, Spot Operations, Logistics Director"
      />
      <p className="mt-1.5 text-[11px] text-text-secondary/80">
        Titles are comma-separated; first wins on ranking ties.
      </p>
      {titles.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {titles.map((t, i) => (
            <span
              key={`${t}-${i}`}
              className="rounded bg-muted/40 px-1.5 py-px font-mono text-[10px] text-text-secondary"
            >
              {t}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function serialiseDraft(
  draft: Record<string, string>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [category, csv] of Object.entries(draft)) {
    const seen = new Set<string>();
    const titles: string[] = [];
    for (const raw of csv.split(",")) {
      const trimmed = raw.trim();
      const key = trimmed.toLowerCase();
      if (!trimmed || seen.has(key)) continue;
      seen.add(key);
      titles.push(trimmed);
    }
    if (titles.length > 0) out[category] = titles;
  }
  return out;
}

const INPUT =
  "w-full rounded border border-line bg-canvas/50 px-3 py-2 text-sm text-text-primary outline-none focus:border-accent";

const SMALL_BUTTON =
  "rounded border border-line bg-muted/40 px-3 py-1 text-xs text-text-primary hover:bg-muted/60";
