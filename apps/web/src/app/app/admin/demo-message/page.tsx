"use client";

import { useState } from "react";

/**
 * /app/admin/demo-message — admin-only test page for firing a single
 * WhatsApp / SMS / email message. Bypasses the approval gate and
 * normalizer pipeline; sends directly via the relevant provider.
 */

type State =
  | { name: "idle" }
  | { name: "sending" }
  | { name: "ok"; ref: string; sub?: string }
  | { name: "error"; message: string };

type Channel = "whatsapp" | "sms" | "email";

const DEFAULT_SMS_BODY =
  "Hi — this is Vex from Vector Trade Capital. Following up on your inquiry on our website about fuel trading. Do you have a minute to chat?";

const DEFAULT_EMAIL_SUBJECT =
  "Quick follow-up on your fuel trading inquiry";

const DEFAULT_EMAIL_BODY = `Hi,

We received your inquiry on our website about fuel trading services with Vector Trade Capital. I wanted to follow up to learn a bit more about:

- Your approximate monthly volume
- Product grades you're interested in
- Your current supplier situation
- Timeline for getting started

Happy to hop on a quick call whenever it's convenient. Just hit reply or let me know a good time.

Best,
Vex — Vector Trade Capital`;

export default function DemoMessagePage(): React.ReactElement {
  const [channel, setChannel] = useState<Channel>("whatsapp");
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState(DEFAULT_EMAIL_SUBJECT);
  const [body, setBody] = useState(DEFAULT_SMS_BODY);
  const [emailBody, setEmailBody] = useState(DEFAULT_EMAIL_BODY);
  const [state, setState] = useState<State>({ name: "idle" });
  const [aiPrompt, setAiPrompt] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  async function draft(): Promise<void> {
    const prompt = aiPrompt.trim();
    if (!prompt) {
      setDraftError("Tell Vex what the email is about.");
      return;
    }
    setDrafting(true);
    setDraftError(null);
    try {
      const res = await fetch("/api/query/draft-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, tone: "friendly" }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const body = (await res.json()) as { subject?: string; body?: string };
      if (body.subject) setSubject(body.subject);
      if (body.body) setEmailBody(body.body);
    } catch (err) {
      setDraftError((err as Error).message);
    } finally {
      setDrafting(false);
    }
  }

  async function fire(e: React.FormEvent) {
    e.preventDefault();
    setState({ name: "sending" });
    try {
      const [url, payload] =
        channel === "email"
          ? [
              "/api/calls/demo-email",
              { to: to.trim(), subject, body: emailBody },
            ]
          : [
              "/api/calls/demo-message",
              { channel, to: to.trim(), body },
            ];
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errBody = (await res
          .json()
          .catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error ?? `${res.status} ${res.statusText}`);
      }
      const ok = (await res.json()) as {
        messageSid?: string;
        status?: string;
        messageId?: string;
      };
      setState({
        name: "ok",
        ref: ok.messageSid ?? ok.messageId ?? "ok",
        ...(ok.status ? { sub: `status=${ok.status}` } : {}),
      });
    } catch (err) {
      setState({ name: "error", message: (err as Error).message });
    }
  }

  const channelLabels: Record<Channel, string> = {
    whatsapp: "WhatsApp",
    sms: "SMS",
    email: "Email",
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-8">
      <header>
        <h1 className="text-xl font-semibold text-white">Demo message</h1>
        <p className="mt-1 text-xs text-white/50">
          Send a single WhatsApp, SMS, or email at any recipient. Bypasses the
          approval gate — test path only. Lands in /app/inbox as a touchpoint.
        </p>
      </header>

      <form
        onSubmit={fire}
        className="flex flex-col gap-3 rounded-lg border border-line bg-muted/20 p-4"
      >
        <div className="flex gap-2">
          {(["whatsapp", "sms", "email"] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setChannel(c)}
              data-testid={`channel-${c}`}
              data-active={channel === c}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
                channel === c
                  ? "bg-accent text-canvas"
                  : "bg-muted/60 text-white/70 hover:bg-muted/80"
              }`}
            >
              {channelLabels[c]}
            </button>
          ))}
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-white/50">
            {channel === "email" ? "To (email address)" : "To (E.164)"}
          </span>
          <input
            type={channel === "email" ? "email" : "tel"}
            required
            placeholder={channel === "email" ? "you@example.com" : "+18324927169"}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            data-testid="demo-message-to"
            className="rounded-md border border-line bg-canvas px-3 py-2 font-mono text-sm text-white focus:border-accent focus:outline-none"
          />
        </label>

        {channel === "email" && (
          <>
            <div className="flex flex-col gap-2 rounded-md border border-accent/30 bg-accent/5 p-3">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] uppercase tracking-wide text-accent">
                  AI draft
                </span>
                <input
                  type="text"
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  placeholder="e.g. follow up on fuel inquiry, ask about volume and timeline"
                  data-testid="demo-message-ai-prompt"
                  className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-accent focus:outline-none"
                />
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void draft()}
                  disabled={drafting}
                  data-testid="demo-message-ai-draft"
                  className="rounded-md border border-accent bg-accent/20 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/30 disabled:opacity-50"
                >
                  {drafting ? "Drafting…" : "Draft with Vex"}
                </button>
                {draftError && (
                  <span className="text-xs text-bad">{draftError}</span>
                )}
              </div>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-wide text-white/50">
                Subject
              </span>
              <input
                type="text"
                required
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                data-testid="demo-message-subject"
                className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-white focus:border-accent focus:outline-none"
              />
            </label>
          </>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-white/50">
            {channel === "email" ? "Body" : "Message body"}
          </span>
          <textarea
            required
            rows={channel === "email" ? 12 : 5}
            value={channel === "email" ? emailBody : body}
            onChange={(e) =>
              channel === "email"
                ? setEmailBody(e.target.value)
                : setBody(e.target.value)
            }
            data-testid="demo-message-body"
            className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-white focus:border-accent focus:outline-none"
          />
        </label>

        <div className="flex items-center justify-between gap-3">
          <button
            type="submit"
            disabled={state.name === "sending"}
            data-testid="demo-message-fire"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-canvas hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {state.name === "sending"
              ? "Sending…"
              : `Send ${channelLabels[channel]}`}
          </button>
          <span className="text-xs text-white/40">
            Lands in /app/inbox as a touchpoint.
          </span>
        </div>
      </form>

      {state.name === "ok" && (
        <div
          data-testid="demo-message-success"
          className="rounded-md border border-good/40 bg-good/10 px-3 py-2 text-sm text-good"
        >
          <div className="font-medium">Queued.</div>
          <div className="mt-1 font-mono text-xs text-white/70">
            {state.ref}
            {state.sub ? ` · ${state.sub}` : ""}
          </div>
        </div>
      )}
      {state.name === "error" && (
        <div
          data-testid="demo-message-error"
          className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad"
        >
          Couldn&apos;t send: {state.message}
        </div>
      )}

      <div className="mt-2 rounded-lg border border-line bg-muted/10 p-4 text-xs text-white/50">
        {channel === "whatsapp" && (
          <>
            <div className="font-medium text-white/70">WhatsApp sandbox note</div>
            <p className="mt-2">
              If your Twilio account is in WhatsApp sandbox mode, the
              recipient must first text{" "}
              <code className="font-mono">join &lt;sandbox-code&gt;</code> to
              the sandbox number (
              <code className="font-mono">+1 415 523 8886</code>) once before
              they can receive messages.
            </p>
          </>
        )}
        {channel === "sms" && (
          <>
            <div className="font-medium text-white/70">SMS note</div>
            <p className="mt-2">
              US-to-US SMS requires A2P 10DLC registration on the sender
              number. Unregistered numbers send at trial throughput or may be
              blocked by carriers.
            </p>
          </>
        )}
        {channel === "email" && (
          <>
            <div className="font-medium text-white/70">Email sender</div>
            <p className="mt-2">
              Email is sent via Resend. The <code className="font-mono">From</code>{" "}
              address comes from{" "}
              <code className="font-mono">RESEND_DEFAULT_FROM</code> (
              <code className="font-mono">Vex &lt;hello@vexhq.ai&gt;</code> by
              default). The sending domain must be verified in Resend → Domains.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
