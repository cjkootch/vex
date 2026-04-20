"use client";

import type { ComponentType } from "react";
import type { ManifestPanel, ManifestPanelType } from "@vex/ui";
import { FallbackPanel } from "./panels/fallback-panel";
import { ProfilePanel } from "./panels/profile-panel";
import { TablePanel } from "./panels/table-panel";
import { FilterableTablePanel } from "./panels/filterable-table-panel";
import { ApprovalFlowPanel } from "./panels/approval-flow-panel";
import { TimelinePanel } from "./panels/timeline-panel";
import { KpiRailPanel } from "./panels/kpi-rail-panel";
import { EvidencePanel } from "./panels/evidence-panel";
import { GraphPanel } from "./panels/graph-panel";
import { CampaignPanel } from "./panels/campaign-panel";
import { VoiceSessionPanel } from "./panels/voice-session-panel";
import { RouteMapPanel } from "./panels/route-map-panel";
import { DealScorecardPanel } from "./panels/deal-scorecard-panel";
import {
  ConfirmEntityPanel,
  DisambiguationPanel,
} from "../uncertainty/disambiguation-card";

/**
 * `PanelComponent<T>` — a React component for one specific panel type.
 * The discriminated union in `ManifestPanel` lets us extract the props for
 * each variant by `type` literal.
 */
export type PanelComponent<T extends ManifestPanelType> = ComponentType<
  Extract<ManifestPanel, { type: T }>
>;

/**
 * Component registry: typed map from manifest panel `type` to a React
 * component that renders it. `resolvePanel` returns `FallbackPanel` for
 * unknown types so the renderer can never crash on a new panel kind.
 */
class ComponentRegistry {
  private readonly map = new Map<ManifestPanelType, ComponentType<unknown>>();

  register<T extends ManifestPanelType>(type: T, component: PanelComponent<T>): void {
    this.map.set(type, component as ComponentType<unknown>);
  }

  resolve(type: ManifestPanelType): ComponentType<unknown> {
    return this.map.get(type) ?? (FallbackPanel as ComponentType<unknown>);
  }
}

export const registry = new ComponentRegistry();

registry.register("profile", ProfilePanel);
registry.register("table", TablePanel);
registry.register("filterable_table", FilterableTablePanel);
registry.register("approval_flow", ApprovalFlowPanel);
registry.register("timeline", TimelinePanel);
registry.register("kpi_rail", KpiRailPanel);
registry.register("evidence", EvidencePanel);
registry.register("graph", GraphPanel);
registry.register("campaign", CampaignPanel);
registry.register("voice_session", VoiceSessionPanel);
registry.register("disambiguation", DisambiguationPanel);
registry.register("confirm_entity", ConfirmEntityPanel);
registry.register("route_map", RouteMapPanel);
registry.register("deal_scorecard", DealScorecardPanel);
// Signal panel: ManifestCanvas handles the side effect (setMode + toast);
// the registry entry just prevents FallbackPanel from showing stray JSON.
registry.register("workspace_mode_switch", () => null);

export function resolvePanel(type: ManifestPanelType): ComponentType<unknown> {
  return registry.resolve(type);
}

export { FallbackPanel };
