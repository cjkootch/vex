"use client";

import { useState } from "react";

/**
 * /app/admin/demo-message — admin-only test page for firing a single
 * SMS or WhatsApp message at any number. Bypasses the approval gate
 * and normalizer pipeline; sends directly via Twilio.
 */

type State =
  | { name: "idle" }
  | { name: "sending" }
  | { name: "ok"; messageSid: string; status: string }
  | { name: "error"; message: string };

const DEFAULT_BODY =
  "Hi — this is Vex from Vector Trade Capital. Following up on your inquiry on our website about fuel trading. Do you have a minute to chat?";

export default function DemoMessagePage(): React.ReactElement {
  const [channel, setChannel] = useState<"sms" | "whatsapp">("whatsapp");
  const [to, setTo] = useState("");
  const [body, setBody] = useState(DEFAULT_BODY);
  const [state, setState] = useState<State>({ name: "idle" });

  async function fire(e: React.FormEvent) {
    e.preventDefault();
    setState({ name: "sending" });
    try {
      const res = await fetch("/api/calls/demo-message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel, to: to.trim(), body }),
      });
      if (!res.ok) {
        const errBody = (await res
          .json()
          .catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error ?? `${res.status} ${res.statusText}`);
      }
      const okBody = (await res.json()) as {
        messageSid: string;
        status: string;
      };
      setState({
        name: "ok",
        messageSid: okBody.messageSid,
        status: okBody.status,
      });
    } catch (err) {
      setState({ name: "error", message: (err as Error).message });
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-8">
      <header>
        <h1 className="text-xl font-semibold text-white">Demo message</h1>
        <p className="mt-1 text-xs text-white/50">
          Send a single SMS or WhatsApp message at any number. Bypasses the
          approval gate — test path only.
        </p>
      </header>

      <form
        onSubmit={fire}
        className="flex flex-col gap-3 rounded-lg border border-line bg-muted/20 p-4"
      >
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setChannel("whatsapp")}
            data-testid="channel-whatsapp"
            data-active={channel === "whatsapp"}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
              channel === "whatsapp"
                ? "bg-accent text-canvas"
                : "bg-muted/60 text-white/70 hover:bg-muted/80"
            }`}
          >
            WhatsApp
          </button>
          <button
            type="button"
            onClick={() => setChannel("sms")}
            data-testid="channel-sms"
            data-active={channel === "sms"}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
              channel === "sms"
                ? "bg-accent text-canvas"
                : "bg-muted/60 text-white/70 hover:bg-muted/80"
            }`}
          >
            SMS
          </button>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-white/50">
            Destination (E.164)
          </span>
          <input
            type="tel"
            required
            placeholder="+18324927169"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            data-testid="demo-message-to"
            className="rounded-md border border-line bg-canvas px-3 py-2 font-mono text-sm text-white focus:border-accent focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-white/50">
            Message body
          </span>
          <textarea
            required
            rows={5}
            value={body}
            onChange={(e) => setBody(e.target.value)}
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
            {state.name === "sending" ? "Sending…" : `Send ${channel.toUpperCase()}`}
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
          <div className="font-medium">Message queued.</div>
          <div className="mt-1 font-mono text-xs text-white/70">
            {state.messageSid} · status={state.status}
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
        <div className="font-medium text-white/70">WhatsApp sandbox note</div>
        <p className="mt-2">
          If your Twilio account is in WhatsApp sandbox mode, the recipient
          must first text{" "}
          <code className="font-mono">join &lt;sandbox-code&gt;</code> to the
          sandbox number (<code className="font-mono">+1 415 523 8886</code>)
          before they can receive messages from your account. The code is
          shown in Twilio console → Messaging → Try it out → Send a WhatsApp
          message.
        </p>
        <div className="mt-3 font-medium text-white/70">SMS note</div>
        <p className="mt-2">
          US-to-US SMS requires A2P 10DLC registration to be complete. An
          unregistered number sends at trial/limited throughput.
        </p>
      </div>
    </div>
  );
}
