"use client";

import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";

interface Product {
  id: string;
  product: string;
  notes: string | null;
  addedAt: string;
}

const PRODUCT_OPTIONS: Array<{ value: string; label: string; group: string }> = [
  { value: "ulsd", label: "ULSD", group: "Fuel" },
  { value: "gasoline_87", label: "Gasoline 87", group: "Fuel" },
  { value: "gasoline_91", label: "Gasoline 91", group: "Fuel" },
  { value: "jet_a", label: "Jet A", group: "Fuel" },
  { value: "jet_a1", label: "Jet A1", group: "Fuel" },
  { value: "avgas", label: "Avgas", group: "Fuel" },
  { value: "lfo", label: "LFO", group: "Fuel" },
  { value: "hfo", label: "HFO", group: "Fuel" },
  { value: "lng", label: "LNG", group: "Fuel" },
  { value: "lpg", label: "LPG", group: "Fuel" },
  { value: "biodiesel_b20", label: "Biodiesel B20", group: "Fuel" },
  { value: "rice", label: "Rice", group: "Food" },
  { value: "beans", label: "Beans", group: "Food" },
  { value: "pork", label: "Pork", group: "Food" },
  { value: "chicken", label: "Chicken", group: "Food" },
  { value: "cooking_oil", label: "Cooking oil", group: "Food" },
  { value: "powdered_milk", label: "Powdered milk", group: "Food" },
];

export function OrgProductsPanel({ orgId }: { orgId: string }): React.ReactElement {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/organizations/${orgId}/products`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as { products: Product[] };
      setProducts(body.products);
    } catch (err) {
      setError((err as Error).message);
      setProducts([]);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(): Promise<void> {
    if (!selectedProduct) return;
    setAdding(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/products`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          product: selectedProduct,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setSelectedProduct("");
      setNotes("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      const res = await fetch(`/api/organizations/${orgId}/products/${id}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-2 rounded-lg border border-line bg-muted/20 p-3">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-white/50">
            Product
          </span>
          <select
            value={selectedProduct}
            onChange={(e) => setSelectedProduct(e.target.value)}
            className="rounded-md border border-line bg-canvas px-2 py-1.5 text-sm text-white focus:border-accent focus:outline-none"
          >
            <option value="">— pick —</option>
            <optgroup label="Fuel">
              {PRODUCT_OPTIONS.filter((p) => p.group === "Fuel").map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Food">
              {PRODUCT_OPTIONS.filter((p) => p.group === "Food").map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label className="flex flex-[2] flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-white/50">
            Notes (optional)
          </span>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Thai origin, 5% broken"
            className="rounded-md border border-line bg-canvas px-2 py-1.5 text-sm text-white focus:border-accent focus:outline-none"
          />
        </label>
        <button
          type="button"
          onClick={() => void add()}
          disabled={adding || !selectedProduct}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-canvas hover:bg-accent/80 disabled:opacity-50"
        >
          {adding ? "Adding…" : "Add"}
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">
          {error}
        </div>
      )}

      {products === null ? (
        <div className="text-sm text-white/50">Loading…</div>
      ) : products.length === 0 ? (
        <div className="rounded-md border border-line bg-muted/20 px-3 py-4 text-sm text-white/50">
          No products tagged yet. For a broker, add every product they can
          quote — even when the upstream supplier is unknown.
        </div>
      ) : (
        <ol className="flex flex-col gap-2">
          {products.map((p) => (
            <li
              key={p.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-line bg-muted/20 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent">
                    {PRODUCT_OPTIONS.find((o) => o.value === p.product)?.label ?? p.product}
                  </span>
                  <span className="text-[11px] text-white/40">
                    added{" "}
                    {formatDistanceToNow(new Date(p.addedAt), {
                      addSuffix: true,
                    })}
                  </span>
                </div>
                {p.notes && (
                  <div className="mt-0.5 text-xs text-white/60">{p.notes}</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => void remove(p.id)}
                className="shrink-0 text-xs text-white/40 hover:text-bad"
              >
                Remove
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
