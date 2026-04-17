"use client";

import type { ComponentType } from "react";
import type { ManifestPanel, ManifestPanelType } from "@vex/ui";
import { FallbackPanel } from "./panels/fallback-panel";
import { ProfilePanel } from "./panels/profile-panel";
import { TablePanel } from "./panels/table-panel";
import { TimelinePanel } from "./panels/timeline-panel";
import { KpiRailPanel } from "./panels/kpi-rail-panel";
import { EvidencePanel } from "./panels/evidence-panel";
import { GraphPanel } from "./panels/graph-panel";
import { CampaignPanel } from "./panels/campaign-panel";
import { VoiceSessionPanel } from "./panels/voice-session-panel";

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
registry.register("timeline", TimelinePanel);
registry.register("kpi_rail", KpiRailPanel);
registry.register("evidence", EvidencePanel);
registry.register("graph", GraphPanel);
registry.register("campaign", CampaignPanel);
registry.register("voice_session", VoiceSessionPanel);

export function resolvePanel(type: ManifestPanelType): ComponentType<unknown> {
  return registry.resolve(type);
}

export { FallbackPanel };
