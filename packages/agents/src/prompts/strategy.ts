import type { WorkspaceStrategy } from "@vex/db";

/**
 * Renders the operator-authored company strategy as a compact
 * markdown preamble for the chat system prompt. Every chat call
 * prepends this block so Vex reasons inside the tenant's
 * framing — who they sell to, how they talk, what they won't
 * touch, what they're trying to win this quarter.
 *
 * Returns an empty string for a brand-new workspace with no
 * strategy on file; the caller just concatenates without guards.
 *
 * Design notes:
 *   - No headers beyond `## Company context (apply to every
 *     answer)` — don't waste tokens on formatting.
 *   - Skip any field the operator left empty. An operator who
 *     hasn't filled `brand_voice` shouldn't see a blank "Brand
 *     voice: " line; it should just disappear.
 *   - Array fields join with a Oxford-comma list. Bullet lists
 *     use fewer tokens than newline-separated bullets.
 *   - `updated_at` is not rendered — Vex doesn't need it.
 */
export function renderStrategyPreamble(strategy: WorkspaceStrategy | null | undefined): string {
  if (!strategy) return "";
  const s = strategy;
  const parts: string[] = [];

  if (s.mission && s.mission.trim()) parts.push(`Mission: ${s.mission.trim()}`);
  if (s.target_markets && s.target_markets.length > 0) {
    parts.push(`Target markets: ${joinList(s.target_markets)}.`);
  }
  if (s.icp_buyers && s.icp_buyers.trim()) {
    parts.push(`ICP buyers: ${s.icp_buyers.trim()}`);
  }
  if (s.icp_suppliers && s.icp_suppliers.trim()) {
    parts.push(`ICP suppliers: ${s.icp_suppliers.trim()}`);
  }
  if (s.brand_voice && s.brand_voice.trim()) {
    parts.push(`Brand voice: ${s.brand_voice.trim()}`);
  }
  if (s.pricing_philosophy && s.pricing_philosophy.trim()) {
    parts.push(`Pricing philosophy: ${s.pricing_philosophy.trim()}`);
  }
  if (s.no_go_zones && s.no_go_zones.length > 0) {
    parts.push(
      `No-go zones (never propose actions that touch these): ${joinList(s.no_go_zones)}.`,
    );
  }
  if (s.growth_priorities && s.growth_priorities.length > 0) {
    parts.push(
      `Growth priorities this quarter (bias proposals toward these): ${joinList(
        s.growth_priorities,
      )}.`,
    );
  }
  if (s.additional_guidance && s.additional_guidance.trim()) {
    parts.push(`Additional guidance: ${s.additional_guidance.trim()}`);
  }

  if (parts.length === 0) return "";

  return [
    "## Company context (apply to every answer, email draft, and proposed action)",
    "",
    parts.join("\n\n"),
    "",
    "---",
    "",
    "",
  ].join("\n");
}

/** Human-friendly Oxford-comma list: [a, b] → "a and b"; [a, b, c] → "a, b, and c". */
function joinList(items: readonly string[]): string {
  const cleaned = items.map((s) => s.trim()).filter((s) => s.length > 0);
  if (cleaned.length === 0) return "";
  if (cleaned.length === 1) return cleaned[0]!;
  if (cleaned.length === 2) return `${cleaned[0]} and ${cleaned[1]}`;
  return `${cleaned.slice(0, -1).join(", ")}, and ${cleaned[cleaned.length - 1]}`;
}
