"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";

/**
 * /app/inbox/t/:id — touchpoint drill-in.
 *
 * Fetches the full touchpoint row (email / SMS / WhatsApp) so the
 * operator can read the whole message body, not just the 240-char
 * preview the list view shows. Distinct route from /app/inbox/:id
 * (which is the activity/voice_call drill-in) so the two data shapes
 * stay decoupled.
 */

interface TouchpointDetail {
  id: string;
  channel: string;
  actor: string | null;
  occurredAt: string;
  contactId: string | null;
  orgId: string | null;
  campaignId: string | null;
  metadata: Record<string, unknown>;
}

export default function InboxTouchpointPage({
  params,
}: {
  params: { id: string };
}): React.ReactElement {
  const [detail, setDetail] = useState<TouchpointDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [replySending, setReplySending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replyApprovalId, setReplyApprovalId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/communications/touchpoints/${params.id}`,
      );
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as TouchpointDetail;
      setDetail(body);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const sendReply = useCallback(async () => {
    const text = replyBody.trim();
    if (text.length === 0) {
      setReplyError("Type a reply first.");
      return;
    }
    setReplySending(true);
    setReplyError(null);
    setReplyApprovalId(null);
    try {
      const res = await fetch(
        `/api/communications/touchpoints/${params.id}/reply`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: text }),
        },
      );
      const payload = (await res.json().catch(() => ({}))) as {
        approvalId?: string;
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        throw new Error(
          payload.message ?? payload.error ?? `${res.status} ${res.statusText}`,
        );
      }
      if (!payload.approvalId) {
        throw new Error("no approval id in response");
      }
      setReplyApprovalId(payload.approvalId);
      setReplyBody("");
    } catch (err) {
      setReplyError((err as Error).message);
    } finally {
      setReplySending(false);
    }
  }, [params.id, replyBody]);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          Couldn&apos;t load message: {error}
        </div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8 text-sm text-white/50">
        Loading…
      </div>
    );
  }

  const meta = detail.metadata;
  const subject = stringField(meta, "subject");
  const from = stringField(meta, "from");
  const to = meta["to"];
  const toList = Array.isArray(to)
    ? to.filter((v): v is string => typeof v === "string")
    : typeof to === "string"
      ? [to]
      : [];
  const messageId = stringField(meta, "message_id");
  const inReplyTo = stringField(meta, "in_reply_to");
  const direction = stringField(meta, "direction");
  const bodyText = stringField(meta, "body_text");
  const bodyHtml = stringField(meta, "body_html");
  const preview = stringField(meta, "preview");
  const providerMessageId = stringField(meta, "provider_message_id");
  const verb = detail.channel.includes(".")
    ? detail.channel.split(".", 2)[1]
    : null;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-8">
      <header>
        <Link
          href="/app/inbox"
          className="text-xs text-white/50 hover:text-white/80"
        >
          ← Inbox
        </Link>
        <div className="mt-1 flex items-center gap-2">
          <h1 className="text-xl font-semibold text-white">
            {subject ?? "(no subject)"}
          </h1>
          {verb && (
            <span className="rounded bg-accent/20 px-2 py-0.5 text-xs text-accent">
              {verb}
            </span>
          )}
          {direction && (
            <span className="rounded bg-muted/60 px-2 py-0.5 text-xs text-white/70">
              {direction}
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-white/50">
          {formatDistanceToNow(new Date(detail.occurredAt), { addSuffix: true })}
          {" · "}
          {new Date(detail.occurredAt).toLocaleString()}
        </p>
      </header>

      <section className="grid grid-cols-1 gap-3 rounded-lg border border-line bg-muted/20 p-4 text-sm sm:grid-cols-2">
        {from && <Field label="From" value={from} mono />}
        {toList.length > 0 && (
          <Field label="To" value={toList.join(", ")} mono />
        )}
        {detail.contactId && (
          <div className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-white/40">
              Contact
            </span>
            <Link
              href={`/app/contacts/${detail.contactId}`}
              className="w-fit rounded-md border border-line bg-muted/40 px-2 py-1 font-mono text-xs text-white/80 hover:bg-muted/60"
            >
              {detail.contactId} →
            </Link>
          </div>
        )}
        {detail.orgId && (
          <div className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-white/40">
              Company
            </span>
            <Link
              href={`/app/companies/${detail.orgId}`}
              className="w-fit rounded-md border border-line bg-muted/40 px-2 py-1 font-mono text-xs text-white/80 hover:bg-muted/60"
            >
              {detail.orgId} →
            </Link>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-line bg-muted/10 p-4">
        <div className="mb-2 text-[11px] uppercase tracking-wide text-white/40">
          Message
        </div>
        {bodyText ? (
          <pre className="whitespace-pre-wrap font-sans text-sm text-white/90">
            {bodyText}
          </pre>
        ) : bodyHtml ? (
          // Rendered inline but inside a sandboxed iframe-like wrapper.
          // NOTE: iframe-srcdoc is safer than dangerouslySetInnerHTML
          // because it isolates remote styles and scripts from the app
          // chrome. Display:block + width:100% so long messages scroll
          // naturally; height grows to fit content via a resize hint.
          <iframe
            title="Email HTML body"
            className="min-h-[200px] w-full rounded bg-white"
            sandbox=""
            srcDoc={bodyHtml}
          />
        ) : preview ? (
          <div className="text-sm italic text-white/60">
            {preview} <span className="text-white/40">(preview only)</span>
          </div>
        ) : (
          <div className="text-sm italic text-white/40">
            No body stored for this message.
          </div>
        )}
      </section>

      {(messageId || inReplyTo || providerMessageId) && (
        <section className="rounded-lg border border-line bg-muted/10 p-4 text-xs">
          <div className="mb-2 text-[11px] uppercase tracking-wide text-white/40">
            Threading
          </div>
          {messageId && <Field label="Message-Id" value={messageId} mono small />}
          {inReplyTo && (
            <Field label="In-Reply-To" value={inReplyTo} mono small />
          )}
          {providerMessageId && (
            <Field label="Provider id" value={providerMessageId} mono small />
          )}
        </section>
      )}

      {direction === "inbound" && from && (
        <section className="rounded-lg border border-line bg-muted/10 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-wide text-white/40">
              Reply
            </div>
            <div className="font-mono text-[11px] text-white/50">
              to {from}
            </div>
          </div>
          <textarea
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            placeholder="Write a reply…"
            rows={6}
            disabled={replySending}
            className="w-full rounded-md border border-line bg-bg/60 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-accent focus:outline-none disabled:opacity-50"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <div className="flex-1 text-xs">
              {replyError && (
                <span className="text-bad">Error: {replyError}</span>
              )}
              {replyApprovalId && (
                <span className="text-good">
                  Sent. Tracking as{" "}
                  <Link
                    href={`/app/approvals/${replyApprovalId}`}
                    className="underline hover:text-white"
                  >
                    approval {replyApprovalId.slice(0, 8)}…
                  </Link>
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void sendReply()}
              disabled={replySending || replyBody.trim().length === 0}
              className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-bg hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {replySending ? "Sending…" : "Send reply"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  small,
}: {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-white/40">
        {label}
      </span>
      <span
        className={`${small ? "text-xs" : "text-sm"} text-white/80 ${mono ? "font-mono" : ""} break-all`}
      >
        {value}
      </span>
    </div>
  );
}

function stringField(
  md: Record<string, unknown>,
  key: string,
): string | null {
  const v = md[key];
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}
