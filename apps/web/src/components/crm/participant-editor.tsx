"use client";

import { useMemo } from "react";
import { FormField, Select, TextInput } from "@/components/ui/form-field";

export type PartyType =
  | "supplier"
  | "supplier_broker"
  | "buyer"
  | "buyer_broker"
  | "intermediary";

export type CommissionType =
  | "percentage"
  | "cents_per_liter"
  | "usd_per_mt"
  | "flat_usd"
  | "none";

export interface ParticipantDraft {
  /** Local-only key so React can track row identity while editing. */
  key: string;
  partyType: PartyType;
  displayName: string;
  orgId: string;
  commissionType: CommissionType;
  /** Raw text so partial / empty input doesn't collapse to 0 while typing. */
  commissionValue: string;
  commissionNotes: string;
}

export interface OrgOption {
  id: string;
  legalName: string;
}

const PARTY_OPTIONS: { value: PartyType; label: string }[] = [
  { value: "supplier", label: "Supplier" },
  { value: "supplier_broker", label: "Broker — supplier side" },
  { value: "buyer", label: "Buyer" },
  { value: "buyer_broker", label: "Broker — buyer side" },
  { value: "intermediary", label: "Intermediary" },
];

const COMMISSION_OPTIONS: { value: CommissionType; label: string }[] = [
  { value: "none", label: "No commission" },
  { value: "percentage", label: "% of sell price" },
  { value: "cents_per_liter", label: "¢ per liter" },
  { value: "usd_per_mt", label: "$ per metric ton" },
  { value: "flat_usd", label: "Flat USD" },
];

export const COMMISSION_UNIT_HINT: Record<CommissionType, string> = {
  percentage: "% (e.g. 0.5 = 0.5% of sell price)",
  cents_per_liter: "¢/L (e.g. 5 = 5¢ per liter)",
  usd_per_mt: "$/mt",
  flat_usd: "$ total",
  none: "",
};

export function emptyParticipant(): ParticipantDraft {
  return {
    key:
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `p-${Math.random().toString(36).slice(2)}`,
    partyType: "supplier_broker",
    displayName: "",
    orgId: "",
    commissionType: "percentage",
    commissionValue: "",
    commissionNotes: "",
  };
}

/**
 * Convert one participant's commission into $/USG so the live
 * calculator dashboard can feed them in alongside the rest of the
 * cost stack.
 *
 *   percentage      — value is "0.5" (read as 0.5%), returns
 *                     sellPrice × 0.005.
 *   cents_per_liter — value is "5" (¢/L), returns value × 3.78541 / 100.
 *   usd_per_mt      — value is "10" ($/mt), returns value × density_kg/L × 3.78541 / 1000.
 *   flat_usd        — value is total USD, returns value / volumeUsg.
 *
 * Returns null when the inputs required for the conversion aren't
 * present (e.g. percentage without a sell price) — the dashboard
 * surfaces that as "cost not yet quantified" instead of a misleading $0.
 */
export function commissionPerUsg(
  p: ParticipantDraft,
  ctx: { sellPricePerUsg?: number; densityKgL?: number; volumeUsg?: number },
): number | null {
  const raw = Number.parseFloat(p.commissionValue);
  if (!Number.isFinite(raw) || raw <= 0) return p.commissionType === "none" ? 0 : null;
  switch (p.commissionType) {
    case "percentage":
      if (!ctx.sellPricePerUsg || ctx.sellPricePerUsg <= 0) return null;
      return ctx.sellPricePerUsg * (raw / 100);
    case "cents_per_liter":
      return (raw * 3.78541) / 100;
    case "usd_per_mt":
      if (!ctx.densityKgL || ctx.densityKgL <= 0) return null;
      return (raw * 3.78541 * ctx.densityKgL) / 1000;
    case "flat_usd":
      if (!ctx.volumeUsg || ctx.volumeUsg <= 0) return null;
      return raw / ctx.volumeUsg;
    case "none":
    default:
      return 0;
  }
}

export interface ParticipantEditorProps {
  participants: ParticipantDraft[];
  onChange: (next: ParticipantDraft[]) => void;
  orgs: OrgOption[];
}

export function ParticipantEditor({
  participants,
  onChange,
  orgs,
}: ParticipantEditorProps) {
  const orgOptions = useMemo(
    () => [
      { value: "", label: "— free-text only —" },
      ...orgs.map((o) => ({ value: o.id, label: o.legalName })),
    ],
    [orgs],
  );

  function updateRow(key: string, patch: Partial<ParticipantDraft>): void {
    onChange(
      participants.map((p) => (p.key === key ? { ...p, ...patch } : p)),
    );
  }

  function addRow(): void {
    onChange([...participants, emptyParticipant()]);
  }

  function removeRow(key: string): void {
    onChange(participants.filter((p) => p.key !== key));
  }

  return (
    <div className="flex flex-col gap-3">
      {participants.length === 0 && (
        <p className="text-xs text-white/50">
          Nobody attached yet. Add suppliers, brokers, or intermediaries so
          you can track each party&apos;s fee.
        </p>
      )}
      {participants.map((p) => (
        <div
          key={p.key}
          className="flex flex-col gap-2 rounded-md border border-line bg-canvas/40 p-3"
        >
          <div className="grid grid-cols-2 gap-2">
            <FormField label="Role">
              <Select
                value={p.partyType}
                onChange={(e) =>
                  updateRow(p.key, {
                    partyType: e.target.value as PartyType,
                  })
                }
                options={PARTY_OPTIONS}
              />
            </FormField>
            <FormField label="Name" required>
              <TextInput
                value={p.displayName}
                onChange={(e) =>
                  updateRow(p.key, { displayName: e.target.value })
                }
                placeholder="Broker or company name"
                maxLength={200}
              />
            </FormField>
            <FormField
              label="Company (optional)"
              hint="Link to a CRM org if it exists."
            >
              <Select
                value={p.orgId}
                onChange={(e) => updateRow(p.key, { orgId: e.target.value })}
                options={orgOptions}
              />
            </FormField>
            <FormField label="Commission">
              <Select
                value={p.commissionType}
                onChange={(e) =>
                  updateRow(p.key, {
                    commissionType: e.target.value as CommissionType,
                  })
                }
                options={COMMISSION_OPTIONS}
              />
            </FormField>
            {p.commissionType !== "none" && (
              <FormField
                label="Value"
                hint={COMMISSION_UNIT_HINT[p.commissionType]}
                required
              >
                <TextInput
                  type="number"
                  inputMode="decimal"
                  value={p.commissionValue}
                  onChange={(e) =>
                    updateRow(p.key, { commissionValue: e.target.value })
                  }
                  step="0.0001"
                  min="0"
                />
              </FormField>
            )}
            {p.commissionType !== "none" && (
              <FormField label="Commission note">
                <TextInput
                  value={p.commissionNotes}
                  onChange={(e) =>
                    updateRow(p.key, { commissionNotes: e.target.value })
                  }
                  placeholder="Paid on settlement"
                  maxLength={500}
                />
              </FormField>
            )}
          </div>
          <button
            type="button"
            onClick={() => removeRow(p.key)}
            className="self-end text-xs text-white/50 hover:text-bad"
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        className="self-start rounded-md border border-line px-3 py-1.5 text-xs text-white/80 hover:border-accent hover:text-white"
      >
        + Add participant
      </button>
    </div>
  );
}
