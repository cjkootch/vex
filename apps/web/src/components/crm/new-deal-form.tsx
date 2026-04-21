"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Modal } from "@/components/ui/modal";
import { FormField, Select, TextArea, TextInput } from "@/components/ui/form-field";
import { DealCreatorDashboard, type CalculatePayload } from "@/components/crm/deal-creator-dashboard";
import type {
  BuyerIntel,
  CalculatorResponse,
  MarketRate,
} from "@/components/crm/deal-calculator-types";
import {
  ParticipantEditor,
  commissionPerUsg,
  type ParticipantDraft,
} from "@/components/crm/participant-editor";

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

const FREQUENCY_OPTIONS = [
  { value: "one_off", label: "One-off" },
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Bi-weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "custom", label: "Custom cadence" },
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

// Benchmark slug convention: `<basis>_<region>_<product>`. The seeded
// rates use USGC as the region anchor for Caribbean/US Gulf flows —
// match that here so product-level lookups find a row.
function benchmarkSlug(basis: string, product: string): string | null {
  if (basis === "fixed" || basis === "negotiated") return null;
  if (basis === "nymex_wti" || basis === "nymex_rbob" || basis === "ice_brent") {
    return basis;
  }
  if (product.startsWith("jet_")) return `${basis}_usgc_jet`;
  return `${basis}_usgc_${product}`;
}

function toNumberOrUndef(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}

export function NewDealForm({ open, onClose, onCreated }: NewDealFormProps) {
  const [orgs, setOrgs] = useState<OrgOption[]>([]);

  // Required basics.
  const [dealRef, setDealRef] = useState("");
  const [product, setProduct] = useState("ulsd");
  const [incoterm, setIncoterm] = useState("cfr");
  const [pricingBasis, setPricingBasis] = useState("platts");
  const [paymentTerms, setPaymentTerms] = useState("lc_sight");
  const [volumeUsg, setVolumeUsg] = useState("");
  const [densityKgL, setDensityKgL] = useState("0.84");
  const [buyerOrgId, setBuyerOrgId] = useState("");

  // Cadence — captured up front because it changes how the deal shows
  // up in dashboards / forecasts downstream.
  const [dealFrequency, setDealFrequency] = useState("one_off");
  const [dealFrequencyIntervalDays, setDealFrequencyIntervalDays] = useState("");
  const [dealFrequencyNotes, setDealFrequencyNotes] = useState("");

  // Optional logistics.
  const [destinationPort, setDestinationPort] = useState("");
  const [laycanStart, setLaycanStart] = useState("");
  const [laycanEnd, setLaycanEnd] = useState("");
  const [notes, setNotes] = useState("");

  // Economics — all optional. Empty string means "unset" and the calc
  // endpoint treats it as a zero default.
  const [sellPricePerUsg, setSellPricePerUsg] = useState("");
  const [productCostPerUsg, setProductCostPerUsg] = useState("");
  const [freightPerUsg, setFreightPerUsg] = useState("");
  const [cargoInsurancePct, setCargoInsurancePct] = useState("");
  const [dischargeHandlingPerUsg, setDischargeHandlingPerUsg] = useState("");
  const [compliancePerUsg, setCompliancePerUsg] = useState("");
  const [tradeFinancePerUsg, setTradeFinancePerUsg] = useState("");
  const [intermediaryFeePerUsg, setIntermediaryFeePerUsg] = useState("");
  const [vtcVariableOpsPerUsg, setVtcVariableOpsPerUsg] = useState("");
  const [counterpartyRiskScore, setCounterpartyRiskScore] = useState("");
  const [countryRiskScore, setCountryRiskScore] = useState("");
  const [overheadAllocationUsd, setOverheadAllocationUsd] = useState("");

  // Participants — suppliers, brokers, buyers, intermediaries. Each
  // carries its own commission structure (see participant-editor.tsx)
  // which the dashboard rolls into `intermediaryFeePerUsg` live.
  const [participants, setParticipants] = useState<ParticipantDraft[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calc, setCalc] = useState<CalculatorResponse | null>(null);
  const [calcLoading, setCalcLoading] = useState(false);
  const [benchmark, setBenchmark] = useState<MarketRate | null>(null);
  const [buyerIntel, setBuyerIntel] = useState<BuyerIntel | null>(null);

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

  // Roll participant commissions into a single per-USG number. We feed
  // this into the calculator's `intermediaryFeePerUsg` line alongside
  // whatever the operator typed into the raw intermediary input —
  // participants represent external parties, so summing into that
  // bucket keeps the per-USG waterfall accurate without adding a new
  // column to the calculator.
  const participantFeePerUsg = useMemo(() => {
    const sell = toNumberOrUndef(sellPricePerUsg);
    const density = toNumberOrUndef(densityKgL);
    const volume = toNumberOrUndef(volumeUsg);
    const ctx = {
      ...(sell !== undefined ? { sellPricePerUsg: sell } : {}),
      ...(density !== undefined ? { densityKgL: density } : {}),
      ...(volume !== undefined ? { volumeUsg: volume } : {}),
    };
    let total = 0;
    for (const p of participants) {
      const per = commissionPerUsg(p, ctx);
      if (per !== null) total += per;
    }
    return total;
  }, [participants, sellPricePerUsg, densityKgL, volumeUsg]);

  // Assemble the calculator payload from current form state. Each
  // numeric field parses through `setNum` which only writes a key when
  // the string has a real number — skipping them lets the backend keep
  // its safe zero defaults instead of treating an empty string as zero.
  const calcPayload = useMemo<CalculatePayload>(() => {
    const payload: CalculatePayload = {
      product,
      incoterm,
      paymentTerms,
    };
    if (dealRef.trim()) payload.dealRef = dealRef.trim();
    const setNum = (key: keyof CalculatePayload, raw: string): void => {
      const v = toNumberOrUndef(raw);
      if (v !== undefined) (payload[key] as number) = v;
    };
    setNum("volumeUsg", volumeUsg);
    setNum("densityKgL", densityKgL);
    setNum("sellPricePerUsg", sellPricePerUsg);
    setNum("productCostPerUsg", productCostPerUsg);
    setNum("freightPerUsg", freightPerUsg);
    setNum("cargoInsurancePct", cargoInsurancePct);
    setNum("dischargeHandlingPerUsg", dischargeHandlingPerUsg);
    setNum("compliancePerUsg", compliancePerUsg);
    setNum("tradeFinancePerUsg", tradeFinancePerUsg);
    setNum("intermediaryFeePerUsg", intermediaryFeePerUsg);
    // Fold participant commissions into the intermediary bucket — they
    // represent external parties that eat margin, same as a raw
    // intermediary fee. The dashboard shows the breakdown separately
    // so the operator sees attribution; the calculator sums it.
    if (participantFeePerUsg > 0) {
      const existing = payload.intermediaryFeePerUsg ?? 0;
      payload.intermediaryFeePerUsg = existing + participantFeePerUsg;
    }
    setNum("vtcVariableOpsPerUsg", vtcVariableOpsPerUsg);
    setNum("counterpartyRiskScore", counterpartyRiskScore);
    setNum("countryRiskScore", countryRiskScore);
    setNum("overheadAllocationUsd", overheadAllocationUsd);
    return payload;
  }, [
    dealRef,
    product,
    incoterm,
    paymentTerms,
    volumeUsg,
    densityKgL,
    sellPricePerUsg,
    productCostPerUsg,
    freightPerUsg,
    cargoInsurancePct,
    dischargeHandlingPerUsg,
    compliancePerUsg,
    tradeFinancePerUsg,
    intermediaryFeePerUsg,
    vtcVariableOpsPerUsg,
    counterpartyRiskScore,
    countryRiskScore,
    overheadAllocationUsd,
    participantFeePerUsg,
  ]);

  // Debounced calculator fetch — waits 250ms after the last change so a
  // user typing a price doesn't hit the endpoint on every keystroke.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setCalcLoading(true);
      fetch("/api/deals/calculate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(calcPayload),
        signal: ctrl.signal,
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(`${res.status}`);
          const body = (await res.json()) as CalculatorResponse;
          setCalc(body);
        })
        .catch((err) => {
          if ((err as Error).name !== "AbortError") {
            setCalc(null);
          }
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setCalcLoading(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [open, calcPayload]);

  // Pull buyer intel (counterparty risk + concentration) whenever the
  // buyer dropdown changes. Null orgId clears the card.
  useEffect(() => {
    if (!open || !buyerOrgId) {
      setBuyerIntel(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/deals/buyer-intel/${encodeURIComponent(buyerOrgId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        const body = (await res.json()) as BuyerIntel;
        if (!cancelled) setBuyerIntel(body);
      })
      .catch(() => {
        if (!cancelled) setBuyerIntel(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, buyerOrgId]);

  // Pull benchmark rate when product + pricing basis are both set.
  useEffect(() => {
    if (!open) return;
    const slug = benchmarkSlug(pricingBasis, product);
    if (!slug) {
      setBenchmark(null);
      return;
    }
    let cancelled = false;
    const qs = new URLSearchParams({ product, benchmark: slug });
    fetch(`/api/deals/benchmarks?${qs.toString()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        const body = (await res.json()) as { rate: MarketRate | null };
        if (!cancelled) setBenchmark(body.rate);
      })
      .catch(() => {
        if (!cancelled) setBenchmark(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, product, pricingBasis]);

  const reset = useCallback((): void => {
    setDealRef("");
    setProduct("ulsd");
    setIncoterm("cfr");
    setPricingBasis("platts");
    setPaymentTerms("lc_sight");
    setVolumeUsg("");
    setDensityKgL("0.84");
    setBuyerOrgId("");
    setDealFrequency("one_off");
    setDealFrequencyIntervalDays("");
    setDealFrequencyNotes("");
    setDestinationPort("");
    setLaycanStart("");
    setLaycanEnd("");
    setNotes("");
    setSellPricePerUsg("");
    setProductCostPerUsg("");
    setFreightPerUsg("");
    setCargoInsurancePct("");
    setDischargeHandlingPerUsg("");
    setCompliancePerUsg("");
    setTradeFinancePerUsg("");
    setIntermediaryFeePerUsg("");
    setVtcVariableOpsPerUsg("");
    setCounterpartyRiskScore("");
    setCountryRiskScore("");
    setOverheadAllocationUsd("");
    setParticipants([]);
    setError(null);
    setSubmitting(false);
    setCalc(null);
    setBenchmark(null);
    setBuyerIntel(null);
  }, []);

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
    const customDays =
      dealFrequency === "custom"
        ? Number.parseInt(dealFrequencyIntervalDays, 10)
        : null;
    if (dealFrequency === "custom" && (!Number.isFinite(customDays) || (customDays ?? 0) <= 0)) {
      return setError("Custom cadence requires an interval in days.");
    }

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
          dealFrequency,
          ...(dealFrequency === "custom" && customDays
            ? { dealFrequencyIntervalDays: customDays }
            : {}),
          ...(dealFrequencyNotes.trim()
            ? { dealFrequencyNotes: dealFrequencyNotes.trim() }
            : {}),
          ...(participants.length > 0
            ? {
                participants: participants
                  .filter((p) => p.displayName.trim().length > 0)
                  .map((p) => {
                    const v = Number.parseFloat(p.commissionValue);
                    const hasValue =
                      p.commissionType !== "none" && Number.isFinite(v) && v > 0;
                    return {
                      partyType: p.partyType,
                      displayName: p.displayName.trim(),
                      ...(p.orgId ? { orgId: p.orgId } : {}),
                      commissionType: p.commissionType,
                      ...(hasValue ? { commissionValue: v } : {}),
                      ...(p.commissionNotes.trim()
                        ? { commissionNotes: p.commissionNotes.trim() }
                        : {}),
                    };
                  }),
              }
            : {}),
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
      size="xl"
      onClose={() => {
        if (!submitting) {
          reset();
          onClose();
        }
      }}
      title="New deal"
      description="Fill the basics to create the deal; add economics to see a live score before you commit."
    >
      <form onSubmit={onSubmit} className="flex max-h-[78vh] flex-col gap-4">
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden lg:grid-cols-[minmax(0,1fr)_380px]">
          {/* Left pane — form inputs, grouped. */}
          <div className="min-h-0 overflow-y-auto pr-1">
            <FormSection title="Basics" subtitle="Required to create the deal.">
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
                <FormField label="Frequency">
                  <Select
                    value={dealFrequency}
                    onChange={(e) => setDealFrequency(e.target.value)}
                    options={FREQUENCY_OPTIONS}
                  />
                </FormField>
                {dealFrequency === "custom" && (
                  <FormField
                    label="Custom cadence (days)"
                    hint="e.g. 10 = every 10 days"
                    required
                  >
                    <TextInput
                      type="number"
                      inputMode="numeric"
                      value={dealFrequencyIntervalDays}
                      onChange={(e) => setDealFrequencyIntervalDays(e.target.value)}
                      min="1"
                      step="1"
                      placeholder="14"
                    />
                  </FormField>
                )}
              </div>
              {dealFrequency !== "one_off" && (
                <FormField label="Cadence notes" hint="Optional — e.g. 'Every other Monday, Kingston terminal'">
                  <TextInput
                    value={dealFrequencyNotes}
                    onChange={(e) => setDealFrequencyNotes(e.target.value)}
                    placeholder=""
                  />
                </FormField>
              )}
            </FormSection>

            <FormSection
              title="Pricing & costs"
              subtitle="Sell price vs cost stack. Empty fields use zero; skip if not ready."
            >
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Sell price ($/USG)">
                  <TextInput
                    type="number"
                    inputMode="decimal"
                    value={sellPricePerUsg}
                    onChange={(e) => setSellPricePerUsg(e.target.value)}
                    step="0.0001"
                    min="0"
                    placeholder="2.8500"
                  />
                </FormField>
                <FormField label="Product cost ($/USG)">
                  <TextInput
                    type="number"
                    inputMode="decimal"
                    value={productCostPerUsg}
                    onChange={(e) => setProductCostPerUsg(e.target.value)}
                    step="0.0001"
                    min="0"
                    placeholder="2.6800"
                  />
                </FormField>
                <FormField label="Freight ($/USG)">
                  <TextInput
                    type="number"
                    inputMode="decimal"
                    value={freightPerUsg}
                    onChange={(e) => setFreightPerUsg(e.target.value)}
                    step="0.0001"
                    min="0"
                    placeholder="0.0350"
                  />
                </FormField>
                <FormField label="Cargo insurance (%)" hint="0.002 = 0.2% of CIF">
                  <TextInput
                    type="number"
                    inputMode="decimal"
                    value={cargoInsurancePct}
                    onChange={(e) => setCargoInsurancePct(e.target.value)}
                    step="0.0001"
                    min="0"
                    max="0.5"
                    placeholder="0.002"
                  />
                </FormField>
                <FormField label="Discharge / handling ($/USG)">
                  <TextInput
                    type="number"
                    inputMode="decimal"
                    value={dischargeHandlingPerUsg}
                    onChange={(e) => setDischargeHandlingPerUsg(e.target.value)}
                    step="0.0001"
                    min="0"
                  />
                </FormField>
                <FormField label="Compliance ($/USG)">
                  <TextInput
                    type="number"
                    inputMode="decimal"
                    value={compliancePerUsg}
                    onChange={(e) => setCompliancePerUsg(e.target.value)}
                    step="0.0001"
                    min="0"
                  />
                </FormField>
                <FormField label="Trade finance ($/USG)">
                  <TextInput
                    type="number"
                    inputMode="decimal"
                    value={tradeFinancePerUsg}
                    onChange={(e) => setTradeFinancePerUsg(e.target.value)}
                    step="0.0001"
                    min="0"
                  />
                </FormField>
                <FormField label="Intermediary fee ($/USG)">
                  <TextInput
                    type="number"
                    inputMode="decimal"
                    value={intermediaryFeePerUsg}
                    onChange={(e) => setIntermediaryFeePerUsg(e.target.value)}
                    step="0.0001"
                    min="0"
                  />
                </FormField>
                <FormField label="VTC variable ops ($/USG)">
                  <TextInput
                    type="number"
                    inputMode="decimal"
                    value={vtcVariableOpsPerUsg}
                    onChange={(e) => setVtcVariableOpsPerUsg(e.target.value)}
                    step="0.0001"
                    min="0"
                  />
                </FormField>
                <FormField label="Overhead allocation ($)">
                  <TextInput
                    type="number"
                    inputMode="decimal"
                    value={overheadAllocationUsd}
                    onChange={(e) => setOverheadAllocationUsd(e.target.value)}
                    step="1"
                    min="0"
                  />
                </FormField>
              </div>
            </FormSection>

            <FormSection
              title="Risk"
              subtitle="Counterparty + country risk scores feed warning thresholds."
            >
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Counterparty risk (0–100)">
                  <TextInput
                    type="number"
                    inputMode="decimal"
                    value={counterpartyRiskScore}
                    onChange={(e) => setCounterpartyRiskScore(e.target.value)}
                    step="1"
                    min="0"
                    max="100"
                    placeholder="40"
                  />
                </FormField>
                <FormField label="Country risk (0–100)">
                  <TextInput
                    type="number"
                    inputMode="decimal"
                    value={countryRiskScore}
                    onChange={(e) => setCountryRiskScore(e.target.value)}
                    step="1"
                    min="0"
                    max="100"
                    placeholder="40"
                  />
                </FormField>
              </div>
            </FormSection>

            <FormSection
              title="Participants & commissions"
              subtitle="Brokers, suppliers, intermediaries. Commissions feed the live margin below."
            >
              <ParticipantEditor
                participants={participants}
                onChange={setParticipants}
                orgs={orgs}
              />
            </FormSection>

            <FormSection title="Logistics & notes" subtitle="Optional.">
              <div className="grid grid-cols-2 gap-3">
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
            </FormSection>
          </div>

          {/* Right pane — live calculator dashboard. */}
          <aside className="min-h-0 overflow-y-auto rounded-md border border-line bg-muted/30 p-4">
            <DealCreatorDashboard
              calc={calc}
              loading={calcLoading}
              benchmark={benchmark}
              buyerIntel={buyerIntel}
              sellPricePerUsg={toNumberOrUndef(sellPricePerUsg) ?? null}
              participantFeePerUsg={participantFeePerUsg}
              participants={participants}
              participantContext={{
                ...(toNumberOrUndef(sellPricePerUsg) !== undefined
                  ? { sellPricePerUsg: toNumberOrUndef(sellPricePerUsg)! }
                  : {}),
                ...(toNumberOrUndef(densityKgL) !== undefined
                  ? { densityKgL: toNumberOrUndef(densityKgL)! }
                  : {}),
                ...(toNumberOrUndef(volumeUsg) !== undefined
                  ? { volumeUsg: toNumberOrUndef(volumeUsg)! }
                  : {}),
              }}
            />
          </aside>
        </div>

        {error && (
          <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-line pt-4">
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

function FormSection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5 flex flex-col gap-3">
      <header>
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        {subtitle && (
          <p className="mt-0.5 text-xs text-white/50">{subtitle}</p>
        )}
      </header>
      {children}
    </section>
  );
}
