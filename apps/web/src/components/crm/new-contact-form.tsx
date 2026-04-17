"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "@/components/ui/modal";
import { FormField, Select, TextInput } from "@/components/ui/form-field";

export interface NewContactFormProps {
  open: boolean;
  onClose: () => void;
  onCreated: (created: { id: string; fullName: string }) => void;
  /** If the caller is already scoped to an org, start with that row selected + primary. */
  preselectedOrgId?: string;
}

interface OrgOption {
  id: string;
  legalName: string;
}

interface MembershipDraft {
  orgId: string;
  role: string;
  isPrimary: boolean;
}

/**
 * "New contact" modal. Sprint 14 upgrade — contacts can belong to
 * multiple orgs, so the picker is now a repeating row with per-row
 * role + a single primary radio. Exactly one membership must be
 * flagged primary before submit.
 */
export function NewContactForm({
  open,
  onClose,
  onCreated,
  preselectedOrgId,
}: NewContactFormProps) {
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [memberships, setMemberships] = useState<MembershipDraft[]>([]);
  const [fullName, setFullName] = useState("");
  const [title, setTitle] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
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
          if (memberships.length === 0) {
            const startId =
              preselectedOrgId ?? body.organizations[0]?.id ?? "";
            if (startId) {
              setMemberships([{ orgId: startId, role: "", isPrimary: true }]);
            }
          }
        }
      })
      .catch(() => {
        /* ignored — validation surfaces the error */
      });
    return () => {
      cancelled = true;
    };
  }, [open, preselectedOrgId, memberships.length]);

  function reset(): void {
    setMemberships([]);
    setFullName("");
    setTitle("");
    setEmail("");
    setPhone("");
    setError(null);
    setSubmitting(false);
  }

  function updateRow(idx: number, patch: Partial<MembershipDraft>): void {
    setMemberships((prev) =>
      prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)),
    );
  }

  function removeRow(idx: number): void {
    setMemberships((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      // Ensure the set retains exactly one primary.
      if (!next.some((m) => m.isPrimary) && next[0]) next[0].isPrimary = true;
      return next;
    });
  }

  function makePrimary(idx: number): void {
    setMemberships((prev) =>
      prev.map((row, i) => ({ ...row, isPrimary: i === idx })),
    );
  }

  function addRow(): void {
    const alreadyPicked = new Set(memberships.map((m) => m.orgId));
    const next = orgs.find((o) => !alreadyPicked.has(o.id));
    if (!next) return;
    setMemberships((prev) => [
      ...prev,
      { orgId: next.id, role: "", isPrimary: false },
    ]);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    if (memberships.length === 0)
      return setError("Pick at least one company.");
    if (!memberships.some((m) => m.isPrimary))
      return setError("Mark one company as primary.");
    if (!fullName.trim()) return setError("Full name is required.");

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fullName: fullName.trim(),
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(email.trim() ? { emails: [email.trim()] } : {}),
          ...(phone.trim() ? { phones: [phone.trim()] } : {}),
          orgs: memberships.map((m) => ({
            orgId: m.orgId,
            ...(m.role.trim() ? { role: m.role.trim() } : {}),
            isPrimary: m.isPrimary,
          })),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as {
        contact: { id: string; fullName: string };
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

  const availableOrgs = orgs.filter(
    (o) => !memberships.some((m) => m.orgId === o.id),
  );

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
      description="A contact may represent multiple companies. Mark one as primary."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
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

        <div className="flex flex-col gap-2 rounded-md border border-line bg-muted/20 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-white/80">
              Companies
              <span className="ml-0.5 text-accent">*</span>
            </span>
            <button
              type="button"
              onClick={addRow}
              disabled={availableOrgs.length === 0}
              className="text-xs text-accent hover:underline disabled:text-white/30 disabled:no-underline"
            >
              + Add company
            </button>
          </div>

          {memberships.length === 0 && (
            <p className="text-xs text-white/50">
              Loading companies…
            </p>
          )}

          {memberships.map((row, idx) => (
            <div
              key={`${row.orgId}:${idx}`}
              className="grid grid-cols-[1fr_1fr_auto_auto] items-center gap-2"
            >
              <Select
                value={row.orgId}
                onChange={(e) => updateRow(idx, { orgId: e.target.value })}
                options={orgs.map((o) => ({
                  value: o.id,
                  label: o.legalName,
                  disabled: memberships.some(
                    (m, j) => j !== idx && m.orgId === o.id,
                  ),
                }))}
              />
              <TextInput
                value={row.role}
                onChange={(e) => updateRow(idx, { role: e.target.value })}
                placeholder="Role at this company"
                maxLength={200}
              />
              <label className="flex items-center gap-1 text-xs text-white/70">
                <input
                  type="radio"
                  name="primary-membership"
                  checked={row.isPrimary}
                  onChange={() => makePrimary(idx)}
                />
                primary
              </label>
              <button
                type="button"
                onClick={() => removeRow(idx)}
                disabled={memberships.length === 1}
                className="text-xs text-white/50 hover:text-bad disabled:opacity-30"
                aria-label="Remove membership"
              >
                ×
              </button>
            </div>
          ))}
        </div>

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
