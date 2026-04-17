"use client";

import { useState, type FormEvent } from "react";
import { Modal } from "@/components/ui/modal";
import { FormField, TextInput } from "@/components/ui/form-field";

export interface NewCompanyFormProps {
  open: boolean;
  onClose: () => void;
  onCreated: (created: { id: string; legalName: string }) => void;
}

/**
 * "+ New Company" modal for /app/companies. Posts to /api/organizations
 * and calls onCreated with the new row so the list can optimistically
 * prepend without waiting for a refetch.
 */
export function NewCompanyForm({ open, onClose, onCreated }: NewCompanyFormProps) {
  const [legalName, setLegalName] = useState("");
  const [domain, setDomain] = useState("");
  const [industry, setIndustry] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset(): void {
    setLegalName("");
    setDomain("");
    setIndustry("");
    setError(null);
    setSubmitting(false);
  }

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
      const res = await fetch("/api/organizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          legalName: legalName.trim(),
          ...(domain.trim() ? { domain: domain.trim() } : {}),
          ...(industry.trim() ? { industry: industry.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as {
        organization: { id: string; legalName: string };
      };
      onCreated(body.organization);
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
      title="New company"
      description="Adds an organization to this workspace."
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
            {submitting ? "Creating…" : "Create company"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
