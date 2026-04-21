import { and, desc, inArray } from "drizzle-orm";
import { type DealStatus } from "@vex/domain";
import {
  FuelDealRepository,
  PortRepository,
  SignalRepository,
  VesselRepository,
  schema,
  validatePortConstraints,
  type DealWarning,
  type FuelDeal,
  type Port,
  type PortEvent,
  type PortSpec,
  type Vessel,
  type VesselSpec,
} from "@vex/db";
import type { ProposedAction } from "@vex/integrations";
import type { AgentContext, AgentOutput, IAgent } from "./types.js";

/**
 * PortIntelligenceAgent — T1 cron agent that validates physical +
 * operational port constraints across every open fuel deal, plus
 * broadcasts active port events (closures / congestion / strikes /
 * tariff changes / regulatory) to every deal touching the affected
 * port.
 *
 * Two concurrent passes per run:
 *
 *   1. Constraint pass. For each open deal, resolve origin +
 *      destination ports (prefer *_port_id, fall back to UNLOCODE
 *      lookup on the legacy *_port text column), load the linked
 *      vessel, and call calculator.validatePortConstraints. Each
 *      warning lands as a `port.<code>` signal at caution→warn /
 *      critical severity.
 *
 *   2. Event-alert pass. For every active port_event of severity
 *      warn / critical, fire a signal against every open deal using
 *      that port as origin OR destination. Idempotent via the
 *      SignalRepository.fire dedupe on (tenant, ruleId, subject).
 *
 * Tier T1 — internal writes + signals only. No proposedActions; the
 * deal-creator dashboard already surfaces port warnings inline via
 * calculateFuelDeal (T4), so the constraint check is redundant at
 * approval time. The agent's job is to catch changes (new port
 * event, revised congestion factor, new vessel linked) that happen
 * AFTER the deal was last saved.
 *
 * Supports a single-deal targeted mode via `{ dealId }` for future
 * status-transition hooks (e.g. "synchronously port-check before
 * approval"). Batch mode when no input — used by the 05:00 cron.
 */

const OPEN_DEAL_STATUSES: DealStatus[] = [
  "negotiating",
  "approved",
  "in_transit",
];

export interface PortIntelligenceInput {
  /** Screen a single deal (for status-transition hooks). Omit for batch. */
  dealId?: string;
}

export class PortIntelligenceAgent implements IAgent {
  readonly name = "port_intelligence";
  readonly tier = "T1" as const;

  private readonly deals = new FuelDealRepository();
  private readonly vessels = new VesselRepository();
  private readonly ports = new PortRepository();
  private readonly signals = new SignalRepository();

  constructor(private readonly input: PortIntelligenceInput = {}) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const dealsToCheck = await this.loadScope(ctx);
    if (dealsToCheck.length === 0) {
      return {
        costUsd: 0,
        outputRefs: {
          deals_checked: 0,
          warnings_raised: 0,
          event_alerts: 0,
          scope: this.input.dealId ?? "batch",
        },
        proposedActions: [],
        internalWrites: 0,
      };
    }

    // Collect resolved port refs for every deal so pass-2 can fan the
    // active port_events without re-resolving.
    const dealPortRefs = new Map<
      string,
      { origin: Port | null; destination: Port | null; deal: FuelDeal }
    >();
    let warningsRaised = 0;
    let unresolvedCount = 0;
    let internalWrites = 0;

    // -----------------------------------------------------------------
    // Pass 1 — constraint check
    // -----------------------------------------------------------------
    for (const deal of dealsToCheck) {
      const originPort = await resolvePort(
        ctx,
        this.ports,
        deal.originPortId,
        deal.originPort,
      );
      const destPort = await resolvePort(
        ctx,
        this.ports,
        deal.destinationPortId,
        deal.destinationPort,
      );

      // Log unresolved text legs as audit events so admins can
      // backfill UNLOCODE matches later. Idempotent per run via
      // agentRunId suffix so a single pass writes at most one row
      // per (deal, leg).
      if (!originPort && deal.originPort) {
        await ctx.events.insertIfNotExists(ctx.tx, ctx.tenantId, {
          verb: "port.unresolved",
          subjectType: "fuel_deal",
          subjectId: deal.id,
          actorType: "system",
          actorId: this.name,
          occurredAt: new Date(),
          idempotencyKey: `port.unresolved:${deal.id}:origin:${ctx.agentRunId}`,
          metadata: { leg: "origin", text: deal.originPort },
        });
        unresolvedCount++;
        internalWrites++;
      }
      if (!destPort && deal.destinationPort) {
        await ctx.events.insertIfNotExists(ctx.tx, ctx.tenantId, {
          verb: "port.unresolved",
          subjectType: "fuel_deal",
          subjectId: deal.id,
          actorType: "system",
          actorId: this.name,
          occurredAt: new Date(),
          idempotencyKey: `port.unresolved:${deal.id}:destination:${ctx.agentRunId}`,
          metadata: { leg: "destination", text: deal.destinationPort },
        });
        unresolvedCount++;
        internalWrites++;
      }

      dealPortRefs.set(deal.id, {
        origin: originPort,
        destination: destPort,
        deal,
      });

      const vessel = deal.vesselId
        ? await this.vessels.findById(ctx.tx, deal.vesselId)
        : null;

      const warnings = validatePortConstraints({
        product: deal.product,
        coldChainRequired: deal.coldChainRequired ?? false,
        vessel: vessel ? toVesselSpec(vessel) : null,
        originPort: originPort ? toPortSpec(originPort) : null,
        destinationPort: destPort ? toPortSpec(destPort) : null,
      });

      for (const w of warnings) {
        // Figure out which leg the warning belongs to from its
        // affectedField suffix so the metadata points at the right
        // port row.
        const leg: "origin" | "destination" =
          w.affectedField.includes(".origin.") ? "origin" : "destination";
        const portForLeg = leg === "origin" ? originPort : destPort;
        await this.signals.fire(ctx.tx, ctx.tenantId, {
          ruleId: `port.${w.code.replace(/^port\./, "")}`,
          severity: mapSeverity(w.severity),
          subjectType: "fuel_deal",
          subjectId: deal.id,
          title: `${deal.dealRef}: ${w.message}`,
          metadata: {
            deal_id: deal.id,
            deal_ref: deal.dealRef,
            port_id: portForLeg?.id ?? null,
            vessel_id: vessel?.id ?? null,
            warning_code: w.code,
            severity: w.severity,
            leg,
            affected_field: w.affectedField,
          },
        });
        warningsRaised++;
        internalWrites++;
      }
    }

    // -----------------------------------------------------------------
    // Pass 2 — active port-event broadcast
    // -----------------------------------------------------------------
    let eventAlerts = 0;
    const activeEvents = await this.ports.listActiveEvents(ctx.tx);
    const alertingEvents = activeEvents.filter(
      (e) => e.severity === "warn" || e.severity === "critical",
    );

    for (const event of alertingEvents) {
      for (const refs of dealPortRefs.values()) {
        const touchedAs =
          refs.origin?.id === event.portId
            ? "origin"
            : refs.destination?.id === event.portId
              ? "destination"
              : null;
        if (!touchedAs) continue;
        const port =
          touchedAs === "origin" ? refs.origin! : refs.destination!;
        await this.signals.fire(ctx.tx, ctx.tenantId, {
          ruleId: `port.active_event.${event.eventType}`,
          severity: event.severity === "critical" ? "critical" : "warn",
          subjectType: "fuel_deal",
          subjectId: refs.deal.id,
          title: `${port.name}: ${event.title}`,
          body: event.body ?? null,
          metadata: {
            deal_id: refs.deal.id,
            deal_ref: refs.deal.dealRef,
            port_id: event.portId,
            port_event_id: event.id,
            event_type: event.eventType,
            touched_as: touchedAs,
          },
        });
        eventAlerts++;
        internalWrites++;
      }
    }

    return {
      costUsd: 0,
      outputRefs: {
        deals_checked: dealsToCheck.length,
        warnings_raised: warningsRaised,
        event_alerts: eventAlerts,
        unresolved_ports: unresolvedCount,
        scope: this.input.dealId ?? "batch",
      },
      proposedActions: [] as ProposedAction[],
      internalWrites,
      rationale:
        warningsRaised + eventAlerts > 0
          ? `${warningsRaised} constraint warnings + ${eventAlerts} event alerts across ${dealsToCheck.length} deals`
          : `${dealsToCheck.length} deals clean (${unresolvedCount} unresolved port texts)`,
    };
  }

  // -------------------------------------------------------------------------
  // Scoping
  // -------------------------------------------------------------------------

  private async loadScope(ctx: AgentContext): Promise<FuelDeal[]> {
    if (this.input.dealId) {
      const deal = await this.deals.findById(ctx.tx, this.input.dealId);
      return deal ? [deal] : [];
    }
    return ctx.tx
      .select()
      .from(schema.fuelDeals)
      .where(
        and(
          inArray(schema.fuelDeals.status, OPEN_DEAL_STATUSES),
        ),
      )
      .orderBy(desc(schema.fuelDeals.updatedAt))
      .limit(500);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a port from a deal's (id, legacy_text) pair. Prefers the
 * ULID FK; falls back to a UNLOCODE lookup when the legacy text
 * column holds a well-formed code (2 letter country + 3 alnum locode).
 * Returns null when neither path resolves.
 */
async function resolvePort(
  ctx: AgentContext,
  ports: PortRepository,
  portId: string | null,
  legacyText: string | null,
): Promise<Port | null> {
  if (portId) {
    const byId = await ports.findById(ctx.tx, portId);
    if (byId) return byId;
  }
  if (legacyText) {
    const trimmed = legacyText.trim().toUpperCase();
    if (/^[A-Z]{2}[A-Z0-9]{3}$/.test(trimmed)) {
      const byCode = await ports.findByUnlocode(ctx.tx, trimmed);
      if (byCode) return byCode;
    }
  }
  return null;
}

function toVesselSpec(v: Vessel): VesselSpec {
  const spec: VesselSpec = {
    class: v.vesselClass,
    dwtMt: v.dwtMt ?? 0,
    maxDraftM: v.maxDraftM ?? 0,
  };
  if (v.loaM !== null && v.loaM !== undefined) spec.loaM = v.loaM;
  if (v.beamM !== null && v.beamM !== undefined) spec.beamM = v.beamM;
  return spec;
}

function toPortSpec(p: Port): PortSpec {
  return {
    unlocode: p.unlocode,
    name: p.name,
    maxDraftM: p.maxDraftM,
    maxLoaM: p.maxLoaM,
    maxBeamM: p.maxBeamM,
    maxDwtMt: p.maxDwtMt,
    reeferCapable: p.reeferCapable,
    congestionFactor: p.congestionFactor ?? null,
    restrictedCargoNotes: p.restrictedCargoNotes,
  };
}

function mapSeverity(
  s: DealWarning["severity"],
): "info" | "warn" | "critical" {
  if (s === "critical") return "critical";
  if (s === "caution") return "warn";
  return "info";
}

// Silence the unused-import warning for PortEvent — it's re-exported
// for callers that want to narrow the result type of
// PortRepository.listActiveEvents without re-importing from @vex/db.
export type { PortEvent };
