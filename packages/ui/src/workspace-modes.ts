import { z } from "zod";

/**
 * Workspace modes — the user-visible "what am I doing right now?" state.
 *
 * Drives three things:
 *   - the default panel set the canvas pre-loads
 *   - the chat input placeholder text
 *   - the ContextChip's initial status tint
 *
 * Morning brief, approval review, and global are always reachable;
 * deal-war-room, buyer-intelligence, and marketing-performance are
 * scoped to a specific entity via contextId.
 *
 * Note: WorkspaceModeSwitchPanel (defined at the bottom of this file) is
 * a new panel shape intended for the ViewManifest discriminated union.
 * Integrating it into `ManifestPanel` in view-manifest.ts is a separate
 * turn — this file only exports the schema + inferred type.
 */

// ---------------------------------------------------------------------------
// WorkspaceMode enum — const object pattern matches the rest of @vex/domain.
// ---------------------------------------------------------------------------

export const WorkspaceMode = {
  MorningBrief: "morning_brief",
  DealWarRoom: "deal_war_room",
  BuyerIntelligence: "buyer_intelligence",
  MarketingPerformance: "marketing_performance",
  ApprovalReview: "approval_review",
  Global: "global",
} as const;
export type WorkspaceMode = (typeof WorkspaceMode)[keyof typeof WorkspaceMode];

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

export type WorkspaceContextType = "deal" | "organization" | "global" | "queue";
export type WorkspaceChipStatus = "active" | "warning" | "critical";

export interface WorkspaceModeConfig {
  mode: WorkspaceMode;
  /** Human label shown in the mode switcher. */
  label: string;
  /** One-line description shown under the label. */
  description: string;
  /** Which context the mode is scoped to. */
  contextType: WorkspaceContextType;
  /** Present when contextType is "deal" or "organization". */
  contextId?: string;
  /** Panel `type` strings the canvas pre-loads when the mode activates. */
  defaultPanels: string[];
  /** Hint text shown in the chat input. */
  conversationPlaceholder: string;
  /** Initial ContextChip status. */
  chipStatus: WorkspaceChipStatus;
}

// ---------------------------------------------------------------------------
// Defaults — one config per mode. Panel `type` strings must match the
// ManifestPanel discriminants in view-manifest.ts.
// ---------------------------------------------------------------------------

export const WORKSPACE_MODE_CONFIGS: Record<WorkspaceMode, WorkspaceModeConfig> = {
  [WorkspaceMode.MorningBrief]: {
    mode: WorkspaceMode.MorningBrief,
    label: "Morning Brief",
    description: "What needs your attention today.",
    contextType: "global",
    defaultPanels: ["kpi_rail", "timeline"],
    conversationPlaceholder: "Ask about today's priorities...",
    chipStatus: "active",
  },
  [WorkspaceMode.DealWarRoom]: {
    mode: WorkspaceMode.DealWarRoom,
    label: "Deal War Room",
    description: "Focused on a single deal.",
    contextType: "deal",
    defaultPanels: [
      "deal_scorecard",
      "deal_cost_waterfall",
      "deal_compliance",
      "deal_cashflow",
    ],
    conversationPlaceholder: "Ask about this deal...",
    chipStatus: "active",
  },
  [WorkspaceMode.BuyerIntelligence]: {
    mode: WorkspaceMode.BuyerIntelligence,
    label: "Buyer Intelligence",
    description: "Counterparty profile, history, risk tier.",
    contextType: "organization",
    defaultPanels: ["profile", "timeline", "evidence"],
    conversationPlaceholder: "Ask about this buyer...",
    chipStatus: "active",
  },
  [WorkspaceMode.MarketingPerformance]: {
    mode: WorkspaceMode.MarketingPerformance,
    label: "Marketing Performance",
    description: "Campaigns, channels, and attribution.",
    contextType: "global",
    defaultPanels: ["kpi_rail", "campaign"],
    conversationPlaceholder: "Ask about campaigns or spend...",
    chipStatus: "active",
  },
  [WorkspaceMode.ApprovalReview]: {
    mode: WorkspaceMode.ApprovalReview,
    label: "Approval Review",
    description: "Pending approvals queued for your decision.",
    contextType: "queue",
    defaultPanels: ["table"],
    conversationPlaceholder: "Approve, reject, or ask why...",
    chipStatus: "warning",
  },
  [WorkspaceMode.Global]: {
    mode: WorkspaceMode.Global,
    label: "Workspace",
    description: "General-purpose chat across the workspace.",
    contextType: "global",
    defaultPanels: [],
    conversationPlaceholder: "Ask anything — deals, contacts, campaigns...",
    chipStatus: "active",
  },
};

// ---------------------------------------------------------------------------
// WorkspaceModeSwitchPanel — manifest panel shape. Adding this into
// ManifestPanel's discriminatedUnion happens in a separate turn.
// ---------------------------------------------------------------------------

// Cast through [string, ...string[]] because z.enum requires a non-empty
// readonly tuple; Object.values widens to `string[]`. The runtime values
// are still the exact WorkspaceMode strings.
const WORKSPACE_MODE_VALUES = Object.values(WorkspaceMode) as [
  string,
  ...string[],
];

export const WorkspaceModeSwitchPanel = z.object({
  type: z.literal("workspace_mode_switch"),
  mode: z.enum(WORKSPACE_MODE_VALUES),
  contextId: z.string().optional(),
  contextLabel: z.string().optional(),
  /**
   * Human-readable reason for the switch, e.g. "You asked about a deal".
   * Shown briefly by the shell then dismissed — not a persistent label.
   */
  reason: z.string().optional(),
});
export type WorkspaceModeSwitchPanel = z.infer<typeof WorkspaceModeSwitchPanel>;
