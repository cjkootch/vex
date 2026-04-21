"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * PortPanel — origin + destination port cards on the deal-overview
 * page, plus a constraint-warnings strip below. Sits under the
 * VesselPanel.
 *
 * Per-card sections:
 *   - Name, UNLOCODE badge, country code
 *   - Terminal capability chips (Fuel / Container / Bulk / Reefer)
 *   - Draft / LOA / DWT limits with current vessel comparison when
 *     the vessel-driven warnings fired for that leg
 *   - Expected port days (median × congestion factor)
 *   - Active events list
 *
 * Empty state per card: when the leg's *_port_id is null, shows the
 * legacy free-text value from the deal + a "Link this" button that
 * PATCHes the deal when the backend's resolution hint matched a
 * UNLOCODE, or a disabled "Resolve in admin" note otherwise.
 */

interface PortSummary {
  id: string;
  unlocode: string;
  name: string;
  countryCode: string;
  region: string;
  maxDraftM: number | null;
  maxLoaM: number | null;
  maxBeamM: number | null;
  maxDwtMt: number | null;
  fuelTerminal: boolean;
  containerTerminal: boolean;
  bulkTerminal: boolean;
  reeferCapable: boolean;
  portDaysMedian: number | null;
  congestionFactor: number | null;
  pilotageRequired: boolean;
  workingHours: string | null;
  restrictedCargoNotes: string | null;
  lastVerifiedAt: string | null;
}

interface ActivePortEvent {
  id: string;
  eventType: string;
  severity: string;
  title: string;
  body: string | null;
  startsAt: string;
  endsAt: string | null;
}

interface Warning {
  code: string;
  severity: "info" | "caution" | "critical";
  message: string;
  affectedField: string;
}

interface PortsBundle {
  deal: { id: string; dealRef: string; product: string };
  originPort: PortSummary | null;
  destinationPort: PortSummary | null;
  originEvents: ActivePortEvent[];
  destinationEvents: ActivePortEvent[];
  warnings: Warning[];
  resolution: {
    origin: { suggested: PortSummary | null; fromText: string | null } | null;
    destination: {
      suggested: PortSummary | null;
      fromText: string | null;
    } | null;
  };
}

interface Props {
  dealId: string;
}

export function PortPanel({ dealId }: Props) {
  const [bundle, setBundle] = useState<PortsBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshIdx, setRefreshIdx] = useState(0);
  const [linking, setLinking] = useState<"origin" | "destination" | null>(null);

  const reload = useCallback(() => setRefreshIdx((i) => i + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/deals/${dealId}/ports`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as PortsBundle;
        if (!cancelled) {
          setBundle(body);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [dealId, refreshIdx]);

  async function linkPort(
    leg: "origin" | "destination",
    portId: string,
  ): Promise<void> {
    setLinking(leg);
    setError(null);
    try {
      const key = leg === "origin" ? "originPortId" : "destinationPortId";
      const res = await fetch(`/api/deals/${dealId}/ports`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [key]: portId }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(errBody.message ?? `HTTP ${res.status}`);
      }
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLinking(null);
    }
  }

  return (
    <section className="rounded-lg border border-line bg-muted/20 p-4">
      <header className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Ports</h3>
      </header>

      {error && (
        <p className="mb-3 rounded-md border border-bad/40 bg-bad/10 px-2 py-1 text-xs text-bad">
          {error}
        </p>
      )}

      {!bundle ? (
        <p className="text-xs text-white/50">Loading…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 md:grid-cols-2">
            <PortCard
              label="Origin"
              port={bundle.originPort}
              events={bundle.originEvents}
              warnings={filterLeg(bundle.warnings, "origin")}
              resolution={bundle.resolution.origin}
              linking={linking === "origin"}
              onLink={(id) => linkPort("origin", id)}
            />
            <PortCard
              label="Destination"
              port={bundle.destinationPort}
              events={bundle.destinationEvents}
              warnings={filterLeg(bundle.warnings, "destination")}
              resolution={bundle.resolution.destination}
              linking={linking === "destination"}
              onLink={(id) => linkPort("destination", id)}
            />
          </div>

          {bundle.warnings.length > 0 && (
            <ConstraintWarnings warnings={bundle.warnings} />
          )}
        </div>
      )}
    </section>
  );
}

function filterLeg(
  warnings: Warning[],
  leg: "origin" | "destination",
): Warning[] {
  return warnings.filter((w) => w.affectedField.includes(`.${leg}.`));
}

// ---------------------------------------------------------------------------
// Port card
// ---------------------------------------------------------------------------

function PortCard({
  label,
  port,
  events,
  warnings,
  resolution,
  linking,
  onLink,
}: {
  label: "Origin" | "Destination";
  port: PortSummary | null;
  events: ActivePortEvent[];
  warnings: Warning[];
  resolution: {
    suggested: PortSummary | null;
    fromText: string | null;
  } | null;
  linking: boolean;
  onLink: (portId: string) => void;
}) {
  if (!port) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-line bg-canvas/40 p-3 text-xs">
        <div className="text-[10px] uppercase tracking-wide text-white/40">
          {label}
        </div>
        {!resolution ? (
          <p className="text-white/60">No {label.toLowerCase()} port linked.</p>
        ) : resolution.suggested ? (
          <div className="flex flex-col gap-2">
            <p className="text-white/70">
              Not linked. Legacy text:{" "}
              <span className="text-white">
                {resolution.fromText ?? "—"}
              </span>
            </p>
            <div className="rounded-md border border-accent/40 bg-accent/5 p-2">
              <div className="text-white">
                Suggested: <span className="font-semibold">{resolution.suggested.name}</span>{" "}
                <span className="font-mono text-[10px] text-white/50">
                  {resolution.suggested.unlocode} · {resolution.suggested.countryCode}
                </span>
              </div>
              <button
                type="button"
                onClick={() => onLink(resolution.suggested!.id)}
                disabled={linking}
                className="mt-2 rounded-md bg-accent/80 px-2 py-1 text-[11px] font-medium text-white hover:bg-accent disabled:opacity-40"
              >
                {linking ? "Linking…" : "Link this port"}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="text-white/70">
              Not linked. Legacy text:{" "}
              <span className="text-white">
                {resolution.fromText ?? "—"}
              </span>
            </p>
            <p className="text-[11px] text-white/50">
              No UNLOCODE match in ports dimension. Add or edit the port in
              Admin → Ports, then come back.
            </p>
          </div>
        )}
      </div>
    );
  }

  const hasCritical = warnings.some((w) => w.severity === "critical");
  const hasWarn = warnings.some((w) => w.severity === "caution");
  const borderTone = hasCritical
    ? "border-bad/40"
    : hasWarn
      ? "border-warn/40"
      : "border-line";

  return (
    <div className={`flex flex-col gap-3 rounded-md border ${borderTone} bg-canvas/40 p-3 text-xs`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-white/40">
            {label}
          </div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="text-sm font-semibold text-white">{port.name}</span>
            <span className="rounded-md border border-line bg-canvas/60 px-1.5 py-0.5 font-mono text-[10px] text-white/60">
              {port.unlocode}
            </span>
          </div>
          <div className="mt-0.5 text-[10px] text-white/40">
            {port.countryCode} · {port.region}
          </div>
        </div>
        {port.lastVerifiedAt ? (
          <span className="text-[10px] text-good">
            ✓ verified {new Date(port.lastVerifiedAt).toLocaleDateString()}
          </span>
        ) : (
          <span className="text-[10px] text-white/40">unverified</span>
        )}
      </div>

      <TerminalChips port={port} />

      <div className="grid grid-cols-2 gap-1 text-[11px] text-white/70">
        <LimitRow
          label="Max draft"
          value={port.maxDraftM !== null ? `${port.maxDraftM.toFixed(1)} m` : "—"}
          warned={warnings.some((w) => w.code.endsWith("draft_exceeds_port_limit"))}
        />
        <LimitRow
          label="Max LOA"
          value={port.maxLoaM !== null ? `${port.maxLoaM.toFixed(0)} m` : "—"}
          warned={warnings.some((w) => w.code.endsWith("loa_exceeds_port_limit"))}
        />
        <LimitRow
          label="Max DWT"
          value={
            port.maxDwtMt !== null
              ? `${Math.round(port.maxDwtMt).toLocaleString()} MT`
              : "—"
          }
          warned={warnings.some((w) => w.code.endsWith("dwt_exceeds_port_limit"))}
        />
        <LimitRow
          label="Port days"
          value={expectedPortDays(port)}
          warned={warnings.some((w) => w.code.endsWith("congestion_elevated"))}
        />
      </div>

      {events.length > 0 && (
        <EventsList events={events} />
      )}

      {port.restrictedCargoNotes && (
        <p className="rounded-md border border-line bg-canvas/60 px-2 py-1 text-[11px] text-white/60">
          <span className="font-semibold text-white/80">Restricted:</span>{" "}
          {port.restrictedCargoNotes}
        </p>
      )}
    </div>
  );
}

function TerminalChips({ port }: { port: PortSummary }) {
  const chips: Array<{ label: string; on: boolean }> = [
    { label: "Fuel", on: port.fuelTerminal },
    { label: "Container", on: port.containerTerminal },
    { label: "Bulk", on: port.bulkTerminal },
    { label: "Reefer", on: port.reeferCapable },
  ];
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <span
          key={c.label}
          className={`rounded-md border px-1.5 py-0.5 text-[10px] ${
            c.on
              ? "border-good/40 bg-good/10 text-good"
              : "border-line bg-canvas/40 text-white/30"
          }`}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}

function LimitRow({
  label,
  value,
  warned,
}: {
  label: string;
  value: string;
  warned: boolean;
}) {
  const tone = warned ? "text-bad" : "text-white";
  return (
    <div className="flex items-center justify-between">
      <span className="text-white/40">{label}</span>
      <span className={`tabular-nums ${tone}`}>
        {warned ? "⚠ " : ""}
        {value}
      </span>
    </div>
  );
}

function expectedPortDays(port: PortSummary): string {
  if (port.portDaysMedian === null || port.portDaysMedian === undefined)
    return "—";
  const factor = port.congestionFactor ?? 1;
  const effective = port.portDaysMedian * factor;
  return `${effective.toFixed(1)} d${factor > 1.05 ? ` (×${factor.toFixed(2)})` : ""}`;
}

function EventsList({ events }: { events: ActivePortEvent[] }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] uppercase tracking-wide text-white/40">
        Active events
      </div>
      {events.map((e) => (
        <div
          key={e.id}
          className={`rounded-md border px-2 py-1 text-[11px] ${
            e.severity === "critical"
              ? "border-bad/40 bg-bad/10 text-bad"
              : e.severity === "warn"
                ? "border-warn/40 bg-warn/10 text-warn"
                : "border-line bg-canvas/60 text-white/70"
          }`}
        >
          <div className="font-semibold">
            {e.eventType.toUpperCase()} · {e.title}
          </div>
          {e.body && <div className="opacity-80">{e.body}</div>}
          <div className="text-[10px] opacity-60">
            since {new Date(e.startsAt).toLocaleDateString()}
            {e.endsAt
              ? ` · until ${new Date(e.endsAt).toLocaleDateString()}`
              : " · ongoing"}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Constraint warnings strip
// ---------------------------------------------------------------------------

function ConstraintWarnings({ warnings }: { warnings: Warning[] }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-line bg-canvas/40 px-3 py-2 text-xs">
      <div className="text-[10px] uppercase tracking-wide text-white/40">
        Constraint warnings
      </div>
      {warnings.map((w, i) => (
        <div
          key={`${w.code}-${w.affectedField}-${i}`}
          className={`rounded-md border px-2 py-1 text-[11px] ${
            w.severity === "critical"
              ? "border-bad/40 bg-bad/10 text-bad"
              : "border-warn/40 bg-warn/10 text-warn"
          }`}
        >
          <span className="font-semibold">{w.severity.toUpperCase()} · </span>
          {w.message}
        </div>
      ))}
    </div>
  );
}
