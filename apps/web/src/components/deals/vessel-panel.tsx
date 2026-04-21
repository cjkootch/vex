"use client";

import { useCallback, useEffect, useState } from "react";
import { FormField, Select, TextInput } from "@/components/ui/form-field";
import { Modal } from "@/components/ui/modal";

/**
 * VesselPanel — inline panel on the deal-overview page. Three states:
 *   1. Empty (no vessel linked) — shows a "Link vessel" CTA that opens
 *      a picker modal listing existing vessels with an inline
 *      "+ New vessel" form.
 *   2. Linked — vessel summary, utilization bar, freight rate vs
 *      market with delta badge, demurrage exposure.
 *   3. Loading / error — minimal placeholders.
 *
 * No external chart lib — utilisation is a CSS bar, freight delta is a
 * coloured chip. The 90-day freight history sparkline is deferred to a
 * later turn (needs a /api/deals/:id/freight-history endpoint).
 */

interface VesselSummary {
  id: string;
  name: string;
  vesselClass: string;
  imoNumber: string | null;
  flag: string | null;
  dwtMt: number | null;
  builtYear: number | null;
}

interface VesselBundle {
  deal: { id: string; dealRef: string; volumeUsg: number; volumeMt: number | null };
  vessel: VesselSummary | null;
  utilization: { pctOfDwt: number | null; pctOnDeal: number | null };
  freightRate: {
    bookedUsdPerMt: number | null;
    lockedAt: string | null;
    source: string | null;
    marketAtLock: number | null;
    demurrageRateUsdPerDay: number | null;
    ballastBonusUsd: number | null;
    charterType: string | null;
  };
  marketRate: {
    currentUsdPerMt: number | null;
    asOfDate: string | null;
    source: string | null;
    lane: { originRegion: string; destinationRegion: string; productCategory: string } | null;
  };
  deviationPct: number | null;
}

const CLASS_LABEL: Record<string, string> = {
  handysize: "Handysize",
  handymax: "Handymax",
  panamax: "Panamax",
  aframax: "Aframax",
  suezmax: "Suezmax",
  vlcc: "VLCC",
  mr_tanker: "MR tanker",
  lr1: "LR1",
  lr2: "LR2",
  coastal: "Coastal",
  barge: "Barge",
  container: "Container",
  reefer: "Reefer",
  bulk_carrier: "Bulk carrier",
};

const CLASS_OPTIONS = Object.entries(CLASS_LABEL).map(([value, label]) => ({
  value,
  label,
}));

const CHARTER_OPTIONS = [
  { value: "", label: "—" },
  { value: "voyage", label: "Voyage" },
  { value: "time", label: "Time" },
  { value: "spot", label: "Spot" },
];

interface Props {
  dealId: string;
}

export function VesselPanel({ dealId }: Props) {
  const [bundle, setBundle] = useState<VesselBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [refreshIdx, setRefreshIdx] = useState(0);

  const reload = useCallback(() => setRefreshIdx((i) => i + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/deals/${dealId}/vessel`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as VesselBundle;
        if (!cancelled) {
          setBundle(body);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [dealId, refreshIdx]);

  return (
    <section className="rounded-lg border border-line bg-muted/20 p-4">
      <header className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Vessel & freight</h3>
        {bundle?.vessel && (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="text-xs text-white/60 hover:text-white"
          >
            Change vessel
          </button>
        )}
      </header>

      {error && (
        <p className="rounded-md border border-bad/40 bg-bad/10 px-2 py-1 text-xs text-bad">
          {error}
        </p>
      )}

      {!bundle ? (
        <p className="text-xs text-white/50">Loading…</p>
      ) : !bundle.vessel ? (
        <EmptyState onLink={() => setPickerOpen(true)} />
      ) : (
        <LinkedState bundle={bundle} />
      )}

      <VesselPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        dealId={dealId}
        onLinked={() => {
          setPickerOpen(false);
          reload();
        }}
      />
    </section>
  );
}

function EmptyState({ onLink }: { onLink: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-white/60">
        No vessel linked yet. Link one to track utilization, freight vs
        market, and demurrage exposure for this deal.
      </p>
      <button
        type="button"
        onClick={onLink}
        className="self-start rounded-md border border-line bg-accent/80 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent"
      >
        Link vessel
      </button>
    </div>
  );
}

function LinkedState({ bundle }: { bundle: VesselBundle }) {
  const v = bundle.vessel!;
  const u =
    bundle.utilization.pctOnDeal ?? bundle.utilization.pctOfDwt ?? null;
  const fr = bundle.freightRate;
  const mr = bundle.marketRate;
  const dev = bundle.deviationPct;

  const charter = fr.charterType ? fr.charterType.toUpperCase() : null;
  const demurrageExposureUsd =
    fr.demurrageRateUsdPerDay !== null
      ? fr.demurrageRateUsdPerDay * 2 // back-of-envelope: assume ~2 days at lay
      : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 text-xs">
        <Field label="Name" value={v.name} />
        <Field
          label="Class"
          value={CLASS_LABEL[v.vesselClass] ?? v.vesselClass}
        />
        <Field label="IMO" value={v.imoNumber ?? "—"} />
        <Field label="Flag" value={v.flag ?? "—"} />
        <Field
          label="DWT"
          value={v.dwtMt ? `${formatInt(v.dwtMt)} MT` : "—"}
        />
        <Field label="Built" value={v.builtYear ? String(v.builtYear) : "—"} />
        {charter && <Field label="Charter" value={charter} />}
      </div>

      <UtilizationBar pct={u} />

      <div className="grid grid-cols-2 gap-2">
        <FreightTile
          label="Booked rate"
          value={fr.bookedUsdPerMt}
          suffix="$/MT"
          {...(fr.lockedAt
            ? { footnote: `Locked ${new Date(fr.lockedAt).toLocaleDateString()}` }
            : {})}
        />
        <FreightTile
          label="Market rate"
          value={mr.currentUsdPerMt}
          suffix="$/MT"
          footnote={
            mr.asOfDate
              ? `${mr.source ?? "manual"} · ${mr.asOfDate}`
              : "no benchmark"
          }
        />
        {dev !== null && (
          <DeviationBadge deviationPct={dev} />
        )}
        {demurrageExposureUsd !== null && (
          <FreightTile
            label="Demurrage / 2d"
            value={demurrageExposureUsd}
            suffix="$"
            footnote="rate × 2 days"
          />
        )}
      </div>
    </div>
  );
}

function UtilizationBar({ pct }: { pct: number | null }) {
  if (pct === null) {
    return (
      <div className="text-[10px] text-white/40">
        Utilization: not set (link vessel + add volumeMt to compute).
      </div>
    );
  }
  const tone =
    pct >= 0.7 ? "bg-good" : pct >= 0.5 ? "bg-warn" : "bg-bad";
  const widthPct = Math.min(100, Math.max(0, pct * 100));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-[10px] text-white/50">
        <span className="uppercase tracking-wide">Utilization</span>
        <span className="text-white">{(pct * 100).toFixed(1)}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-md bg-canvas">
        <div
          className={`h-full ${tone}`}
          style={{ width: `${widthPct}%` }}
        />
      </div>
    </div>
  );
}

function DeviationBadge({ deviationPct }: { deviationPct: number }) {
  const sign = deviationPct >= 0 ? "+" : "";
  const tone =
    Math.abs(deviationPct) >= 0.2
      ? "border-bad/40 bg-bad/10 text-bad"
      : Math.abs(deviationPct) >= 0.1
        ? "border-warn/40 bg-warn/10 text-warn"
        : "border-good/40 bg-good/10 text-good";
  return (
    <div className={`rounded-md border px-2 py-1.5 text-xs ${tone}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-70">
        Booked vs market
      </div>
      <div className="mt-0.5 font-semibold tabular-nums">
        {sign}
        {(deviationPct * 100).toFixed(1)}%
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-white/40">
        {label}
      </div>
      <div className="mt-0.5 text-white">{value}</div>
    </div>
  );
}

function FreightTile({
  label,
  value,
  suffix,
  footnote,
}: {
  label: string;
  value: number | null;
  suffix: string;
  footnote?: string;
}) {
  return (
    <div className="rounded-md border border-line bg-canvas/60 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-white/40">
        {label}
      </div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums text-white">
        {value !== null ? `${formatNum(value)} ${suffix}` : "—"}
      </div>
      {footnote && (
        <div className="text-[10px] text-white/40">{footnote}</div>
      )}
    </div>
  );
}

function formatNum(n: number): string {
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return n.toFixed(2);
}

function formatInt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

// ---------------------------------------------------------------------------
// Picker
// ---------------------------------------------------------------------------

interface PickerVessel {
  id: string;
  name: string;
  vesselClass: string;
  imoNumber: string | null;
  flag: string | null;
  dwtMt: number | null;
}

function VesselPicker({
  open,
  onClose,
  dealId,
  onLinked,
}: {
  open: boolean;
  onClose: () => void;
  dealId: string;
  onLinked: () => void;
}) {
  const [vessels, setVessels] = useState<PickerVessel[]>([]);
  const [search, setSearch] = useState("");
  const [linking, setLinking] = useState<string | null>(null);
  const [charter, setCharter] = useState<string>("");
  const [bookedRate, setBookedRate] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createState, setCreateState] = useState({
    name: "",
    vesselClass: "mr_tanker",
    imoNumber: "",
    flag: "",
    dwtMt: "",
  });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/vessels", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as { vessels: PickerVessel[] };
        if (!cancelled) {
          setVessels(body.vessels);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const filtered = vessels.filter((v) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      v.name.toLowerCase().includes(q) ||
      (v.imoNumber ?? "").toLowerCase().includes(q)
    );
  });

  async function link(vesselId: string): Promise<void> {
    setLinking(vesselId);
    setError(null);
    try {
      const body: Record<string, unknown> = { vesselId };
      if (charter) body["charterType"] = charter;
      const rate = Number.parseFloat(bookedRate);
      if (Number.isFinite(rate) && rate > 0) body["freightRateUsdPerMt"] = rate;
      const res = await fetch(`/api/deals/${dealId}/vessel`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(errBody.message ?? `HTTP ${res.status}`);
      }
      onLinked();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLinking(null);
    }
  }

  async function createVessel(): Promise<void> {
    if (!createState.name.trim()) {
      setError("Vessel name is required.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: createState.name.trim(),
        vesselClass: createState.vesselClass,
      };
      if (createState.imoNumber.trim()) body["imoNumber"] = createState.imoNumber.trim();
      if (createState.flag.trim()) body["flag"] = createState.flag.trim().toUpperCase();
      const dwt = Number.parseFloat(createState.dwtMt);
      if (Number.isFinite(dwt) && dwt > 0) body["dwtMt"] = dwt;
      const res = await fetch("/api/vessels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(errBody.message ?? `HTTP ${res.status}`);
      }
      const created = (await res.json()) as { vessel: PickerVessel };
      setVessels((prev) => [created.vessel, ...prev]);
      setShowCreate(false);
      // Auto-link the just-created vessel.
      await link(created.vessel.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Link vessel"
      description="Pick an existing vessel or add a new one. The freight rate
      you enter is locked at link time and benchmarked against today's
      market for deviation alerts."
      size="xl"
    >
      <div className="flex flex-col gap-4">
        {error && (
          <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
            {error}
          </p>
        )}

        <div className="grid grid-cols-3 gap-3">
          <FormField label="Charter type">
            <Select
              value={charter}
              onChange={(e) => setCharter(e.target.value)}
              options={CHARTER_OPTIONS}
            />
          </FormField>
          <FormField
            label="Booked freight rate"
            hint="USD per MT"
          >
            <TextInput
              type="number"
              inputMode="decimal"
              value={bookedRate}
              onChange={(e) => setBookedRate(e.target.value)}
              step="0.01"
              min="0"
              placeholder="28.50"
            />
          </FormField>
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => setShowCreate((s) => !s)}
              className="rounded-md border border-line px-3 py-2 text-sm text-white/80 hover:border-accent hover:text-white"
            >
              {showCreate ? "Cancel new vessel" : "+ New vessel"}
            </button>
          </div>
        </div>

        {showCreate && (
          <div className="rounded-md border border-line bg-canvas/40 p-3">
            <div className="grid grid-cols-3 gap-3">
              <FormField label="Name" required>
                <TextInput
                  value={createState.name}
                  onChange={(e) =>
                    setCreateState((s) => ({ ...s, name: e.target.value }))
                  }
                  placeholder="MT Caribbean Pioneer"
                />
              </FormField>
              <FormField label="Class" required>
                <Select
                  value={createState.vesselClass}
                  onChange={(e) =>
                    setCreateState((s) => ({
                      ...s,
                      vesselClass: e.target.value,
                    }))
                  }
                  options={CLASS_OPTIONS}
                />
              </FormField>
              <FormField label="IMO (7 digits)">
                <TextInput
                  value={createState.imoNumber}
                  onChange={(e) =>
                    setCreateState((s) => ({ ...s, imoNumber: e.target.value }))
                  }
                  placeholder="9123456"
                  maxLength={7}
                />
              </FormField>
              <FormField label="Flag (ISO 2-letter)">
                <TextInput
                  value={createState.flag}
                  onChange={(e) =>
                    setCreateState((s) => ({ ...s, flag: e.target.value }))
                  }
                  placeholder="LR"
                  maxLength={2}
                />
              </FormField>
              <FormField label="DWT (MT)">
                <TextInput
                  type="number"
                  inputMode="decimal"
                  value={createState.dwtMt}
                  onChange={(e) =>
                    setCreateState((s) => ({ ...s, dwtMt: e.target.value }))
                  }
                  step="100"
                  min="0"
                  placeholder="48000"
                />
              </FormField>
              <div className="flex items-end justify-end">
                <button
                  type="button"
                  onClick={createVessel}
                  disabled={creating}
                  className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
                >
                  {creating ? "Creating…" : "Create + link"}
                </button>
              </div>
            </div>
          </div>
        )}

        <FormField label="Search existing">
          <TextInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name or IMO"
          />
        </FormField>

        <div className="max-h-[40vh] overflow-y-auto rounded-md border border-line">
          {filtered.length === 0 ? (
            <p className="p-3 text-sm text-white/50">
              No vessels match. Use the &ldquo;+ New vessel&rdquo; button above.
            </p>
          ) : (
            <ul className="divide-y divide-line/60">
              {filtered.map((v) => (
                <li
                  key={v.id}
                  className="flex items-center justify-between px-3 py-2 text-sm"
                >
                  <div>
                    <div className="font-medium text-white">{v.name}</div>
                    <div className="text-[11px] text-white/50">
                      {CLASS_LABEL[v.vesselClass] ?? v.vesselClass}
                      {v.imoNumber ? ` · IMO ${v.imoNumber}` : ""}
                      {v.flag ? ` · ${v.flag}` : ""}
                      {v.dwtMt ? ` · ${formatInt(v.dwtMt)} DWT` : ""}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => link(v.id)}
                    disabled={linking !== null}
                    className="rounded-md border border-line bg-accent/70 px-3 py-1 text-xs font-medium text-white hover:bg-accent disabled:opacity-40"
                  >
                    {linking === v.id ? "Linking…" : "Link"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
