"use client";

import { useEffect, useState } from "react";

interface Integration {
  name: string;
  configured: boolean;
  required: boolean;
  notes?: string;
}

export default function IntegrationsPage(): React.ReactElement {
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/integrations")
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((body: { integrations: Integration[] }) => {
        if (!cancelled) setIntegrations(body.integrations);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const critical = integrations?.filter(
    (i) => i.required && !i.configured,
  ).length ?? 0;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">Integrations</h1>
          <p className="mt-1 text-xs text-white/50">
            Every external service Vex depends on. Red on a required row is
            a hard operational issue — set the secret on Fly and redeploy.
          </p>
        </div>
        {integrations && (
          <span
            className={`rounded px-2 py-1 text-xs ${
              critical > 0
                ? "bg-bad/20 text-bad"
                : "bg-good/20 text-good"
            }`}
          >
            {critical > 0
              ? `${critical} required missing`
              : "All required configured"}
          </span>
        )}
      </header>

      {error && (
        <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </div>
      )}

      {integrations === null ? (
        <div className="text-sm text-white/50">Loading…</div>
      ) : (
        <ol className="flex flex-col gap-2">
          {integrations.map((i) => (
            <li
              key={i.name}
              className={`rounded-lg border px-3 py-3 ${
                !i.configured && i.required
                  ? "border-bad/40 bg-bad/5"
                  : !i.configured
                    ? "border-warn/30 bg-warn/5"
                    : "border-good/30 bg-muted/20"
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className={`h-2.5 w-2.5 rounded-full ${
                      i.configured
                        ? "bg-good"
                        : i.required
                          ? "bg-bad"
                          : "bg-warn"
                    }`}
                  />
                  <span className="text-sm font-medium text-white">
                    {i.name}
                  </span>
                  {i.required && (
                    <span className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-white/60">
                      required
                    </span>
                  )}
                </div>
                <span
                  className={`text-xs ${
                    i.configured ? "text-good" : i.required ? "text-bad" : "text-warn"
                  }`}
                >
                  {i.configured ? "Configured" : "Not configured"}
                </span>
              </div>
              {i.notes && (
                <p className="mt-1 pl-5 text-xs text-white/60">{i.notes}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
