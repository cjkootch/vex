"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "framer-motion";

/**
 * Single-port panel — answers "show me Kingston" / "pull up Caucedo"
 * with a regional Leaflet map + a spec card (draft/LOA/DWT limits,
 * terminals, customs + port days, active closures). Click Expand for
 * a full-screen view. The `activeEvents` array surfaces closures,
 * strikes, or congestion currently affecting the port so operators
 * don't have to click through to a separate page.
 */

const PortDetailLeaflet = dynamic(() => import("./port-detail-leaflet"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-xs text-white/40">
      Loading map…
    </div>
  ),
});

interface ApiPort {
  maxDraftM: number | null;
  maxLoaM: number | null;
  maxBeamM: number | null;
  maxDwtMt: number | null;
  customsClearanceDaysMedian: number | null;
  portDaysMedian: number | null;
  congestionFactor: number | null;
  workingHours: string | null;
  pilotageRequired: boolean;
  fuelTerminal: boolean;
  containerTerminal: boolean;
  bulkTerminal: boolean;
  reeferCapable: boolean;
  tariffNotes: string | null;
  restrictedCargoNotes: string | null;
}

interface ApiActiveEvent {
  eventType: string;
  severity?: "info" | "warn" | "critical";
  title: string;
  body?: string | null;
  startsAt: string | Date;
  endsAt?: string | Date | null;
}

interface Specs {
  maxDraftM?: number | null | undefined;
  maxLoaM?: number | null | undefined;
  maxBeamM?: number | null | undefined;
  maxDwtMt?: number | null | undefined;
  customsClearanceDaysMedian?: number | null | undefined;
  portDaysMedian?: number | null | undefined;
  congestionFactor?: number | null | undefined;
  workingHours?: string | null | undefined;
  pilotageRequired?: boolean | undefined;
}

interface Terminals {
  fuel?: boolean | undefined;
  container?: boolean | undefined;
  bulk?: boolean | undefined;
  reefer?: boolean | undefined;
}

interface ActiveEvent {
  eventType: string;
  severity?: "info" | "warn" | "critical" | undefined;
  title: string;
  body?: string | null | undefined;
  startsAt: string;
  endsAt?: string | null | undefined;
}

interface Notes {
  tariff?: string | null | undefined;
  restrictedCargo?: string | null | undefined;
}

export interface PortDetailPanelProps {
  title?: string | undefined;
  unlocode: string;
  label: string;
  countryCode: string;
  region?: string | undefined;
  lat: number;
  lon: number;
  specs?: Specs | undefined;
  terminals?: Terminals | undefined;
  activeEvents?: ActiveEvent[] | undefined;
  notes?: Notes | undefined;
}

export function PortDetailPanel(props: PortDetailPanelProps) {
  const {
    title,
    unlocode,
    label,
    countryCode,
    region,
    lat,
    lon,
  } = props;
  const [expanded, setExpanded] = useState(false);
  const [hydrated, setHydrated] = useState<{
    specs?: Specs;
    terminals?: Terminals;
    activeEvents?: ActiveEvent[];
    notes?: Notes;
  } | null>(null);

  // Manifest-supplied data wins; otherwise fetch the full spec by
  // UN/LOCODE so Claude only has to emit identity + coords.
  const hasProvidedDetail =
    props.specs || props.terminals || props.activeEvents || props.notes;

  useEffect(() => {
    if (hasProvidedDetail) return;
    let cancelled = false;
    fetch(`/api/ports/${encodeURIComponent(unlocode)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      })
      .then((body: { port?: ApiPort; activeEvents?: ApiActiveEvent[] }) => {
        if (cancelled || !body.port) return;
        setHydrated({
          specs: {
            maxDraftM: body.port.maxDraftM,
            maxLoaM: body.port.maxLoaM,
            maxBeamM: body.port.maxBeamM,
            maxDwtMt: body.port.maxDwtMt,
            customsClearanceDaysMedian: body.port.customsClearanceDaysMedian,
            portDaysMedian: body.port.portDaysMedian,
            congestionFactor: body.port.congestionFactor,
            workingHours: body.port.workingHours,
            pilotageRequired: body.port.pilotageRequired,
          },
          terminals: {
            fuel: body.port.fuelTerminal,
            container: body.port.containerTerminal,
            bulk: body.port.bulkTerminal,
            reefer: body.port.reeferCapable,
          },
          activeEvents: (body.activeEvents ?? []).map((e) => ({
            eventType: e.eventType,
            severity: e.severity,
            title: e.title,
            body: e.body,
            startsAt:
              typeof e.startsAt === "string"
                ? e.startsAt
                : new Date(e.startsAt).toISOString(),
            endsAt:
              e.endsAt == null
                ? null
                : typeof e.endsAt === "string"
                  ? e.endsAt
                  : new Date(e.endsAt).toISOString(),
          })),
          notes: {
            tariff: body.port.tariffNotes,
            restrictedCargo: body.port.restrictedCargoNotes,
          },
        });
      })
      .catch(() => {
        /* spec card just renders dashes if the fetch fails */
      });
    return () => {
      cancelled = true;
    };
  }, [unlocode, hasProvidedDetail]);

  const specs = props.specs ?? hydrated?.specs;
  const terminals = props.terminals ?? hydrated?.terminals;
  const activeEvents = props.activeEvents ?? hydrated?.activeEvents;
  const notes = props.notes ?? hydrated?.notes;

  return (
    <>
      <section className="overflow-hidden rounded-lg border border-line bg-muted/20">
        <header className="flex items-center justify-between border-b border-line px-3 py-2">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/50">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
            {title ?? "Port"}
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] text-white/40">
              {label} · {unlocode} · {countryCode}
              {region ? ` · ${region}` : ""}
            </span>
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="rounded border border-line bg-canvas/60 px-1.5 py-0.5 font-mono text-[10px] text-white/60 transition-colors hover:border-accent hover:text-accent"
              title="Expand map"
            >
              ⤢ expand
            </button>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px]">
          <div className="relative aspect-[2/1] bg-canvas/60">
            <PortDetailLeaflet
              label={label}
              lat={lat}
              lon={lon}
              unlocode={unlocode}
            />
          </div>

          <aside className="border-t border-line bg-canvas/40 p-3 text-sm lg:border-l lg:border-t-0">
            <SpecGroup label="Limits">
              <SpecRow k="Max draft" v={fmtMeters(specs?.maxDraftM)} />
              <SpecRow k="Max LOA" v={fmtMeters(specs?.maxLoaM)} />
              <SpecRow k="Max DWT" v={fmtDwt(specs?.maxDwtMt)} />
            </SpecGroup>

            <SpecGroup label="Timing">
              <SpecRow
                k="Customs"
                v={fmtDays(specs?.customsClearanceDaysMedian)}
              />
              <SpecRow k="Port days" v={fmtDays(specs?.portDaysMedian)} />
              <SpecRow
                k="Congestion"
                v={fmtCongestion(specs?.congestionFactor)}
              />
            </SpecGroup>

            <SpecGroup label="Terminals">
              <TerminalChips terminals={terminals} />
            </SpecGroup>

            {(specs?.workingHours || specs?.pilotageRequired !== undefined) && (
              <SpecGroup label="Ops">
                {specs?.workingHours && (
                  <SpecRow k="Hours" v={specs.workingHours} />
                )}
                {specs?.pilotageRequired !== undefined && (
                  <SpecRow
                    k="Pilotage"
                    v={specs.pilotageRequired ? "required" : "not required"}
                  />
                )}
              </SpecGroup>
            )}
          </aside>
        </div>

        {activeEvents && activeEvents.length > 0 && (
          <div className="border-t border-line bg-canvas/40 px-3 py-2">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-white/50">
              Active events
            </div>
            <ul className="flex flex-col gap-1">
              {activeEvents.map((e, i) => (
                <li
                  key={i}
                  className={`rounded border-l-2 pl-2 text-xs ${severityBorder(e.severity)}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-white/90">{e.title}</span>
                    <span className="font-mono text-[10px] text-white/40">
                      {e.eventType}
                    </span>
                  </div>
                  {e.body && (
                    <div className="text-[11px] text-white/60">{e.body}</div>
                  )}
                  <div className="text-[10px] text-white/40">
                    since {new Date(e.startsAt).toLocaleDateString()}
                    {e.endsAt
                      ? ` · through ${new Date(e.endsAt).toLocaleDateString()}`
                      : ""}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(notes?.tariff || notes?.restrictedCargo) && (
          <div className="border-t border-line bg-canvas/40 px-3 py-2 text-[11px] text-white/60">
            {notes?.tariff && <div>Tariff: {notes.tariff}</div>}
            {notes?.restrictedCargo && (
              <div>Restricted: {notes.restrictedCargo}</div>
            )}
          </div>
        )}
      </section>

      <AnimatePresence>
        {expanded ? (
          <ExpandedMap
            label={label}
            unlocode={unlocode}
            lat={lat}
            lon={lon}
            onClose={() => setExpanded(false)}
          />
        ) : null}
      </AnimatePresence>
    </>
  );
}

function SpecGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-white/50">
        {label}
      </div>
      <dl className="grid grid-cols-[90px_1fr] gap-y-0.5 text-[12px]">
        {children}
      </dl>
    </div>
  );
}

function SpecRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-white/50">{k}</dt>
      <dd className="text-white">{v}</dd>
    </>
  );
}

function TerminalChips({ terminals }: { terminals?: Terminals | undefined }) {
  const t = terminals ?? {};
  const chips: Array<{ label: string; on: boolean }> = [
    { label: "Fuel", on: Boolean(t.fuel) },
    { label: "Container", on: Boolean(t.container) },
    { label: "Bulk", on: Boolean(t.bulk) },
    { label: "Reefer", on: Boolean(t.reefer) },
  ];
  return (
    <dd className="col-span-2 flex flex-wrap gap-1">
      {chips.map((c) => (
        <span
          key={c.label}
          className={`rounded px-1.5 py-0.5 text-[10px] ${c.on ? "bg-accent/20 text-accent" : "bg-muted/60 text-white/30"}`}
        >
          {c.label}
        </span>
      ))}
    </dd>
  );
}

function fmtMeters(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v.toFixed(1)} m`;
}

function fmtDwt(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M mt`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}k mt`;
  return `${v} mt`;
}

function fmtDays(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v} d (median)`;
}

function fmtCongestion(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v <= 1.05) return `${v.toFixed(2)} (clear)`;
  if (v <= 1.3) return `${v.toFixed(2)} (moderate)`;
  return `${v.toFixed(2)} (heavy)`;
}

function severityBorder(sev: ActiveEvent["severity"]): string {
  if (sev === "critical") return "border-bad/70";
  if (sev === "warn") return "border-warn/70";
  return "border-accent/40";
}

function ExpandedMap({
  label,
  unlocode,
  lat,
  lon,
  onClose,
}: {
  label: string;
  unlocode: string;
  lat: number;
  lon: number;
  onClose: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="fixed inset-0 z-[60] flex flex-col bg-black/70 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      tabIndex={-1}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.97 }}
        transition={{ type: "spring", stiffness: 320, damping: 30 }}
        className="mx-auto my-6 flex h-[calc(100vh-3rem)] w-[calc(100vw-3rem)] max-w-[1400px] flex-col overflow-hidden rounded-lg border border-line bg-canvas shadow-2xl"
      >
        <header className="flex flex-shrink-0 items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-white">{label}</span>
            <span className="font-mono text-xs text-white/50">
              {unlocode} · {lat.toFixed(3)}, {lon.toFixed(3)}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close expanded map"
            className="rounded border border-line px-2 py-1 text-xs text-white/60 transition-colors hover:border-accent hover:text-accent"
          >
            Close ✕
          </button>
        </header>
        <div className="flex-1">
          <PortDetailLeaflet
            label={label}
            lat={lat}
            lon={lon}
            unlocode={unlocode}
            expanded
          />
        </div>
      </motion.div>
    </motion.div>
  );
}
