"use client";

import { useState } from "react";

/**
 * /app/admin/demo-call — admin-only test page for firing a scripted
 * Twilio call at any phone number. Bypasses the approval gate and
 * the OutboundCallWorkflow; runs entirely through the
 * `POST /calls/demo` path for verifying the Twilio plumbing.
 */

type State =
  | { name: "idle" }
  | { name: "dialing" }
  | { name: "ok"; callSid: string; status: string }
  | { name: "error"; message: string };

const DEFAULT_SCRIPT =
  "Hi, this is Vex calling on behalf of Vector Trade Capital. " +
  "We received your inquiry on our website about fuel trading services. " +
  "I wanted to follow up to learn a bit about your volume requirements " +
  "and the product grades you're interested in. " +
  "Do you have a minute to chat?";

export default function DemoCallPage(): React.ReactElement {
  const [phone, setPhone] = useState("");
  const [script, setScript] = useState(DEFAULT_SCRIPT);
  const [mode, setMode] = useState<"polly" | "ai">("polly");
  const [state, setState] = useState<State>({ name: "idle" });

  async function fire(e: React.FormEvent) {
    e.preventDefault();
    setState({ name: "dialing" });
    try {
      const payload: Record<string, unknown> = {
        phone: phone.trim(),
        mode,
      };
      if (mode === "polly") payload["script"] = script;
      const res = await fetch("/api/calls/demo", {
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
      const okBody = (await res.json()) as {
        callSid: string;
        status: string;
      };
      setState({
        name: "ok",
        callSid: okBody.callSid,
        status: okBody.status,
      });
    } catch (err) {
      setState({ name: "error", message: (err as Error).message });
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-8">
      <header>
        <h1 className="text-xl font-semibold text-white">Demo call</h1>
        <p className="mt-1 text-xs text-white/50">
          Dials a number and speaks a scripted greeting via Twilio&apos;s Polly
          voice. Bypasses the approval gate and the outbound workflow — this
          is a test path, not the production caller flow.
        </p>
      </header>

      <form
        onSubmit={fire}
        className="flex flex-col gap-3 rounded-lg border border-line bg-muted/20 p-4"
      >
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode("polly")}
            data-testid="mode-polly"
            data-active={mode === "polly"}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
              mode === "polly"
                ? "bg-accent text-canvas"
                : "bg-muted/60 text-white/70 hover:bg-muted/80"
            }`}
          >
            Scripted (Polly)
          </button>
          <button
            type="button"
            onClick={() => setMode("ai")}
            data-testid="mode-ai"
            data-active={mode === "ai"}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
              mode === "ai"
                ? "bg-accent text-canvas"
                : "bg-muted/60 text-white/70 hover:bg-muted/80"
            }`}
          >
            AI conversation (Sprint L)
          </button>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-white/50">
            Destination phone (E.164)
          </span>
          <input
            type="tel"
            required
            placeholder="+18324927169"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            data-testid="demo-call-phone"
            className="rounded-md border border-line bg-canvas px-3 py-2 font-mono text-sm text-white focus:border-accent focus:outline-none"
          />
        </label>
        {mode === "polly" ? (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-white/50">
              Script (Polly will speak this)
            </span>
            <textarea
              required
              rows={6}
              value={script}
              onChange={(e) => setScript(e.target.value)}
              data-testid="demo-call-script"
              className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-white focus:border-accent focus:outline-none"
            />
          </label>
        ) : (
          <div className="rounded-md border border-accent/40 bg-accent/10 p-3 text-xs text-white/70">
            <div className="font-medium text-accent">AI conversation mode</div>
            <p className="mt-1">
              Vex will call and have a real two-way conversation with the
              callee as a fuel-trading qualifier. Powered by OpenAI
              Realtime. No script — the AI asks qualifying questions,
              listens, and can fire <code className="font-mono">escalate_to_human</code>{" "}
              if they want a real person.
            </p>
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <button
            type="submit"
            disabled={state.name === "dialing"}
            data-testid="demo-call-fire"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-canvas hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {state.name === "dialing" ? "Dialing…" : "Fire call"}
          </button>
          <span className="text-xs text-white/40">
            Your phone should ring within a few seconds.
          </span>
        </div>
      </form>

      {state.name === "ok" && (
        <div
          data-testid="demo-call-success"
          className="rounded-md border border-good/40 bg-good/10 px-3 py-2 text-sm text-good"
        >
          <div className="font-medium">Call queued.</div>
          <div className="mt-1 font-mono text-xs text-white/70">
            {state.callSid} · status={state.status}
          </div>
        </div>
      )}
      {state.name === "error" && (
        <div
          data-testid="demo-call-error"
          className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad"
        >
          Couldn&apos;t fire call: {state.message}
        </div>
      )}

      <div className="mt-2 rounded-lg border border-line bg-muted/10 p-4 text-xs text-white/50">
        <div className="font-medium text-white/70">Requirements</div>
        <ul className="mt-2 list-inside list-disc space-y-1">
          <li>
            <code className="font-mono">TWILIO_ACCOUNT_SID</code> /{" "}
            <code className="font-mono">TWILIO_AUTH_TOKEN</code> /{" "}
            <code className="font-mono">TWILIO_PHONE_NUMBER</code> set on the
            API.
          </li>
          <li>
            <code className="font-mono">APP_BASE_URL</code> set to the public
            HTTPS URL of the API (so Twilio can fetch the TwiML).
          </li>
          <li>
            If the Twilio account is in trial mode, the destination number
            must be in the verified caller-IDs list.
          </li>
        </ul>
      </div>
    </div>
  );
}
