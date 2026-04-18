"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "@/components/ui/modal";
import { FormField, Select, TextArea, TextInput } from "@/components/ui/form-field";

/**
 * Shape mirrors the DealDetail type exported from the detail page —
 * kept local so this module doesn't pull a page-level import.
 */
export interface EditableDeal {
  id: string;
  dealRef: string;
  status: string;
  product: string;
  buyerOrgId: string;
  buyerName: string | null;
  sellerOrgId: string | null;
  sellerName: string | null;
  volumeUsg: number;
  incoterm: string;
  laycanStart: string | null;
  laycanEnd: string | null;
  paymentTerms: string;
  originPort: string | null;
  destinationPort: string | null;
  notes: string | null;
}

export interface EditDealFormProps {
  open: boolean;
  deal: EditableDeal;
  onClose: () => void;
  onSaved: (updatedDeal: EditableDeal) => void;
}

interface OrgOption {
  id: string;
  legalName: string;
}

const PRODUCT_OPTIONS = [
  { value: "ulsd", label: "ULSD (Ultra Low Sulfur Diesel)" },
  { value: "gasoline_87", label: "Gasoline 87" },
  { value: "gasoline_91", label: "Gasoline 91" },
  { value: "jet_a", label: "Jet A (US)" },
  { value: "jet_a1", label: "Jet A1 (Intl)" },
  { value: "avgas", label: "Avgas" },
  { value: "lfo", label: "LFO (Light Fuel Oil)" },
  { value: "hfo", label: "HFO (Heavy Fuel Oil)" },
  { value: "lng", label: "LNG" },
  { value: "lpg", label: "LPG" },
  { value: "biodiesel_b20", label: "Biodiesel B20" },
];

const INCOTERM_OPTIONS = [
  { value: "fob", label: "FOB" },
  { value: "cif", label: "CIF" },
  { value: "cfr", label: "CFR" },
  { value: "dap", label: "DAP" },
  { value: "exw", label: "EXW" },
  { value: "fas", label: "FAS" },
];

const PRICING_OPTIONS = [
  { value: "platts", label: "Platts" },
  { value: "argus", label: "Argus" },
  { value: "opis", label: "OPIS" },
  { value: "nymex_wti", label: "NYMEX WTI" },
  { value: "nymex_rbob", label: "NYMEX RBOB" },
  { value: "ice_brent", label: "ICE Brent" },
  { value: "fixed", label: "Fixed" },
  { value: "negotiated", label: "Negotiated" },
];

const PAYMENT_OPTIONS = [
  { value: "prepayment_100", label: "Prepayment 100%" },
  { value: "prepayment_80_20", label: "Prepayment 80/20" },
  { value: "lc_sight", label: "LC Sight" },
  { value: "lc_60d", label: "LC 60 days" },
  { value: "lc_90d", label: "LC 90 days" },
  { value: "lc_120d", label: "LC 120 days" },
  { value: "sblc", label: "SBLC" },
  { value: "open_account", label: "Open account" },
  { value: "telegraphic_transfer", label: "Telegraphic transfer" },
  { value: "mixed", label: "Mixed" },
];

/**
 * "Edit deal" modal — PATCH /api/deals/:id. Mirrors NewDealForm for
 * visuals; omits `dealRef` (immutable) and `status` (own endpoint) as
 * those are forbidden by the upstream PATCH handler. Pricing basis
 * isn't surfaced on the detail page yet so we skip it from the edit
 * form too — the upstream still accepts it if callers ever pass it.
 */
export function EditDealForm({ open, deal, onClose, onSaved }: EditDealFormProps) {
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [product, setProduct] = useState(deal.product);
  const [incoterm, setIncoterm] = useState(deal.incoterm);
  const [pricingBasis, setPricingBasis] = useState("platts");
  const [paymentTerms, setPaymentTerms] = useState(deal.paymentTerms);
  const [volumeUsg, setVolumeUsg] = useState(String(deal.volumeUsg));
  const [densityKgL, setDensityKgL] = useState("0.84");
  const [buyerOrgId, setBuyerOrgId] = useState(deal.buyerOrgId);
  const [originPort, setOriginPort] = useState(deal.originPort ?? "");
  const [destinationPort, setDestinationPort] = useState(
    deal.destinationPort ?? "",
  );
  const [laycanStart, setLaycanStart] = useState(deal.laycanStart ?? "");
  const [laycanEnd, setLaycanEnd] = useState(deal.laycanEnd ?? "");
  const [notes, setNotes] = useState(deal.notes ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset internal state whenever the caller opens the modal with a
  // different deal — prefill everything from the current row.
  useEffect(() => {
    if (!open) return;
    setProduct(deal.product);
    setIncoterm(deal.incoterm);
    setPaymentTerms(deal.paymentTerms);
    setVolumeUsg(String(deal.volumeUsg));
    setBuyerOrgId(deal.buyerOrgId);
    setOriginPort(deal.originPort ?? "");
    setDestinationPort(deal.destinationPort ?? "");
    setLaycanStart(deal.laycanStart ?? "");
    setLaycanEnd(deal.laycanEnd ?? "");
    setNotes(deal.notes ?? "");
    setError(null);
  }, [open, deal]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/organizations")
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        const body = (await res.json()) as { organizations: OrgOption[] };
        if (!cancelled) setOrgs(body.organizations);
      })
      .catch(() => {
        /* ignored */
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    if (!buyerOrgId) return setError("Pick a buyer company.");
    const vol = Number.parseFloat(volumeUsg);
    if (!Number.isFinite(vol) || vol <= 0)
      return setError("Volume (USG) must be a positive number.");
    const density = Number.parseFloat(densityKgL);
    if (!Number.isFinite(density) || density <= 0 || density > 2)
      return setError("Density (kg/L) must be between 0 and 2.");

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/deals/${deal.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          product,
          incoterm,
          pricingBasis,
          paymentTerms,
          volumeUsg: vol,
          densityKgL: density,
          buyerOrgId,
          originPort: originPort.trim() ? originPort.trim() : null,
          destinationPort: destinationPort.trim()
            ? destinationPort.trim()
            : null,
          laycanStart: laycanStart || null,
          laycanEnd: laycanEnd || null,
          notes: notes.trim() ? notes.trim() : null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as { deal: EditableDeal };
      onSaved(body.deal);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!submitting) onClose();
      }}
      title={`Edit ${deal.dealRef}`}
      description="Edits apply immediately. Status changes use the status menu."
    >
      <form
        onSubmit={onSubmit}
        className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto pr-1"
      >
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Buyer" required>
            <Select
              value={buyerOrgId}
              onChange={(e) => setBuyerOrgId(e.target.value)}
              options={
                orgs.length === 0
                  ? [
                      {
                        value: buyerOrgId,
                        label: deal.buyerName ?? buyerOrgId,
                      },
                    ]
                  : orgs.map((o) => ({ value: o.id, label: o.legalName }))
              }
            />
          </FormField>

          <FormField label="Product" required>
            <Select
              value={product}
              onChange={(e) => setProduct(e.target.value)}
              options={PRODUCT_OPTIONS}
            />
          </FormField>

          <FormField label="Incoterm" required>
            <Select
              value={incoterm}
              onChange={(e) => setIncoterm(e.target.value)}
              options={INCOTERM_OPTIONS}
            />
          </FormField>

          <FormField label="Pricing basis" required>
            <Select
              value={pricingBasis}
              onChange={(e) => setPricingBasis(e.target.value)}
              options={PRICING_OPTIONS}
            />
          </FormField>

          <FormField label="Payment terms" required>
            <Select
              value={paymentTerms}
              onChange={(e) => setPaymentTerms(e.target.value)}
              options={PAYMENT_OPTIONS}
            />
          </FormField>

          <FormField label="Volume (USG)" required>
            <TextInput
              type="number"
              inputMode="decimal"
              value={volumeUsg}
              onChange={(e) => setVolumeUsg(e.target.value)}
              placeholder="3000000"
              min="1"
            />
          </FormField>

          <FormField label="Density (kg/L)" required hint="ULSD ≈ 0.84">
            <TextInput
              type="number"
              inputMode="decimal"
              value={densityKgL}
              onChange={(e) => setDensityKgL(e.target.value)}
              step="0.001"
              min="0.1"
              max="2"
            />
          </FormField>

          <FormField label="Origin port">
            <TextInput
              value={originPort}
              onChange={(e) => setOriginPort(e.target.value)}
              placeholder="Houston"
            />
          </FormField>

          <FormField label="Destination port">
            <TextInput
              value={destinationPort}
              onChange={(e) => setDestinationPort(e.target.value)}
              placeholder="Kingston"
            />
          </FormField>

          <FormField label="Laycan start">
            <TextInput
              type="date"
              value={laycanStart}
              onChange={(e) => setLaycanStart(e.target.value)}
            />
          </FormField>

          <FormField label="Laycan end">
            <TextInput
              type="date"
              value={laycanEnd}
              onChange={(e) => setLaycanEnd(e.target.value)}
            />
          </FormField>
        </div>

        <FormField label="Notes">
          <TextArea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Internal trading notes…"
          />
        </FormField>

        {error && (
          <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
            {error}
          </div>
        )}

        <div className="sticky bottom-0 mt-2 flex justify-end gap-2 border-t border-line bg-canvas pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-white/80 hover:border-accent hover:text-white disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-40"
          >
            {submitting ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
