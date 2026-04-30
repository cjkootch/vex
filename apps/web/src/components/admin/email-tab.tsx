"use client";

import { useState, useEffect, useMemo } from "react";
import type { WorkspaceSettings } from "./admin-console";

/**
 * Admin → Email tab. Three workspace-level controls:
 *   1. Sender display name — applied to every outbound `From` header
 *      (verified address itself is unchanged; Resend formats as
 *      `"Display Name" <verified@domain>`).
 *   2. Always-CC addresses — recipients see them; useful for
 *      operators who want every outbound copied to their own inbox
 *      so threads stay searchable in Outlook / Gmail.
 *   3. Email signature — HTML + plain-text appended to the body.
 *
 * Each control PATCHes workspace settings independently. Empty
 * values clear the override.
 */
export function EmailTab({
  settings,
  onPatch,
}: {
  settings: WorkspaceSettings | null;
  onPatch: (patch: Partial<WorkspaceSettings>) => Promise<boolean>;
}): React.ReactElement {
  const current = settings?.email_signature ?? {};
  const currentFromName = settings?.email_from_name ?? "";
  const currentCc = settings?.email_cc ?? [];

  const [fromName, setFromName] = useState("");
  const [ccText, setCcText] = useState("");
  const [html, setHtml] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFromName(currentFromName);
    setCcText(currentCc.join("\n"));
    setHtml(current.html ?? "");
    setText(current.text ?? "");
    setSaved(false);
    setError(null);
  }, [currentFromName, currentCc, current.html, current.text]);

  const parsedCc = useMemo(
    () =>
      ccText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    [ccText],
  );

  const dirty = useMemo(() => {
    if (fromName !== currentFromName) return true;
    if (
      parsedCc.length !== currentCc.length ||
      parsedCc.some((addr, i) => addr !== currentCc[i])
    )
      return true;
    return html !== (current.html ?? "") || text !== (current.text ?? "");
  }, [
    fromName,
    parsedCc,
    html,
    text,
    currentFromName,
    currentCc,
    current.html,
    current.text,
  ]);

  async function save(): Promise<void> {
    setSaving(true);
    setSaved(false);
    setError(null);
    const invalidCc = parsedCc.filter((addr) => !/^\S+@\S+\.\S+$/.test(addr));
    if (invalidCc.length > 0) {
      setSaving(false);
      setError(`Not valid email addresses: ${invalidCc.join(", ")}`);
      return;
    }
    const ok = await onPatch({
      email_from_name: fromName,
      email_cc: parsedCc,
      email_signature: { html, text },
    });
    setSaving(false);
    if (ok) setSaved(true);
  }

  const lastSaved = current.updated_at
    ? new Date(current.updated_at).toLocaleString()
    : null;

  return (
    <section className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <header>
          <h2 className="text-lg font-semibold text-text-primary">
            Sender display name
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            Decorates the outbound{" "}
            <code className="font-mono text-text-primary">From</code> header
            for every approved{" "}
            <code className="font-mono text-text-primary">email.send</code>{" "}
            action. Recipients see this name; the technical address stays on
            the workspace's verified domain. Leave blank to send with the
            address alone.
          </p>
        </header>
        <input
          type="text"
          value={fromName}
          onChange={(e) => {
            setFromName(e.target.value);
            setSaved(false);
          }}
          placeholder="Cole Kutschinski"
          maxLength={120}
          className="w-full max-w-md rounded-md border border-line-soft bg-surface-2/60 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
      </div>

      <div className="flex flex-col gap-3">
        <header>
          <h2 className="text-lg font-semibold text-text-primary">
            Always-CC addresses
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            CC&apos;d on every outbound{" "}
            <code className="font-mono text-text-primary">email.send</code>.
            Recipients see them. Typical use: copy your own work address so
            threads land in your inbox and stay searchable. One address per
            line, max 5.
          </p>
        </header>
        <textarea
          value={ccText}
          onChange={(e) => {
            setCcText(e.target.value);
            setSaved(false);
          }}
          rows={3}
          spellCheck={false}
          placeholder="cole@vectortradecapital.com"
          className="w-full max-w-md rounded-md border border-line-soft bg-surface-2/60 px-3 py-2 font-mono text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
      </div>

      <header>
        <h2 className="text-lg font-semibold text-text-primary">
          Email signature
        </h2>
        <p className="mt-1 text-sm text-text-secondary">
          Appended to every outbound email sent through an approved{" "}
          <code className="font-mono text-text-primary">email.send</code>{" "}
          action. Plain text falls back to HTML-stripped when not provided.
          Leave both blank to use the auto-generated default (workspace name
          only).
        </p>
        {lastSaved ? (
          <p className="mt-2 text-xs text-text-muted">
            Last saved {lastSaved}
          </p>
        ) : null}
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <label
            className="text-eyebrow text-text-secondary"
            htmlFor="sig-html"
          >
            HTML signature
          </label>
          <textarea
            id="sig-html"
            value={html}
            onChange={(e) => {
              setHtml(e.target.value);
              setSaved(false);
            }}
            rows={12}
            spellCheck={false}
            placeholder='<div><strong>Your Name</strong><br/>Title · Vector Trade Capital<br/><a href="mailto:you@vex.example">you@vex.example</a></div>'
            className="font-mono text-[12px] w-full rounded-md border border-line-soft bg-surface-2/60 px-3 py-2 text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
          <p className="text-xs text-text-muted">
            Raw HTML. Inline styles only — Gmail and Outlook strip{" "}
            <code className="font-mono">&lt;style&gt;</code> blocks.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <label
            className="text-eyebrow text-text-secondary"
            htmlFor="sig-text"
          >
            Plain-text signature
          </label>
          <textarea
            id="sig-text"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
            rows={12}
            spellCheck={false}
            placeholder={`Your Name\nTitle · Vector Trade Capital\n+1 877 549 4685 · you@vex.example\nvectortradecapital.com`}
            className="w-full rounded-md border border-line-soft bg-surface-2/60 px-3 py-2 font-mono text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
          <p className="text-xs text-text-muted">
            Rendered by plain-text email clients and accessibility tools.
            Appended after an RFC-standard{" "}
            <code className="font-mono">&quot;-- &quot;</code> delimiter.
          </p>
        </div>
      </div>

      {html ? (
        <div className="flex flex-col gap-2">
          <span className="text-eyebrow text-text-secondary">HTML preview</span>
          <div
            className="rounded-md border border-line-soft bg-white p-4"
            // eslint-disable-next-line react/no-danger -- operator-authored signature
            dangerouslySetInnerHTML={{ __html: html }}
          />
          <p className="text-xs text-text-muted">
            Preview renders in your browser on a white background to match
            typical inbox chrome.
          </p>
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || saving}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-strong disabled:opacity-40"
        >
          {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
        {saved && !dirty ? (
          <span className="text-xs text-emerald-300">Saved</span>
        ) : null}
        {error ? <span className="text-xs text-bad">{error}</span> : null}
      </div>
    </section>
  );
}
