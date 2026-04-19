"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface Relationship {
  id: string;
  fromOrgId: string;
  toOrgId: string;
  relationshipType: string;
  product: string | null;
  notes: string | null;
  addedAt: string;
}

interface OrgOption {
  id: string;
  legalName: string;
}

const TYPE_OPTIONS = [
  { value: "brokers_for", label: "Brokers for" },
  { value: "sources_from", label: "Sources from" },
  { value: "partners_with", label: "Partners with" },
  { value: "subsidiary_of", label: "Subsidiary of" },
] as const;

const TYPE_LABEL: Record<string, string> = {
  brokers_for: "brokers for",
  sources_from: "sources from",
  partners_with: "partners with",
  subsidiary_of: "subsidiary of",
};

export function OrgRelationshipsPanel({
  orgId,
}: {
  orgId: string;
}): React.ReactElement {
  const [rels, setRels] = useState<Relationship[] | null>(null);
  const [orgOptions, setOrgOptions] = useState<OrgOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [toOrgId, setToOrgId] = useState("");
  const [relType, setRelType] = useState<(typeof TYPE_OPTIONS)[number]["value"]>(
    "brokers_for",
  );
  const [product, setProduct] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/organizations/${orgId}/relationships`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as { relationships: Relationship[] };
      setRels(body.relationships);
    } catch (err) {
      setError((err as Error).message);
      setRels([]);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void fetch("/api/organizations")
      .then((r) => r.json())
      .then((body: { organizations: OrgOption[] }) =>
        setOrgOptions(body.organizations ?? []),
      )
      .catch(() => setOrgOptions([]));
  }, []);

  async function add(): Promise<void> {
    if (!toOrgId) return;
    setAdding(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/relationships`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          toOrgId,
          relationshipType: relType,
          ...(product ? { product } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(body.message ?? `${res.status} ${res.statusText}`);
      }
      setToOrgId("");
      setProduct("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/relationships/${id}`,
        { method: "DELETE" },
      );
      if (!res.ok && res.status !== 204) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function nameFor(id: string): string {
    return orgOptions.find((o) => o.id === id)?.legalName ?? id;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-muted/20 p-3 md:flex-row md:items-end">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-white/50">
            Relationship
          </span>
          <select
            value={relType}
            onChange={(e) =>
              setRelType(e.target.value as (typeof TYPE_OPTIONS)[number]["value"])
            }
            className="rounded-md border border-line bg-canvas px-2 py-1.5 text-sm text-white"
          >
            {TYPE_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-white/50">
            Counterparty
          </span>
          <select
            value={toOrgId}
            onChange={(e) => setToOrgId(e.target.value)}
            className="rounded-md border border-line bg-canvas px-2 py-1.5 text-sm text-white"
          >
            <option value="">— pick —</option>
            {orgOptions
              .filter((o) => o.id !== orgId)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.legalName}
                </option>
              ))}
          </select>
        </label>
        <label className="flex w-32 flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-white/50">
            Product (optional)
          </span>
          <input
            type="text"
            value={product}
            onChange={(e) => setProduct(e.target.value)}
            placeholder="e.g. rice"
            className="rounded-md border border-line bg-canvas px-2 py-1.5 text-sm text-white"
          />
        </label>
        <button
          type="button"
          onClick={() => void add()}
          disabled={adding || !toOrgId}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-canvas hover:bg-accent/80 disabled:opacity-50"
        >
          {adding ? "Linking…" : "Link"}
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">
          {error}
        </div>
      )}

      {rels === null ? (
        <div className="text-sm text-white/50">Loading…</div>
      ) : rels.length === 0 ? (
        <div className="rounded-md border border-line bg-muted/20 px-3 py-4 text-sm text-white/50">
          No relationships recorded. When this org brokers for someone, sources
          from someone, or partners with someone, add the link so Vex can
          reason about the supply graph.
        </div>
      ) : (
        <ol className="flex flex-col gap-2">
          {rels.map((r) => {
            const outbound = r.fromOrgId === orgId;
            const otherId = outbound ? r.toOrgId : r.fromOrgId;
            return (
              <li
                key={r.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-line bg-muted/20 px-3 py-2"
              >
                <div className="min-w-0 flex-1 text-sm">
                  <div className="text-white">
                    <span className="text-white/50">
                      {outbound ? "this org" : nameFor(otherId)}
                    </span>{" "}
                    <span className="text-accent">
                      {TYPE_LABEL[r.relationshipType] ?? r.relationshipType}
                    </span>{" "}
                    <Link
                      href={`/app/companies/${outbound ? r.toOrgId : r.fromOrgId}`}
                      className="hover:text-accent hover:underline"
                    >
                      {outbound ? nameFor(r.toOrgId) : "this org"}
                    </Link>
                    {r.product && (
                      <span className="ml-2 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-white/60">
                        {r.product}
                      </span>
                    )}
                  </div>
                  {r.notes && (
                    <div className="mt-0.5 text-xs text-white/60">{r.notes}</div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void remove(r.id)}
                  className="shrink-0 text-xs text-white/40 hover:text-bad"
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
