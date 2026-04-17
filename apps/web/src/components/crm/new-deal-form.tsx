"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "@/components/ui/modal";
import { FormField, Select, TextArea, TextInput } from "@/components/ui/form-field";

export interface NewDealFormProps {
  open: boolean;
  onClose: () => void;
  onCreated: (deal: { id: string; dealRef: string }) => void;
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

export function NewDealForm({ open, onClose, onCreated }: NewDealFormProps) {
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [dealRef, setDealRef] = useState("");
  const [product, setProduct] = useState("ulsd");
  const [incoterm, setIncoterm] = useState("cfr");
  const [pricingBasis, setPricingBasis] = useState("platts");
  const [paymentTerms, setPaymentTerms] = useState("lc_sight");
  const [volumeUsg, setVolumeUsg] = useState("");
  const [densityKgL, setDensityKgL] = useState("0.84");
  const [buyerOrgId, setBuyerOrgId] = useState("");
  const [destinationPort, setDestinationPort] = useState("");
  const [laycanStart, setLaycanStart] = useState("");
  const [laycanEnd, setLaycanEnd] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/organizations")
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        const body = (await res.json()) as { organizations: OrgOption[] };
        if (!cancelled) {
          setOrgs(body.organizations);
          if (!buyerOrgId && body.organizations[0]) {
            setBuyerOrgId(body.organizations[0].id);
          }
        }
      })
      .catch(() => {
        /* ignored */
      });
    return () => {
      cancelled = true;
    };
  }, [open, buyerOrgId]);

  function reset(): void {
    setDealRef("");
    setProduct("ulsd");
    setIncoterm("cfr");
    setPricingBasis("platts");
    setPaymentTerms("lc_sight");
    setVolumeUsg("");
    setDensityKgL("0.84");
    setBuyerOrgId("");
    setDestinationPort("");
    setLaycanStart("");
    setLaycanEnd("");
    setNotes("");
    setError(null);
    setSubmitting(false);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    if (!dealRef.trim()) return setError("Deal reference is required.");
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
      const res = await fetch("/api/deals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dealRef: dealRef.trim(),
          product,
          incoterm,
          pricingBasis,
          paymentTerms,
          volumeUsg: vol,
          densityKgL: density,
          buyerOrgId,
          ...(destinationPort.trim()
            ? { destinationPort: destinationPort.trim() }
            : {}),
          ...(laycanStart ? { laycanStart } : {}),
          ...(laycanEnd ? { laycanEnd } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as {
        deal: { id: string; dealRef: string };
      };
      onCreated(body.deal);
      reset();
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
        if (!submitting) {
          reset();
          onClose();
        }
      }}
      title="New deal"
      description="Creates a fuel deal in draft status."
    >
      <form
        onSubmit={onSubmit}
        className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto pr-1"
      >
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Deal reference" required>
            <TextInput
              value={dealRef}
              onChange={(e) => setDealRef(e.target.value)}
              placeholder="VTC-2026-010"
              autoFocus
              maxLength={50}
            />
          </FormField>

          <FormField label="Buyer" required>
            <Select
              value={buyerOrgId}
              onChange={(e) => setBuyerOrgId(e.target.value)}
              options={
                orgs.length === 0
                  ? [{ value: "", label: "Loading…" }]
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
            onClick={() => {
              reset();
              onClose();
            }}
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
            {submitting ? "Creating…" : "Create deal"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
