"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "@/components/ui/modal";
import { FormField, TextInput } from "@/components/ui/form-field";

export interface EditableCompany {
  id: string;
  legalName: string;
  domain: string | null;
  industry: string | null;
}

export interface EditCompanyFormProps {
  open: boolean;
  organization: EditableCompany;
  onClose: () => void;
  onSaved: (updated: EditableCompany) => void;
}

/**
 * "Edit company" modal — PATCH /api/organizations/:id. Covers the
 * hand-entered identity columns. Merge metadata + externalKeys have
 * their own ingestion paths and aren't exposed here.
 */
export function EditCompanyForm({
  open,
  organization,
  onClose,
  onSaved,
}: EditCompanyFormProps) {
  const [legalName, setLegalName] = useState(organization.legalName);
  const [domain, setDomain] = useState(organization.domain ?? "");
  const [industry, setIndustry] = useState(organization.industry ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLegalName(organization.legalName);
    setDomain(organization.domain ?? "");
    setIndustry(organization.industry ?? "");
    setError(null);
  }, [open, organization]);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    if (!legalName.trim()) {
      setError("Company name is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/organizations/${organization.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          legalName: legalName.trim(),
          domain: domain.trim() ? domain.trim() : null,
          industry: industry.trim() ? industry.trim() : null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as {
        organization: EditableCompany;
      };
      onSaved(body.organization);
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
      title={`Edit ${organization.legalName}`}
      description="Updates the organization's identity fields."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <FormField label="Company name" required>
          <TextInput
            value={legalName}
            onChange={(e) => setLegalName(e.target.value)}
            placeholder="Acme Corporation"
            autoFocus
            maxLength={200}
          />
        </FormField>

        <FormField label="Domain" hint="Primary web domain, no protocol.">
          <TextInput
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="acme.test"
            maxLength={255}
          />
        </FormField>

        <FormField label="Industry">
          <TextInput
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            placeholder="Manufacturing"
            maxLength={120}
          />
        </FormField>

        {error && (
          <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
            {error}
          </div>
        )}

        <div className="mt-2 flex justify-end gap-2 border-t border-line pt-4">
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
