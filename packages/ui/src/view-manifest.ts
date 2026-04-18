import { z } from "zod";
import { WorkspaceModeSwitchPanel } from "./workspace-modes.js";

/**
 * The ViewManifest is Vex's canonical model output.
 *
 * Invariants:
 *   - The model never returns HTML — only this typed JSON.
 *   - {@link validateManifest} runs before any component renders. On failure
 *     the renderer falls back to {@link manifestFallback} and a telemetry
 *     event is raised.
 *   - Each panel is shaped for one specific Vex affordance; the model picks
 *     the simplest panel set that answers the question.
 */

const ProfilePanel = z.object({
  type: z.literal("profile"),
  objectType: z.string().min(1),
  objectId: z.string().min(1),
  fields: z.record(z.string()),
});

const TablePanel = z.object({
  type: z.literal("table"),
  title: z.string().min(1),
  columns: z.array(z.string()).min(1),
  rows: z.array(z.record(z.string())),
});

const TimelinePanel = z.object({
  type: z.literal("timeline"),
  title: z.string().min(1),
  events: z.array(
    z.object({
      occurred_at: z.string(),
      verb: z.string(),
      summary: z.string(),
      source: z.string(),
    }),
  ),
});

const KpiRailPanel = z.object({
  type: z.literal("kpi_rail"),
  metrics: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
        unit: z.string().optional(),
        delta: z.string().optional(),
        trend: z.enum(["up", "down", "flat"]).optional(),
      }),
    )
    .min(1),
});

const EvidencePanel = z.object({
  type: z.literal("evidence"),
  items: z.array(
    z.object({
      chunk_id: z.string(),
      source_ref: z.string(),
      occurred_at: z.string().nullable(),
      freshness_hours: z.number(),
      confidence_score: z.number().min(0).max(1),
    }),
  ),
});

const GraphPanel = z.object({
  type: z.literal("graph"),
  nodes: z.array(
    z.object({ id: z.string(), label: z.string(), objectType: z.string() }),
  ),
  edges: z.array(
    z.object({ source: z.string(), target: z.string(), label: z.string().optional() }),
  ),
});

const CampaignPanel = z.object({
  type: z.literal("campaign"),
  campaignId: z.string(),
  sent: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  clicked: z.number().int().nonnegative(),
  opened: z.number().int().nonnegative(),
  bounced: z.number().int().nonnegative(),
  click_rate: z.number().min(0).max(1),
  open_rate: z.number().min(0).max(1),
  /** Resend's open_rate is image-pixel based — always weak, never strong. */
  open_confidence: z.literal("weak"),
});

const VoiceSessionPanel = z.object({
  type: z.literal("voice_session"),
  sessionId: z.string().min(1),
  durationSeconds: z.number().int().nonnegative(),
  status: z.enum(["processing", "processed"]),
  summary: z.string(),
  actionItemsCount: z.number().int().nonnegative(),
  activityId: z.string().optional(),
});

const DisambiguationOption = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  sublabel: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

const DisambiguationPanel = z.object({
  type: z.literal("disambiguation"),
  question: z.string().min(1),
  options: z.array(DisambiguationOption).min(2).max(4),
});

const ConfirmEntityPanel = z.object({
  type: z.literal("confirm_entity"),
  entity: z.string().min(1),
  entityId: z.string().min(1),
  sublabel: z.string().optional(),
});

const RoutePoint = z.object({
  label: z.string().min(1),
  /** WGS84 latitude, -90..90 (positive = north). */
  lat: z.number().min(-90).max(90),
  /** WGS84 longitude, -180..180 (positive = east). */
  lon: z.number().min(-180).max(180),
});

const RouteMapPanel = z.object({
  type: z.literal("route_map"),
  title: z.string().optional(),
  origin: RoutePoint,
  destination: RoutePoint,
  /** Optional deal context — renders alongside the map. */
  deal: z
    .object({
      ref: z.string().optional(),
      product: z.string().optional(),
      volume: z.string().optional(),
      status: z.string().optional(),
      laycan: z.string().optional(),
    })
    .optional(),
});

/**
 * Single-deal scorecard — surfaces the calculator outputs (EBITDA,
 * margin, score, recommendation) plus compliance flags. Used when
 * the user asks about a specific deal's economics so the answer
 * isn't buried in a generic table row.
 */
const DealScorecardPanel = z.object({
  type: z.literal("deal_scorecard"),
  dealRef: z.string().min(1),
  product: z.string().optional(),
  status: z.string().optional(),
  buyer: z.string().optional(),
  lane: z.string().optional(),
  volumeUsg: z.string().optional(),
  metrics: z
    .array(
      z.object({
        label: z.string().min(1),
        value: z.string().min(1),
        tone: z.enum(["good", "warn", "bad", "neutral"]).optional(),
      }),
    )
    .min(1),
  recommendation: z.string().optional(),
  flags: z.array(z.string()).optional(),
});

/**
 * Agent status panel — per-agent operational health card. One row per
 * known agent, showing last run status, timestamp, cost, error (if any),
 * and a one-line rationale pulled from the run's outputRefs. Driven by
 * `retrieval.fetchAgentStatus` which projects agent_runs into the
 * evidence pack when the user asks about agents.
 */
const AgentStatusPanel = z.object({
  type: z.literal("agent_status"),
  title: z.string().min(1).optional(),
  rows: z
    .array(
      z.object({
        agentName: z.string().min(1),
        status: z.enum([
          "pending",
          "running",
          "completed",
          "failed",
          "skipped",
        ]),
        /** ISO 8601 timestamp of the last run's finishedAt / startedAt. */
        lastRun: z.string().nullable(),
        costUsd: z.number().nonnegative(),
        error: z.string().nullable().optional(),
        summary: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

export const ManifestPanel = z.discriminatedUnion("type", [
  ProfilePanel,
  TablePanel,
  TimelinePanel,
  KpiRailPanel,
  EvidencePanel,
  GraphPanel,
  CampaignPanel,
  VoiceSessionPanel,
  DisambiguationPanel,
  ConfirmEntityPanel,
  RouteMapPanel,
  DealScorecardPanel,
  AgentStatusPanel,
  // Signal-only panel: ManifestCanvas intercepts it to switch workspace
  // mode and show a toast, never renders a concrete component.
  WorkspaceModeSwitchPanel,
]);
export type ManifestPanel = z.infer<typeof ManifestPanel>;

export type ManifestPanelType = ManifestPanel["type"];

export const ViewManifest = z.object({
  panels: z.array(ManifestPanel),
});
export type ViewManifest = z.infer<typeof ViewManifest>;

/** Validation result. Always carries a usable manifest (`fallback` on error). */
export type ManifestValidationResult =
  | { success: true; manifest: ViewManifest }
  | { success: false; error: string; fallback: ViewManifest };

/**
 * Run the ManifestValidator. If `raw` is malformed, returns `success: false`
 * with a single-table fallback so the renderer always has something to draw.
 * Never throws.
 */
export function validateManifest(raw: unknown): ManifestValidationResult {
  const result = ViewManifest.safeParse(raw);
  if (result.success) return { success: true, manifest: result.data };
  return {
    success: false,
    error: result.error.message,
    fallback: manifestFallback(
      "Sorry — the model returned a response Vex couldn't render. The raw answer is preserved below.",
    ),
  };
}

/**
 * Build a guaranteed-renderable manifest from a single text payload. Used as
 * the fallback when validation fails and as a last-resort renderer when the
 * model produces nothing useful.
 */
export function manifestFallback(text: string): ViewManifest {
  return {
    panels: [
      { type: "table", title: "Answer", columns: ["text"], rows: [{ text }] },
    ],
  };
}
