"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "@/components/ui/modal";
import { FormField, Select, TextInput } from "@/components/ui/form-field";

export interface NewContactFormProps {
  open: boolean;
  onClose: () => void;
  onCreated: (created: { id: string; fullName: string; orgId: string }) => void;
  /** If the caller is already scoped to an org, pre-fill and disable the picker. */
  preselectedOrgId?: string;
}

interface OrgOption {
  id: string;
  legalName: string;
}

export function NewContactForm({
  open,
  onClose,
  onCreated,
  preselectedOrgId,
}: NewContactFormProps) {
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [orgId, setOrgId] = useState(preselectedOrgId ?? "");
  const [fullName, setFullName] = useState("");
  const [title, setTitle] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch org list the first time the modal opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/organizations")
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        const body = (await res.json()) as {
          organizations: OrgOption[];
        };
        if (!cancelled) {
          setOrgs(body.organizations);
          if (!orgId && !preselectedOrgId && body.organizations[0]) {
            setOrgId(body.organizations[0].id);
          }
        }
      })
      .catch(() => {
        /* ignored — user will see validation error on submit */
      });
    return () => {
      cancelled = true;
    };
  }, [open, orgId, preselectedOrgId]);

  function reset(): void {
    setOrgId(preselectedOrgId ?? "");
    setFullName("");
    setTitle("");
    setEmail("");
    setPhone("");
    setError(null);
    setSubmitting(false);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    if (!orgId) {
      setError("Pick a company first.");
      return;
    }
    if (!fullName.trim()) {
      setError("Full name is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId,
          fullName: fullName.trim(),
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(email.trim() ? { emails: [email.trim()] } : {}),
          ...(phone.trim() ? { phones: [phone.trim()] } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as {
        contact: { id: string; fullName: string; orgId: string };
      };
      onCreated(body.contact);
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
      title="New contact"
      description="Adds a person to a company."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <FormField label="Company" required>
          <Select
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
            disabled={preselectedOrgId !== undefined}
            options={
              orgs.length === 0
                ? [{ value: "", label: "Loading companies…" }]
                : orgs.map((o) => ({ value: o.id, label: o.legalName }))
            }
          />
        </FormField>

        <FormField label="Full name" required>
          <TextInput
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Jane Doe"
            maxLength={200}
            autoFocus
          />
        </FormField>

        <FormField label="Title">
          <TextInput
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="VP Procurement"
            maxLength={200}
          />
        </FormField>

        <FormField label="Email">
          <TextInput
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="jane@acme.test"
          />
        </FormField>

        <FormField label="Phone">
          <TextInput
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+1 555 555 1234"
            maxLength={40}
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
            {submitting ? "Creating…" : "Create contact"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
