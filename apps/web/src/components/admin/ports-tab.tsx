"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchWithRetry } from "@/lib/fetch-with-retry";
import { Modal } from "@/components/ui/modal";
import { FormField, Select, TextArea, TextInput } from "@/components/ui/form-field";

/**
 * Admin → Ports tab. Lists every port in the tenant, opens an edit
 * drawer on row click, exposes an "Add port" form + an "Active events"
 * collapsible that lets operators file closure / congestion /
 * regulatory events against any port.
 *
 * Every mutation (create port, edit port, add event) refreshes both
 * the ports table and the events section so the tab's numbers stay
 * consistent with what's been persisted.
 */

interface AdminPort {
  id: string;
  unlocode: string;
  name: string;
  countryCode: string;
  region: string;
  lat: number | null;
  lng: number | null;
  maxDraftM: number | null;
  maxLoaM: number | null;
  maxBeamM: number | null;
  maxDwtMt: number | null;
  fuelTerminal: boolean;
  containerTerminal: boolean;
  bulkTerminal: boolean;
  reeferCapable: boolean;
  customsClearanceDaysMedian: number | null;
  portDaysMedian: number | null;
  congestionFactor: number | null;
  tariffNotes: string | null;
  restrictedCargoNotes: string | null;
  workingHours: string | null;
  pilotageRequired: boolean;
  localAgentOrgId: string | null;
  lastVerifiedAt: string | null;
}

interface ActivePortEvent {
  id: string;
  portId: string;
  eventType: string;
  severity: string;
  title: string;
  body: string | null;
  startsAt: string;
  endsAt: string | null;
  sourceUrl: string | null;
}

const EVENT_TYPES = [
  { value: "closure", label: "Closure" },
  { value: "congestion", label: "Congestion" },
  { value: "strike", label: "Strike" },
  { value: "tariff_change", label: "Tariff change" },
  { value: "regulatory", label: "Regulatory" },
];

const EVENT_SEVERITIES = [
  { value: "info", label: "Info" },
  { value: "warn", label: "Warn" },
  { value: "critical", label: "Critical" },
];

export function PortsTab() {
  const [ports, setPorts] = useState<AdminPort[]>([]);
  const [events, setEvents] = useState<ActivePortEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshIdx, setRefreshIdx] = useState(0);
  const [editPort, setEditPort] = useState<AdminPort | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [addEventForPort, setAddEventForPort] = useState<AdminPort | null>(null);

  const reload = useCallback(() => setRefreshIdx((i) => i + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [portsRes, eventsRes] = await Promise.all([
          fetchWithRetry("/api/admin/ports", {
            credentials: "include",
            cache: "no-store",
          }),
          fetchWithRetry("/api/admin/port-events", {
            credentials: "include",
            cache: "no-store",
          }),
        ]);
        if (!portsRes.ok) throw new Error(`ports ${portsRes.status}`);
        if (!eventsRes.ok) throw new Error(`events ${eventsRes.status}`);
        const portsBody = (await portsRes.json()) as { ports: AdminPort[] };
        const eventsBody = (await eventsRes.json()) as {
          events: ActivePortEvent[];
        };
        if (!cancelled) {
          setPorts(portsBody.ports);
          setEvents(eventsBody.events);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshIdx]);

  const portsById = useMemo(() => {
    const m = new Map<string, AdminPort>();
    for (const p of ports) m.set(p.id, p);
    return m;
  }, [ports]);

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </p>
      )}

      <section>
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Ports</h2>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="rounded-md border border-line bg-accent/80 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent"
          >
            + Add port
          </button>
        </header>

        {ports.length === 0 ? (
          <p className="rounded-md border border-line bg-muted/40 px-3 py-2 text-sm text-white/60">
            No ports yet. Click &ldquo;Add port&rdquo; to seed this tenant.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-line">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-[10px] uppercase tracking-wide text-white/50">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">UNLOCODE</th>
                  <th className="px-3 py-2">Region</th>
                  <th className="px-3 py-2">Max draft</th>
                  <th className="px-3 py-2">Terminals</th>
                  <th className="px-3 py-2">Last verified</th>
                </tr>
              </thead>
              <tbody>
                {ports.map((p) => (
                  <tr
                    key={p.id}
                    onClick={() => setEditPort(p)}
                    className="cursor-pointer border-t border-line/60 hover:bg-muted/30"
                  >
                    <td className="px-3 py-2 text-white">{p.name}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-white/70">
                      {p.unlocode}
                    </td>
                    <td className="px-3 py-2 text-white/70">{p.region}</td>
                    <td className="px-3 py-2 tabular-nums text-white/80">
                      {p.maxDraftM !== null ? `${p.maxDraftM.toFixed(1)} m` : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <TerminalBadges port={p} />
                    </td>
                    <td className="px-3 py-2 text-[11px] text-white/60">
                      {p.lastVerifiedAt
                        ? new Date(p.lastVerifiedAt).toLocaleDateString()
                        : <span className="italic text-white/40">unverified</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-md border border-line bg-muted/20">
        <button
          type="button"
          onClick={() => setEventsOpen((o) => !o)}
          className="flex w-full items-center justify-between px-3 py-2 text-sm text-white/70 hover:text-white"
        >
          <span>
            Active events
            <span className="ml-2 text-[10px] text-white/40">
              ({events.length})
            </span>
          </span>
          <span className="text-[10px] text-white/40">
            {eventsOpen ? "Hide" : "Show"}
          </span>
        </button>
        {eventsOpen && (
          <div className="flex flex-col gap-2 border-t border-line/60 px-3 py-3">
            {events.length === 0 ? (
              <p className="text-xs text-white/50">
                No active port events. Add one from a port row&apos;s drawer.
              </p>
            ) : (
              events.map((e) => (
                <EventCard
                  key={e.id}
                  event={e}
                  port={portsById.get(e.portId) ?? null}
                />
              ))
            )}
          </div>
        )}
      </section>

      {createOpen && (
        <PortDrawer
          mode="create"
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false);
            reload();
          }}
          onError={setError}
        />
      )}
      {editPort && (
        <PortDrawer
          mode="edit"
          initial={editPort}
          onClose={() => setEditPort(null)}
          onSaved={() => {
            setEditPort(null);
            reload();
          }}
          onError={setError}
          onAddEvent={() => {
            const p = editPort;
            setEditPort(null);
            setAddEventForPort(p);
          }}
        />
      )}
      {addEventForPort && (
        <AddEventDrawer
          port={addEventForPort}
          onClose={() => setAddEventForPort(null)}
          onSaved={() => {
            setAddEventForPort(null);
            reload();
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table row helpers
// ---------------------------------------------------------------------------

function TerminalBadges({ port }: { port: AdminPort }) {
  const chips: Array<{ k: string; on: boolean }> = [
    { k: "F", on: port.fuelTerminal },
    { k: "C", on: port.containerTerminal },
    { k: "B", on: port.bulkTerminal },
    { k: "R", on: port.reeferCapable },
  ];
  return (
    <div className="flex gap-1">
      {chips.map((c) => (
        <span
          key={c.k}
          className={`inline-flex h-5 w-5 items-center justify-center rounded-sm text-[10px] font-semibold ${
            c.on
              ? "bg-good/20 text-good"
              : "bg-canvas/60 text-white/30"
          }`}
          title={
            {
              F: "Fuel terminal",
              C: "Container terminal",
              B: "Bulk terminal",
              R: "Reefer capable",
            }[c.k]
          }
        >
          {c.k}
        </span>
      ))}
    </div>
  );
}

function EventCard({
  event,
  port,
}: {
  event: ActivePortEvent;
  port: AdminPort | null;
}) {
  const tone =
    event.severity === "critical"
      ? "border-bad/40 bg-bad/10 text-bad"
      : event.severity === "warn"
        ? "border-warn/40 bg-warn/10 text-warn"
        : "border-line bg-canvas/40 text-white/70";
  return (
    <div className={`rounded-md border px-3 py-2 text-xs ${tone}`}>
      <div className="flex items-baseline justify-between">
        <span className="font-semibold">
          {port?.name ?? event.portId}
          <span className="ml-2 text-[10px] uppercase opacity-70">
            {event.eventType.replace(/_/g, " ")} · {event.severity}
          </span>
        </span>
        <span className="text-[10px] opacity-60">
          since {new Date(event.startsAt).toLocaleDateString()}
          {event.endsAt
            ? ` · until ${new Date(event.endsAt).toLocaleDateString()}`
            : " · ongoing"}
        </span>
      </div>
      <div className="mt-1 font-medium">{event.title}</div>
      {event.body && <div className="opacity-85">{event.body}</div>}
      {event.sourceUrl && (
        <a
          href={event.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-[10px] underline opacity-70 hover:opacity-100"
        >
          source
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Port drawer (create + edit share the form)
// ---------------------------------------------------------------------------

const REGIONS = [
  { value: "caribbean", label: "Caribbean" },
  { value: "usgc", label: "US Gulf Coast" },
  { value: "usec", label: "US East Coast" },
  { value: "uswc", label: "US West Coast" },
  { value: "ecca", label: "East Coast Central America" },
  { value: "med", label: "Mediterranean" },
  { value: "namer", label: "North America (other)" },
  { value: "samer", label: "South America" },
];

interface PortDrawerProps {
  mode: "create" | "edit";
  initial?: AdminPort;
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
  onAddEvent?: () => void;
}

function PortDrawer({
  mode,
  initial,
  onClose,
  onSaved,
  onError,
  onAddEvent,
}: PortDrawerProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [unlocode, setUnlocode] = useState(initial?.unlocode ?? "");
  const [countryCode, setCountryCode] = useState(initial?.countryCode ?? "");
  const [region, setRegion] = useState(initial?.region ?? "caribbean");
  const [maxDraftM, setMaxDraftM] = useState(
    initial?.maxDraftM !== null && initial?.maxDraftM !== undefined
      ? String(initial.maxDraftM)
      : "",
  );
  const [maxLoaM, setMaxLoaM] = useState(
    initial?.maxLoaM !== null && initial?.maxLoaM !== undefined
      ? String(initial.maxLoaM)
      : "",
  );
  const [maxBeamM, setMaxBeamM] = useState(
    initial?.maxBeamM !== null && initial?.maxBeamM !== undefined
      ? String(initial.maxBeamM)
      : "",
  );
  const [maxDwtMt, setMaxDwtMt] = useState(
    initial?.maxDwtMt !== null && initial?.maxDwtMt !== undefined
      ? String(initial.maxDwtMt)
      : "",
  );
  const [fuelTerminal, setFuelTerminal] = useState(initial?.fuelTerminal ?? false);
  const [containerTerminal, setContainerTerminal] = useState(
    initial?.containerTerminal ?? false,
  );
  const [bulkTerminal, setBulkTerminal] = useState(initial?.bulkTerminal ?? false);
  const [reeferCapable, setReeferCapable] = useState(
    initial?.reeferCapable ?? false,
  );
  const [portDaysMedian, setPortDaysMedian] = useState(
    initial?.portDaysMedian !== null && initial?.portDaysMedian !== undefined
      ? String(initial.portDaysMedian)
      : "",
  );
  const [customsClearanceDaysMedian, setCustomsClearanceDaysMedian] = useState(
    initial?.customsClearanceDaysMedian !== null &&
      initial?.customsClearanceDaysMedian !== undefined
      ? String(initial.customsClearanceDaysMedian)
      : "",
  );
  const [congestionFactor, setCongestionFactor] = useState(
    initial?.congestionFactor !== null && initial?.congestionFactor !== undefined
      ? String(initial.congestionFactor)
      : "1.0",
  );
  const [workingHours, setWorkingHours] = useState(initial?.workingHours ?? "");
  const [pilotageRequired, setPilotageRequired] = useState(
    initial?.pilotageRequired ?? true,
  );
  const [tariffNotes, setTariffNotes] = useState(initial?.tariffNotes ?? "");
  const [restrictedCargoNotes, setRestrictedCargoNotes] = useState(
    initial?.restrictedCargoNotes ?? "",
  );
  const [verify, setVerify] = useState(false);
  const [saving, setSaving] = useState(false);

  function toNumOrNull(s: string): number | null {
    const t = s.trim();
    if (!t) return null;
    const n = Number.parseFloat(t);
    return Number.isFinite(n) ? n : null;
  }

  async function save(): Promise<void> {
    if (saving) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        countryCode: countryCode.trim().toUpperCase(),
        region,
        maxDraftM: toNumOrNull(maxDraftM),
        maxLoaM: toNumOrNull(maxLoaM),
        maxBeamM: toNumOrNull(maxBeamM),
        maxDwtMt: toNumOrNull(maxDwtMt),
        fuelTerminal,
        containerTerminal,
        bulkTerminal,
        reeferCapable,
        portDaysMedian: toNumOrNull(portDaysMedian),
        customsClearanceDaysMedian: toNumOrNull(customsClearanceDaysMedian),
        congestionFactor: toNumOrNull(congestionFactor) ?? undefined,
        workingHours: workingHours.trim() || null,
        pilotageRequired,
        tariffNotes: tariffNotes.trim() || null,
        restrictedCargoNotes: restrictedCargoNotes.trim() || null,
      };
      let res: Response;
      if (mode === "create") {
        payload["unlocode"] = unlocode.trim().toUpperCase();
        res = await fetch("/api/admin/ports", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        if (verify) payload["verify"] = true;
        res = await fetch(`/api/admin/ports/${initial!.id}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `HTTP ${res.status}`);
      }
      onSaved();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={true}
      onClose={() => {
        if (!saving) onClose();
      }}
      title={mode === "create" ? "Add port" : `Edit ${initial?.name}`}
      size="xl"
      {...(mode === "edit" && initial?.lastVerifiedAt
        ? {
            description: `Last verified ${new Date(initial.lastVerifiedAt).toLocaleDateString()}`,
          }
        : {})}
      footer={
        <>
          {mode === "edit" && onAddEvent && (
            <button
              type="button"
              onClick={onAddEvent}
              className="mr-auto rounded-md border border-line px-3 py-1.5 text-sm text-white/80 hover:border-accent hover:text-white"
            >
              + Add event
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-white/80 hover:border-accent hover:text-white disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-40"
          >
            {saving ? "Saving…" : mode === "create" ? "Create" : "Save"}
          </button>
        </>
      }
    >
      <div className="grid max-h-[70vh] grid-cols-2 gap-3 overflow-y-auto pr-1">
        <FormField label="Name" required>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <FormField
          label="UNLOCODE"
          required
          hint={mode === "edit" ? "Immutable — create a new port to change" : "5 chars · e.g. JMKIN"}
        >
          <TextInput
            value={unlocode}
            onChange={(e) => setUnlocode(e.target.value.toUpperCase())}
            maxLength={5}
            disabled={mode === "edit"}
          />
        </FormField>
        <FormField label="Country code" required hint="ISO 3166-1 alpha-2">
          <TextInput
            value={countryCode}
            onChange={(e) => setCountryCode(e.target.value.toUpperCase())}
            maxLength={2}
          />
        </FormField>
        <FormField label="Region" required>
          <Select
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            options={REGIONS}
          />
        </FormField>

        <FormField label="Max draft (m)">
          <TextInput
            type="number"
            inputMode="decimal"
            step="0.1"
            value={maxDraftM}
            onChange={(e) => setMaxDraftM(e.target.value)}
          />
        </FormField>
        <FormField label="Max LOA (m)">
          <TextInput
            type="number"
            inputMode="decimal"
            step="1"
            value={maxLoaM}
            onChange={(e) => setMaxLoaM(e.target.value)}
          />
        </FormField>
        <FormField label="Max beam (m)">
          <TextInput
            type="number"
            inputMode="decimal"
            step="0.1"
            value={maxBeamM}
            onChange={(e) => setMaxBeamM(e.target.value)}
          />
        </FormField>
        <FormField label="Max DWT (MT)">
          <TextInput
            type="number"
            inputMode="decimal"
            step="1000"
            value={maxDwtMt}
            onChange={(e) => setMaxDwtMt(e.target.value)}
          />
        </FormField>

        <div className="col-span-2">
          <FormField label="Terminals">
            <div className="grid grid-cols-4 gap-2 text-xs">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={fuelTerminal}
                  onChange={(e) => setFuelTerminal(e.target.checked)}
                />
                Fuel
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={containerTerminal}
                  onChange={(e) => setContainerTerminal(e.target.checked)}
                />
                Container
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={bulkTerminal}
                  onChange={(e) => setBulkTerminal(e.target.checked)}
                />
                Bulk
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={reeferCapable}
                  onChange={(e) => setReeferCapable(e.target.checked)}
                />
                Reefer
              </label>
            </div>
          </FormField>
        </div>

        <FormField label="Port days median">
          <TextInput
            type="number"
            inputMode="decimal"
            step="0.1"
            value={portDaysMedian}
            onChange={(e) => setPortDaysMedian(e.target.value)}
          />
        </FormField>
        <FormField label="Customs clearance days median">
          <TextInput
            type="number"
            inputMode="decimal"
            step="0.1"
            value={customsClearanceDaysMedian}
            onChange={(e) => setCustomsClearanceDaysMedian(e.target.value)}
          />
        </FormField>
        <FormField
          label="Congestion factor"
          hint="1.0 = nominal · > 1 = congested"
        >
          <TextInput
            type="number"
            inputMode="decimal"
            step="0.05"
            value={congestionFactor}
            onChange={(e) => setCongestionFactor(e.target.value)}
          />
        </FormField>
        <FormField label="Working hours">
          <TextInput
            value={workingHours}
            onChange={(e) => setWorkingHours(e.target.value)}
            placeholder="24/7 or 0700-1900"
          />
        </FormField>
        <div className="col-span-2">
          <FormField label="Pilotage required">
            <label className="flex items-center gap-2 text-xs text-white/70">
              <input
                type="checkbox"
                checked={pilotageRequired}
                onChange={(e) => setPilotageRequired(e.target.checked)}
              />
              Yes
            </label>
          </FormField>
        </div>

        <div className="col-span-2">
          <FormField label="Tariff notes">
            <TextArea
              value={tariffNotes}
              onChange={(e) => setTariffNotes(e.target.value)}
              rows={2}
            />
          </FormField>
        </div>
        <div className="col-span-2">
          <FormField
            label="Restricted cargo notes"
            hint="Free-text — the calculator's restricted_cargo check parses this for product/verb pairs."
          >
            <TextArea
              value={restrictedCargoNotes}
              onChange={(e) => setRestrictedCargoNotes(e.target.value)}
              rows={2}
            />
          </FormField>
        </div>

        {mode === "edit" && (
          <div className="col-span-2">
            <label className="flex items-center gap-2 text-xs text-white/70">
              <input
                type="checkbox"
                checked={verify}
                onChange={(e) => setVerify(e.target.checked)}
              />
              Stamp lastVerifiedAt = now on save
            </label>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Add event drawer
// ---------------------------------------------------------------------------

function AddEventDrawer({
  port,
  onClose,
  onSaved,
  onError,
}: {
  port: AdminPort;
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [eventType, setEventType] = useState("congestion");
  const [severity, setSeverity] = useState("warn");
  const [startsAt, setStartsAt] = useState(
    new Date().toISOString().slice(0, 16),
  );
  const [endsAt, setEndsAt] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(): Promise<void> {
    if (saving) return;
    if (!title.trim()) {
      onError("Title is required.");
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        portId: port.id,
        eventType,
        severity,
        startsAt: new Date(startsAt).toISOString(),
        title: title.trim(),
      };
      if (endsAt) payload["endsAt"] = new Date(endsAt).toISOString();
      if (body.trim()) payload["body"] = body.trim();
      if (sourceUrl.trim()) payload["sourceUrl"] = sourceUrl.trim();
      const res = await fetch("/api/admin/port-events", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(errBody.message ?? `HTTP ${res.status}`);
      }
      onSaved();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={true}
      onClose={() => {
        if (!saving) onClose();
      }}
      title={`Add event — ${port.name}`}
      description="Fires a port_event row that the port-intelligence agent will
        broadcast to every open deal touching this port."
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-white/80 hover:border-accent hover:text-white disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Create event"}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Event type" required>
          <Select
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            options={EVENT_TYPES}
          />
        </FormField>
        <FormField label="Severity" required>
          <Select
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            options={EVENT_SEVERITIES}
          />
        </FormField>
        <FormField label="Starts at" required>
          <TextInput
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
        </FormField>
        <FormField label="Ends at" hint="Leave empty for ongoing">
          <TextInput
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
          />
        </FormField>
        <div className="col-span-2">
          <FormField label="Title" required>
            <TextInput
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Kingston container terminal 48h closure"
            />
          </FormField>
        </div>
        <div className="col-span-2">
          <FormField label="Body">
            <TextArea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
            />
          </FormField>
        </div>
        <div className="col-span-2">
          <FormField label="Source URL">
            <TextInput
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://…"
            />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}
