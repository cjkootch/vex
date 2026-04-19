"use client";

import { useEffect, useState } from "react";

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

interface ScenarioTemplate {
  label: string;
  instructions: string;
}

const DEFAULT_TEMPLATES: ScenarioTemplate[] = [
  {
    label: "Fuel lead qualifier",
    instructions:
      "You are Vex, a fuel-trading qualifier calling on behalf of Vector Trade Capital. Open the call by introducing yourself, mention you're following up on a website inquiry, and ask if they have a minute. Your goal is to learn: (1) the callee's monthly fuel volume, (2) which product grades they care about (ULSD, jet fuel, etc.), (3) timeline to start trading. Speak conversationally — short sentences, warm, professional. Listen actively and follow up on interesting answers. If the callee asks to speak to a real person or sounds frustrated, call the escalate_to_human tool with a concise reason. End by summarising what you heard and asking if they'd like a follow-up call with a trader.",
  },
  {
    label: "Appointment reminder",
    instructions:
      "You are Vex, calling on behalf of Vector Trade Capital to remind the callee of their scheduled appointment tomorrow at 2pm Central. Confirm they can still make it. If they need to reschedule, ask for two alternative time windows and repeat them back. Keep the call under 90 seconds. Friendly, efficient, warm.",
  },
  {
    label: "Cold intro — B2B SaaS",
    instructions:
      "You are Alex, a senior account executive calling a cold prospect about a B2B SaaS platform for supply-chain analytics. Open with a 10-second framing line: who you are, why you're calling, and a specific reason (e.g. their recent hire of a supply-chain lead). Ask one diagnostic question about their current analytics stack. Listen. If they engage, propose a 15-minute discovery call next week. If they push back or say 'not interested', thank them politely and offer to send a 1-page brief by email. Never be pushy. Use natural speech patterns — filler words, pauses, short sentences.",
  },
];

const TEMPLATES_KEY = "vex.demo-call.templates";

function loadTemplates(): ScenarioTemplate[] {
  if (typeof window === "undefined") return DEFAULT_TEMPLATES;
  try {
    const raw = window.localStorage.getItem(TEMPLATES_KEY);
    if (!raw) return DEFAULT_TEMPLATES;
    const parsed = JSON.parse(raw) as ScenarioTemplate[];
    if (!Array.isArray(parsed) || parsed.length !== 3) return DEFAULT_TEMPLATES;
    if (!parsed.every((t) => typeof t?.label === "string" && typeof t?.instructions === "string")) {
      return DEFAULT_TEMPLATES;
    }
    return parsed;
  } catch {
    return DEFAULT_TEMPLATES;
  }
}

export default function DemoCallPage(): React.ReactElement {
  const [phone, setPhone] = useState("");
  const [script, setScript] = useState(DEFAULT_SCRIPT);
  const [mode, setMode] = useState<"polly" | "ai">("polly");
  const [templates, setTemplates] = useState<ScenarioTemplate[]>(DEFAULT_TEMPLATES);
  const [activeTemplate, setActiveTemplate] = useState(0);
  const [instructions, setInstructions] = useState(DEFAULT_TEMPLATES[0]!.instructions);
  const [label, setLabel] = useState(DEFAULT_TEMPLATES[0]!.label);
  const [savedFlash, setSavedFlash] = useState(false);
  const [state, setState] = useState<State>({ name: "idle" });

  useEffect(() => {
    const loaded = loadTemplates();
    setTemplates(loaded);
    setInstructions(loaded[0]!.instructions);
    setLabel(loaded[0]!.label);
  }, []);

  function switchTemplate(idx: number): void {
    setActiveTemplate(idx);
    const t = templates[idx];
    if (t) {
      setInstructions(t.instructions);
      setLabel(t.label);
    }
  }

  function saveTemplate(): void {
    const next = templates.slice();
    next[activeTemplate] = { label: label.trim() || `Template ${activeTemplate + 1}`, instructions };
    setTemplates(next);
    try {
      window.localStorage.setItem(TEMPLATES_KEY, JSON.stringify(next));
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch {
      /* localStorage quota or disabled — no-op */
    }
  }

  function resetTemplates(): void {
    if (!window.confirm("Reset all 3 templates to defaults?")) return;
    setTemplates(DEFAULT_TEMPLATES);
    setInstructions(DEFAULT_TEMPLATES[activeTemplate]!.instructions);
    setLabel(DEFAULT_TEMPLATES[activeTemplate]!.label);
    try {
      window.localStorage.removeItem(TEMPLATES_KEY);
    } catch {
      /* ignore */
    }
  }

  async function fire(e: React.FormEvent) {
    e.preventDefault();
    setState({ name: "dialing" });
    try {
      const payload: Record<string, unknown> = {
        phone: phone.trim(),
        mode,
      };
      if (mode === "polly") payload["script"] = script;
      if (mode === "ai" && instructions.trim()) {
        payload["instructions"] = instructions.trim();
      }
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
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 rounded-md border border-accent/40 bg-accent/10 p-3 text-xs text-white/70">
              <div className="font-medium text-accent">AI conversation scenario</div>
              <p>
                Pick a template and tweak as needed. Edits save back to the
                selected slot (browser-local). The AI uses this prompt as its
                full system instructions for the call.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {templates.map((t, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => switchTemplate(idx)}
                  data-testid={`template-${idx}`}
                  data-active={activeTemplate === idx}
                  className={`flex-1 min-w-[140px] rounded-md border px-3 py-2 text-xs font-medium ${
                    activeTemplate === idx
                      ? "border-accent bg-accent/20 text-white"
                      : "border-line bg-muted/60 text-white/70 hover:bg-muted/80"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-wide text-white/50">
                Template label
              </span>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                data-testid="demo-call-template-label"
                className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-white focus:border-accent focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-wide text-white/50">
                System prompt (Vex will speak based on this)
              </span>
              <textarea
                required
                rows={10}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                data-testid="demo-call-instructions"
                className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-white focus:border-accent focus:outline-none"
              />
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={saveTemplate}
                data-testid="demo-call-save-template"
                className="rounded-md border border-line bg-muted/60 px-3 py-2 text-xs font-medium text-white/80 hover:bg-muted/80"
              >
                Save to template {activeTemplate + 1}
              </button>
              <button
                type="button"
                onClick={resetTemplates}
                data-testid="demo-call-reset-templates"
                className="rounded-md border border-line bg-muted/40 px-3 py-2 text-xs font-medium text-white/60 hover:bg-muted/80"
              >
                Reset all to defaults
              </button>
              {savedFlash && (
                <span className="text-xs text-good">Saved</span>
              )}
            </div>
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
