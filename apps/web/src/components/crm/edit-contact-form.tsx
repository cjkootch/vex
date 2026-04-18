"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "@/components/ui/modal";
import { FormField, TextInput } from "@/components/ui/form-field";

export interface EditableContact {
  id: string;
  fullName: string;
  title: string | null;
  emails: string[];
  phones: string[];
  timezone?: string | null;
}

export interface EditContactFormProps {
  open: boolean;
  contact: EditableContact;
  onClose: () => void;
  onSaved: (updated: EditableContact) => void;
}

/**
 * "Edit contact" modal — PATCH /api/contacts/:id. Memberships have
 * their own /memberships endpoints (addMembership / setPrimary /
 * removeMembership) so they're intentionally not rendered here.
 */
export function EditContactForm({
  open,
  contact,
  onClose,
  onSaved,
}: EditContactFormProps) {
  const [fullName, setFullName] = useState(contact.fullName);
  const [title, setTitle] = useState(contact.title ?? "");
  const [email, setEmail] = useState(contact.emails[0] ?? "");
  const [phone, setPhone] = useState(contact.phones[0] ?? "");
  const [timezone, setTimezone] = useState(contact.timezone ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFullName(contact.fullName);
    setTitle(contact.title ?? "");
    setEmail(contact.emails[0] ?? "");
    setPhone(contact.phones[0] ?? "");
    setTimezone(contact.timezone ?? "");
    setError(null);
  }, [open, contact]);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    if (!fullName.trim()) return setError("Full name is required.");

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/contacts/${contact.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fullName: fullName.trim(),
          title: title.trim() ? title.trim() : null,
          emails: email.trim() ? [email.trim()] : [],
          phones: phone.trim() ? [phone.trim()] : [],
          timezone: timezone.trim() ? timezone.trim() : null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as { contact: EditableContact };
      onSaved(body.contact);
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
      title={`Edit ${contact.fullName}`}
      description="Company memberships are managed from the Companies tab."
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
            maxLength={120}
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

        <FormField label="Timezone" hint="IANA zone, e.g. America/Jamaica">
          <TextInput
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="America/Jamaica"
            maxLength={100}
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
