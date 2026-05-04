"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  CallTemplate,
  EmailTemplate,
  SmsTemplate,
  WhatsAppTemplate,
  WorkspaceSettings,
} from "./admin-console";

/**
 * Admin → Templates tab. Manages four registries:
 *   1. WhatsApp Content Templates — Twilio-side, indexed by HX SID
 *   2. Email templates — Vex-native, named placeholders
 *   3. SMS templates — Vex-native, named placeholders
 *   4. AI-call templates — Vex-native, the aiInstructions block
 *
 * Each section is a list of cards + an "add new" form. Save flows
 * through the parent's `onPatch` so a single PATCH /admin/settings
 * update lands the whole list at once. Empty list clears the
 * registry.
 */
export function TemplatesTab({
  settings,
  onPatch,
}: {
  settings: WorkspaceSettings | null;
  onPatch: (patch: Partial<WorkspaceSettings>) => Promise<boolean>;
}): React.ReactElement {
  return (
    <section className="flex flex-col gap-10">
      <header>
        <h2 className="text-lg font-semibold text-text-primary">Templates</h2>
        <p className="mt-1 max-w-2xl text-xs text-text-secondary">
          Operator-authored templates Vex can apply when you ask for them by
          name in chat (e.g. <em>&quot;send acme the welcome email&quot;</em>).
          Untemplated freeform sends still work the same way — templates are
          an opt-in library. Variables use named placeholders like{" "}
          <code className="rounded bg-muted/40 px-1">{`{{recipient_name}}`}</code>;
          the chat agent resolves them from the evidence pack at send time.
        </p>
      </header>

      <WhatsAppSection
        templates={settings?.whatsapp_templates ?? []}
        onPatch={onPatch}
      />

      <EmailSection
        templates={settings?.email_templates ?? []}
        onPatch={onPatch}
      />

      <SmsSection
        templates={settings?.sms_templates ?? []}
        onPatch={onPatch}
      />

      <CallSection
        templates={settings?.call_templates ?? []}
        onPatch={onPatch}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// WhatsApp templates (Meta-approved Content Templates registered at Twilio).
// Variables are positional ({{1}}, {{2}}) — that's a Twilio constraint.
// ---------------------------------------------------------------------------

function WhatsAppSection({
  templates,
  onPatch,
}: {
  templates: WhatsAppTemplate[];
  onPatch: (patch: Partial<WorkspaceSettings>) => Promise<boolean>;
}): React.ReactElement {
  const save = async (next: WhatsAppTemplate[]): Promise<boolean> =>
    onPatch({ whatsapp_templates: next });

  return (
    <SectionShell
      title="WhatsApp templates"
      subtitle="Meta-approved Content Templates registered in Twilio. Used for cold outreach (the recipient hasn't messaged us in the last 24h). Variables are positional — {{1}}, {{2}} — to match Twilio's contentVariables format."
    >
      {templates.map((t, idx) => (
        <WhatsAppCard
          key={`${t.name}-${idx}`}
          template={t}
          onSave={async (updated) => {
            const next = templates.map((x, i) => (i === idx ? updated : x));
            return save(next);
          }}
          onDelete={async () => save(templates.filter((_, i) => i !== idx))}
        />
      ))}
      <WhatsAppAdd
        onAdd={async (t) => save([...templates, t])}
        existingNames={templates.map((t) => t.name)}
      />
    </SectionShell>
  );
}

function WhatsAppCard({
  template,
  onSave,
  onDelete,
}: {
  template: WhatsAppTemplate;
  onSave: (next: WhatsAppTemplate) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [contentSid, setContentSid] = useState(template.contentSid);
  const [description, setDescription] = useState(template.description ?? "");
  const [variables, setVariables] = useState((template.variables ?? []).join(", "));
  const [saving, setSaving] = useState(false);

  if (!editing) {
    return (
      <TemplateRow
        name={template.name}
        meta={template.contentSid}
        description={template.description}
        variables={template.variables}
        onEdit={() => setEditing(true)}
        onDelete={async () => {
          if (confirm(`Delete WhatsApp template "${template.name}"?`)) {
            await onDelete();
          }
        }}
      />
    );
  }

  return (
    <EditCard
      title={`Editing ${template.name}`}
      onCancel={() => setEditing(false)}
      onSave={async () => {
        setSaving(true);
        const ok = await onSave({
          name: template.name,
          contentSid: contentSid.trim(),
          description: description.trim() || undefined,
          variables: variables
            ? variables.split(",").map((v) => v.trim()).filter(Boolean)
            : undefined,
        });
        setSaving(false);
        if (ok) setEditing(false);
      }}
      saving={saving}
    >
      <Field label="Content SID">
        <input
          className={INPUT}
          value={contentSid}
          onChange={(e) => setContentSid(e.target.value)}
          placeholder="HX0123456789abcdef0123456789abcdef"
          spellCheck={false}
        />
      </Field>
      <Field label="Description">
        <input
          className={INPUT}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="When should the agent pick this template?"
        />
      </Field>
      <Field label="Variables (comma-separated, in template order)">
        <input
          className={INPUT}
          value={variables}
          onChange={(e) => setVariables(e.target.value)}
          placeholder="recipient_name, deal_ref"
        />
      </Field>
    </EditCard>
  );
}

function WhatsAppAdd({
  onAdd,
  existingNames,
}: {
  onAdd: (t: WhatsAppTemplate) => Promise<boolean>;
  existingNames: string[];
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [contentSid, setContentSid] = useState("");
  const [description, setDescription] = useState("");
  const [variables, setVariables] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={ADD_BUTTON}
      >
        + Add WhatsApp template
      </button>
    );
  }

  return (
    <EditCard
      title="New WhatsApp template"
      onCancel={() => {
        setOpen(false);
        setName("");
        setContentSid("");
        setDescription("");
        setVariables("");
        setErr(null);
      }}
      onSave={async () => {
        setErr(null);
        const trimmedName = name.trim();
        if (!/^[a-z0-9_]+$/.test(trimmedName)) {
          setErr("Name must be lowercase + snake_case (e.g. welcome_check_in).");
          return;
        }
        if (existingNames.includes(trimmedName)) {
          setErr(`A template named "${trimmedName}" already exists.`);
          return;
        }
        if (!/^HX[a-fA-F0-9]{32}$/.test(contentSid.trim())) {
          setErr("Content SID must be HX + 32 hex chars (from Twilio Console).");
          return;
        }
        setSaving(true);
        const ok = await onAdd({
          name: trimmedName,
          contentSid: contentSid.trim(),
          description: description.trim() || undefined,
          variables: variables
            ? variables.split(",").map((v) => v.trim()).filter(Boolean)
            : undefined,
        });
        setSaving(false);
        if (ok) {
          setOpen(false);
          setName("");
          setContentSid("");
          setDescription("");
          setVariables("");
        }
      }}
      saving={saving}
      error={err}
    >
      <Field label="Name (lowercase_snake_case)">
        <input
          className={INPUT}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="welcome_check_in"
          spellCheck={false}
        />
      </Field>
      <Field label="Content SID">
        <input
          className={INPUT}
          value={contentSid}
          onChange={(e) => setContentSid(e.target.value)}
          placeholder="HX0123456789abcdef0123456789abcdef"
          spellCheck={false}
        />
      </Field>
      <Field label="Description">
        <input
          className={INPUT}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="When should the agent pick this template?"
        />
      </Field>
      <Field label="Variables (comma-separated, in template order)">
        <input
          className={INPUT}
          value={variables}
          onChange={(e) => setVariables(e.target.value)}
          placeholder="recipient_name, deal_ref"
        />
      </Field>
    </EditCard>
  );
}

// ---------------------------------------------------------------------------
// Email templates (Vex-native, named placeholders).
// ---------------------------------------------------------------------------

function EmailSection({
  templates,
  onPatch,
}: {
  templates: EmailTemplate[];
  onPatch: (patch: Partial<WorkspaceSettings>) => Promise<boolean>;
}): React.ReactElement {
  const save = async (next: EmailTemplate[]): Promise<boolean> =>
    onPatch({ email_templates: next });

  return (
    <SectionShell
      title="Email templates"
      subtitle="Subject + body with named placeholders. The chat agent resolves variables from the evidence pack at send time."
    >
      {templates.map((t, idx) => (
        <EmailCard
          key={`${t.name}-${idx}`}
          template={t}
          onSave={async (updated) => {
            const next = templates.map((x, i) => (i === idx ? updated : x));
            return save(next);
          }}
          onDelete={async () => save(templates.filter((_, i) => i !== idx))}
        />
      ))}
      <EmailAdd
        onAdd={async (t) => save([...templates, t])}
        existingNames={templates.map((t) => t.name)}
      />
    </SectionShell>
  );
}

function EmailCard({
  template,
  onSave,
  onDelete,
}: {
  template: EmailTemplate;
  onSave: (next: EmailTemplate) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [description, setDescription] = useState(template.description ?? "");
  const [variables, setVariables] = useState((template.variables ?? []).join(", "));
  const [saving, setSaving] = useState(false);

  if (!editing) {
    return (
      <TemplateRow
        name={template.name}
        meta={template.subject}
        description={template.description}
        variables={template.variables}
        body={template.body}
        onEdit={() => setEditing(true)}
        onDelete={async () => {
          if (confirm(`Delete email template "${template.name}"?`)) {
            await onDelete();
          }
        }}
      />
    );
  }

  return (
    <EditCard
      title={`Editing ${template.name}`}
      onCancel={() => setEditing(false)}
      onSave={async () => {
        setSaving(true);
        const ok = await onSave({
          name: template.name,
          subject: subject.trim(),
          body,
          description: description.trim() || undefined,
          variables: variables
            ? variables.split(",").map((v) => v.trim()).filter(Boolean)
            : undefined,
        });
        setSaving(false);
        if (ok) setEditing(false);
      }}
      saving={saving}
    >
      <Field label="Subject">
        <input
          className={INPUT}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Hi {{recipient_name}} — quick intro"
        />
      </Field>
      <Field label="Body">
        <textarea
          className={`${INPUT} min-h-[200px] font-mono text-xs`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </Field>
      <Field label="Description">
        <input
          className={INPUT}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="When should the agent pick this template?"
        />
      </Field>
      <Field label="Variables (comma-separated)">
        <input
          className={INPUT}
          value={variables}
          onChange={(e) => setVariables(e.target.value)}
          placeholder="recipient_name, deal_ref"
        />
      </Field>
    </EditCard>
  );
}

function EmailAdd({
  onAdd,
  existingNames,
}: {
  onAdd: (t: EmailTemplate) => Promise<boolean>;
  existingNames: string[];
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [description, setDescription] = useState("");
  const [variables, setVariables] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={ADD_BUTTON}
      >
        + Add email template
      </button>
    );
  }

  return (
    <EditCard
      title="New email template"
      onCancel={() => {
        setOpen(false);
        setName("");
        setSubject("");
        setBody("");
        setDescription("");
        setVariables("");
        setErr(null);
      }}
      onSave={async () => {
        setErr(null);
        const trimmedName = name.trim();
        if (!/^[a-z0-9_]+$/.test(trimmedName)) {
          setErr("Name must be lowercase + snake_case.");
          return;
        }
        if (existingNames.includes(trimmedName)) {
          setErr(`A template named "${trimmedName}" already exists.`);
          return;
        }
        if (!subject.trim() || !body.trim()) {
          setErr("Subject and body are required.");
          return;
        }
        setSaving(true);
        const ok = await onAdd({
          name: trimmedName,
          subject: subject.trim(),
          body,
          description: description.trim() || undefined,
          variables: variables
            ? variables.split(",").map((v) => v.trim()).filter(Boolean)
            : undefined,
        });
        setSaving(false);
        if (ok) {
          setOpen(false);
          setName("");
          setSubject("");
          setBody("");
          setDescription("");
          setVariables("");
        }
      }}
      saving={saving}
      error={err}
    >
      <Field label="Name (lowercase_snake_case)">
        <input
          className={INPUT}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="welcome"
          spellCheck={false}
        />
      </Field>
      <Field label="Subject">
        <input
          className={INPUT}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Hi {{recipient_name}} — quick intro from VTC"
        />
      </Field>
      <Field label="Body">
        <textarea
          className={`${INPUT} min-h-[200px] font-mono text-xs`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Hi {{recipient_name}},&#10;&#10;Great connecting earlier..."
        />
      </Field>
      <Field label="Description">
        <input
          className={INPUT}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="First-touch intro after a discovery call."
        />
      </Field>
      <Field label="Variables (comma-separated)">
        <input
          className={INPUT}
          value={variables}
          onChange={(e) => setVariables(e.target.value)}
          placeholder="recipient_name, deal_ref"
        />
      </Field>
    </EditCard>
  );
}

// ---------------------------------------------------------------------------
// SMS templates.
// ---------------------------------------------------------------------------

function SmsSection({
  templates,
  onPatch,
}: {
  templates: SmsTemplate[];
  onPatch: (patch: Partial<WorkspaceSettings>) => Promise<boolean>;
}): React.ReactElement {
  const save = async (next: SmsTemplate[]): Promise<boolean> =>
    onPatch({ sms_templates: next });

  return (
    <SectionShell
      title="SMS templates"
      subtitle="Body-only — keep ≤320 chars (2 Twilio segments) including worst-case variable expansion to control per-send cost."
    >
      {templates.map((t, idx) => (
        <SmsCard
          key={`${t.name}-${idx}`}
          template={t}
          onSave={async (updated) => {
            const next = templates.map((x, i) => (i === idx ? updated : x));
            return save(next);
          }}
          onDelete={async () => save(templates.filter((_, i) => i !== idx))}
        />
      ))}
      <SmsAdd
        onAdd={async (t) => save([...templates, t])}
        existingNames={templates.map((t) => t.name)}
      />
    </SectionShell>
  );
}

function SmsCard({
  template,
  onSave,
  onDelete,
}: {
  template: SmsTemplate;
  onSave: (next: SmsTemplate) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(template.body);
  const [description, setDescription] = useState(template.description ?? "");
  const [variables, setVariables] = useState((template.variables ?? []).join(", "));
  const [saving, setSaving] = useState(false);

  if (!editing) {
    return (
      <TemplateRow
        name={template.name}
        meta={`${template.body.length} chars`}
        description={template.description}
        variables={template.variables}
        body={template.body}
        onEdit={() => setEditing(true)}
        onDelete={async () => {
          if (confirm(`Delete SMS template "${template.name}"?`)) {
            await onDelete();
          }
        }}
      />
    );
  }

  return (
    <EditCard
      title={`Editing ${template.name}`}
      onCancel={() => setEditing(false)}
      onSave={async () => {
        setSaving(true);
        const ok = await onSave({
          name: template.name,
          body,
          description: description.trim() || undefined,
          variables: variables
            ? variables.split(",").map((v) => v.trim()).filter(Boolean)
            : undefined,
        });
        setSaving(false);
        if (ok) setEditing(false);
      }}
      saving={saving}
    >
      <Field label={`Body (${body.length} chars)`}>
        <textarea
          className={`${INPUT} min-h-[120px] font-mono text-xs`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </Field>
      <Field label="Description">
        <input
          className={INPUT}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <Field label="Variables (comma-separated)">
        <input
          className={INPUT}
          value={variables}
          onChange={(e) => setVariables(e.target.value)}
        />
      </Field>
    </EditCard>
  );
}

function SmsAdd({
  onAdd,
  existingNames,
}: {
  onAdd: (t: SmsTemplate) => Promise<boolean>;
  existingNames: string[];
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [description, setDescription] = useState("");
  const [variables, setVariables] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={ADD_BUTTON}
      >
        + Add SMS template
      </button>
    );
  }

  return (
    <EditCard
      title="New SMS template"
      onCancel={() => {
        setOpen(false);
        setName("");
        setBody("");
        setDescription("");
        setVariables("");
        setErr(null);
      }}
      onSave={async () => {
        setErr(null);
        const trimmedName = name.trim();
        if (!/^[a-z0-9_]+$/.test(trimmedName)) {
          setErr("Name must be lowercase + snake_case.");
          return;
        }
        if (existingNames.includes(trimmedName)) {
          setErr(`A template named "${trimmedName}" already exists.`);
          return;
        }
        if (!body.trim()) {
          setErr("Body is required.");
          return;
        }
        setSaving(true);
        const ok = await onAdd({
          name: trimmedName,
          body,
          description: description.trim() || undefined,
          variables: variables
            ? variables.split(",").map((v) => v.trim()).filter(Boolean)
            : undefined,
        });
        setSaving(false);
        if (ok) {
          setOpen(false);
          setName("");
          setBody("");
          setDescription("");
          setVariables("");
        }
      }}
      saving={saving}
      error={err}
    >
      <Field label="Name (lowercase_snake_case)">
        <input
          className={INPUT}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="deal_ready"
          spellCheck={false}
        />
      </Field>
      <Field label={`Body (${body.length} chars)`}>
        <textarea
          className={`${INPUT} min-h-[120px] font-mono text-xs`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Hi {{recipient_name}}, deal {{deal_ref}} is ready to sign."
        />
      </Field>
      <Field label="Description">
        <input
          className={INPUT}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <Field label="Variables (comma-separated)">
        <input
          className={INPUT}
          value={variables}
          onChange={(e) => setVariables(e.target.value)}
        />
      </Field>
    </EditCard>
  );
}

// ---------------------------------------------------------------------------
// AI-call templates.
// ---------------------------------------------------------------------------

function CallSection({
  templates,
  onPatch,
}: {
  templates: CallTemplate[];
  onPatch: (patch: Partial<WorkspaceSettings>) => Promise<boolean>;
}): React.ReactElement {
  const save = async (next: CallTemplate[]): Promise<boolean> =>
    onPatch({ call_templates: next });

  return (
    <SectionShell
      title="AI-call templates"
      subtitle="The aiInstructions block Vex runs against during an AI-mode outbound call. The goal hint is a one-line summary surfaced on the chip preview so an operator can approve without reading the full prompt."
    >
      {templates.map((t, idx) => (
        <CallCard
          key={`${t.name}-${idx}`}
          template={t}
          onSave={async (updated) => {
            const next = templates.map((x, i) => (i === idx ? updated : x));
            return save(next);
          }}
          onDelete={async () => save(templates.filter((_, i) => i !== idx))}
        />
      ))}
      <CallAdd
        onAdd={async (t) => save([...templates, t])}
        existingNames={templates.map((t) => t.name)}
      />
    </SectionShell>
  );
}

function CallCard({
  template,
  onSave,
  onDelete,
}: {
  template: CallTemplate;
  onSave: (next: CallTemplate) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [aiInstructions, setAiInstructions] = useState(template.aiInstructions);
  const [goalHint, setGoalHint] = useState(template.goal_hint ?? "");
  const [description, setDescription] = useState(template.description ?? "");
  const [variables, setVariables] = useState((template.variables ?? []).join(", "));
  const [saving, setSaving] = useState(false);

  if (!editing) {
    return (
      <TemplateRow
        name={template.name}
        meta={template.goal_hint ?? "—"}
        description={template.description}
        variables={template.variables}
        body={template.aiInstructions}
        onEdit={() => setEditing(true)}
        onDelete={async () => {
          if (confirm(`Delete call template "${template.name}"?`)) {
            await onDelete();
          }
        }}
      />
    );
  }

  return (
    <EditCard
      title={`Editing ${template.name}`}
      onCancel={() => setEditing(false)}
      onSave={async () => {
        setSaving(true);
        const ok = await onSave({
          name: template.name,
          aiInstructions,
          goal_hint: goalHint.trim() || undefined,
          description: description.trim() || undefined,
          variables: variables
            ? variables.split(",").map((v) => v.trim()).filter(Boolean)
            : undefined,
        });
        setSaving(false);
        if (ok) setEditing(false);
      }}
      saving={saving}
    >
      <Field label="Goal hint (one-line, shown on chip preview)">
        <input
          className={INPUT}
          value={goalHint}
          onChange={(e) => setGoalHint(e.target.value)}
          placeholder="Confirm BL issuance ETA"
        />
      </Field>
      <Field label="aiInstructions (full system prompt)">
        <textarea
          className={`${INPUT} min-h-[200px] font-mono text-xs`}
          value={aiInstructions}
          onChange={(e) => setAiInstructions(e.target.value)}
        />
      </Field>
      <Field label="Description">
        <input
          className={INPUT}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <Field label="Variables (comma-separated)">
        <input
          className={INPUT}
          value={variables}
          onChange={(e) => setVariables(e.target.value)}
        />
      </Field>
    </EditCard>
  );
}

function CallAdd({
  onAdd,
  existingNames,
}: {
  onAdd: (t: CallTemplate) => Promise<boolean>;
  existingNames: string[];
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [aiInstructions, setAiInstructions] = useState("");
  const [goalHint, setGoalHint] = useState("");
  const [description, setDescription] = useState("");
  const [variables, setVariables] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={ADD_BUTTON}
      >
        + Add AI-call template
      </button>
    );
  }

  return (
    <EditCard
      title="New AI-call template"
      onCancel={() => {
        setOpen(false);
        setName("");
        setAiInstructions("");
        setGoalHint("");
        setDescription("");
        setVariables("");
        setErr(null);
      }}
      onSave={async () => {
        setErr(null);
        const trimmedName = name.trim();
        if (!/^[a-z0-9_]+$/.test(trimmedName)) {
          setErr("Name must be lowercase + snake_case.");
          return;
        }
        if (existingNames.includes(trimmedName)) {
          setErr(`A template named "${trimmedName}" already exists.`);
          return;
        }
        if (!aiInstructions.trim()) {
          setErr("aiInstructions is required.");
          return;
        }
        setSaving(true);
        const ok = await onAdd({
          name: trimmedName,
          aiInstructions,
          goal_hint: goalHint.trim() || undefined,
          description: description.trim() || undefined,
          variables: variables
            ? variables.split(",").map((v) => v.trim()).filter(Boolean)
            : undefined,
        });
        setSaving(false);
        if (ok) {
          setOpen(false);
          setName("");
          setAiInstructions("");
          setGoalHint("");
          setDescription("");
          setVariables("");
        }
      }}
      saving={saving}
      error={err}
    >
      <Field label="Name (lowercase_snake_case)">
        <input
          className={INPUT}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="bl_followup"
          spellCheck={false}
        />
      </Field>
      <Field label="Goal hint (one-line, shown on chip preview)">
        <input
          className={INPUT}
          value={goalHint}
          onChange={(e) => setGoalHint(e.target.value)}
          placeholder="Confirm BL issuance ETA"
        />
      </Field>
      <Field label="aiInstructions (full system prompt)">
        <textarea
          className={`${INPUT} min-h-[200px] font-mono text-xs`}
          value={aiInstructions}
          onChange={(e) => setAiInstructions(e.target.value)}
          placeholder="You are Vex calling on behalf of VTC. Ask {{recipient_name}} for an ETA on the BL for deal {{deal_ref}}..."
        />
      </Field>
      <Field label="Description">
        <input
          className={INPUT}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <Field label="Variables (comma-separated)">
        <input
          className={INPUT}
          value={variables}
          onChange={(e) => setVariables(e.target.value)}
          placeholder="recipient_name, deal_ref"
        />
      </Field>
    </EditCard>
  );
}

// ---------------------------------------------------------------------------
// Shared layout primitives.
// ---------------------------------------------------------------------------

function SectionShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-3">
      <header>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
          {title}
        </h3>
        <p className="mt-1 max-w-2xl text-xs text-text-secondary/80">
          {subtitle}
        </p>
      </header>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function TemplateRow({
  name,
  meta,
  description,
  variables,
  body,
  onEdit,
  onDelete,
}: {
  name: string;
  meta: string;
  description?: string | undefined;
  variables?: string[] | undefined;
  body?: string | undefined;
  onEdit: () => void;
  onDelete: () => void | Promise<void>;
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-line bg-muted/20 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-text-primary">{name}</span>
            <span className="truncate rounded bg-muted/40 px-1.5 py-px text-[10px] uppercase tracking-wide text-text-secondary">
              {meta}
            </span>
          </div>
          {description && (
            <p className="mt-1 text-xs text-text-secondary">{description}</p>
          )}
          {body && (
            <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-canvas/50 p-2 font-mono text-[11px] text-text-secondary">
              {body}
            </pre>
          )}
          {variables && variables.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {variables.map((v) => (
                <span
                  key={v}
                  className="rounded bg-muted/40 px-1.5 py-px font-mono text-[10px] text-text-secondary"
                >
                  {`{{${v}}}`}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={onEdit} className={SMALL_BUTTON}>
            Edit
          </button>
          <button
            type="button"
            onClick={() => {
              void onDelete();
            }}
            className={`${SMALL_BUTTON} text-red-400 hover:text-red-300`}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function EditCard({
  title,
  children,
  onCancel,
  onSave,
  saving,
  error,
}: {
  title: string;
  children: React.ReactNode;
  onCancel: () => void;
  onSave: () => void | Promise<void>;
  saving: boolean;
  error?: string | null;
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-line bg-muted/20 p-4">
      <h4 className="mb-3 text-sm font-semibold text-text-primary">{title}</h4>
      <div className="flex flex-col gap-3">{children}</div>
      {error && (
        <p className="mt-3 rounded bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={SMALL_BUTTON}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            void onSave();
          }}
          disabled={saving}
          className={`${SMALL_BUTTON} bg-accent/80 text-white disabled:opacity-50`}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs uppercase tracking-wide text-text-secondary">
        {label}
      </span>
      {children}
    </label>
  );
}

const INPUT =
  "w-full rounded border border-line bg-canvas/50 px-3 py-2 text-sm text-text-primary outline-none focus:border-accent";

const SMALL_BUTTON =
  "rounded border border-line bg-muted/40 px-3 py-1 text-xs text-text-primary hover:bg-muted/60";

const ADD_BUTTON =
  "self-start rounded border border-dashed border-line bg-muted/10 px-3 py-1.5 text-xs text-text-secondary hover:bg-muted/30";

// Defensive: silence unused warnings for hooks reserved for later (kept
// imported so future edits can use them without re-importing each time).
void useEffect;
void useMemo;
