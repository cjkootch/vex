import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import {
  withTenant,
  type Db,
  type EventRepository,
  type FuelDealRepository,
  type WorkspaceRepository,
  type WorkspaceStrategy,
} from "@vex/db";
import { TenantId } from "@vex/domain";
import type { AnthropicAdapter } from "@vex/integrations";
import {
  STRATEGY_DRAFT_SYSTEM_PROMPT,
  buildStrategyDraftUserMessage,
  parseStrategyDraft,
  type StrategyDraftEvidence,
  type StrategySlot,
} from "@vex/agents";
import {
  STRATEGY_ANTHROPIC,
  STRATEGY_DB_CLIENT,
  STRATEGY_DEALS_REPO,
  STRATEGY_EVENTS_REPO,
  STRATEGY_WORKSPACES_REPO,
} from "./tokens.js";

/**
 * Sprint S — workspace-level strategy service.
 *
 * Strategy lives on `workspaces.strategy` (JSONB). Reads are direct via
 * WorkspaceRepository (workspace lookups intentionally run OUTSIDE
 * `withTenant` because the tenant id IS the workspace id).
 *
 * Writes additionally emit a `strategy.updated` audit event INSIDE
 * withTenant so it's RLS-scoped and the /app/signals feed surfaces the
 * edit. The strategy JSON is stamped with updated_at + updated_by by
 * the repository.
 */
@Injectable()
export class StrategyService {
  constructor(
    @Inject(STRATEGY_DB_CLIENT) private readonly db: Db,
    @Inject(STRATEGY_WORKSPACES_REPO)
    private readonly workspaces: WorkspaceRepository,
    @Inject(STRATEGY_EVENTS_REPO) private readonly events: EventRepository,
    @Inject(STRATEGY_DEALS_REPO) private readonly deals: FuelDealRepository,
    @Inject(STRATEGY_ANTHROPIC) private readonly anthropic: AnthropicAdapter,
  ) {}

  async getStrategy(workspaceId: string): Promise<WorkspaceStrategy> {
    return this.workspaces.getStrategy(this.db, workspaceId);
  }

  /**
   * Overwrite the entire strategy blob. No field-level merge — operators
   * save the full form, which is what they edited. `updatedBy` is the
   * user id extracted from the JWT by the controller.
   */
  async updateStrategy(
    workspaceId: string,
    strategy: WorkspaceStrategy,
    updatedBy: string,
  ): Promise<WorkspaceStrategy> {
    const row = await this.workspaces.updateStrategy(
      this.db,
      workspaceId,
      strategy,
      updatedBy,
    );

    await withTenant(this.db, workspaceId, async (tx) => {
      await this.events.insertIfNotExists(tx, workspaceId, {
        verb: "strategy.updated",
        subjectType: "workspace",
        subjectId: workspaceId,
        actorType: "user",
        actorId: updatedBy,
        objectType: "workspace",
        objectId: workspaceId,
        occurredAt: new Date(),
        idempotencyKey: `strategy.updated:${workspaceId}:${row.strategy.updated_at ?? Date.now()}`,
        metadata: {
          updated_by: updatedBy,
          fields_populated: describePopulatedFields(row.strategy),
        },
      });
    });

    return row.strategy;
  }

  /**
   * Sprint S.1 — "Help me write this" per-slot drafter. Pulls a small
   * evidence snapshot (counterparty mix, recent product + destination
   * patterns, active deal count), feeds it to Claude with the
   * slot-specific guidance, returns the parsed draft. Text slots
   * return a string; list slots return a string[].
   *
   * The drafter NEVER writes to the strategy row. It only returns a
   * suggestion — the operator reviews and decides whether to accept.
   * This is deliberate: strategy is authoritative context, and Vex
   * auto-committing to it would quietly change every downstream
   * prompt without a human in the loop.
   */
  async draftSlot(
    workspaceId: string,
    slot: StrategySlot,
    hints: string | null,
    idempotencyKey: string,
  ): Promise<{ draft: string | string[] } | { error: string }> {
    const evidence = await this.gatherDraftEvidence(workspaceId);
    const existing = await this.workspaces.getStrategy(this.db, workspaceId);

    const result = await this.anthropic.complete({
      tenantId: TenantId(workspaceId),
      idempotencyKey,
      system: STRATEGY_DRAFT_SYSTEM_PROMPT,
      maxTokens: 700,
      messages: [
        {
          role: "user",
          content: buildStrategyDraftUserMessage(slot, evidence, existing, hints),
        },
      ],
    });

    const raw = result.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    const parsed = parseStrategyDraft(slot, raw);
    if (!parsed.ok) return { error: `draft_parse_failed:${parsed.reason}` };
    return { draft: parsed.draft };
  }

  /**
   * Build the minimal evidence block the drafter grounds in.
   * Everything here is one SELECT scoped under `withTenant` so RLS
   * filters to the caller's workspace.
   */
  private async gatherDraftEvidence(
    workspaceId: string,
  ): Promise<StrategyDraftEvidence> {
    return withTenant(this.db, workspaceId, async (tx) => {
      const orgCounts = await tx.execute(sql`
        SELECT kind, COUNT(*)::int AS c
        FROM organizations
        WHERE kind IS NOT NULL
        GROUP BY kind
      `);
      const org_counts = {
        buyer: 0,
        supplier: 0,
        broker: 0,
        buyer_broker: 0,
        internal: 0,
        competitor: 0,
      };
      for (const row of (orgCounts.rows ?? []) as Array<{ kind: string; c: number }>) {
        if (row.kind in org_counts) {
          (org_counts as Record<string, number>)[row.kind] = Number(row.c) || 0;
        }
      }

      const activeRows = await this.deals.findByStatus(tx, [
        "negotiating",
        "pending_approval",
        "approved",
        "loading",
        "in_transit",
        "delivered",
      ]);
      const active_deal_count = activeRows.length;

      const recentDeals = await this.deals.listRecent(tx, 100);

      const productCounts = new Map<string, number>();
      for (const d of recentDeals) {
        productCounts.set(d.product, (productCounts.get(d.product) ?? 0) + 1);
      }
      const top_products = Array.from(productCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([product, deal_count]) => ({ product, deal_count }));

      const seenDestinations = new Set<string>();
      const recent_destinations: string[] = [];
      for (const d of recentDeals) {
        if (!d.destinationPort) continue;
        if (seenDestinations.has(d.destinationPort)) continue;
        seenDestinations.add(d.destinationPort);
        recent_destinations.push(d.destinationPort);
        if (recent_destinations.length >= 10) break;
      }

      return {
        org_counts,
        top_products,
        active_deal_count,
        recent_destinations,
      };
    });
  }
}

function describePopulatedFields(s: WorkspaceStrategy): string[] {
  const populated: string[] = [];
  if (s.mission?.trim()) populated.push("mission");
  if (s.target_markets?.length) populated.push("target_markets");
  if (s.icp_buyers?.trim()) populated.push("icp_buyers");
  if (s.icp_suppliers?.trim()) populated.push("icp_suppliers");
  if (s.brand_voice?.trim()) populated.push("brand_voice");
  if (s.pricing_philosophy?.trim()) populated.push("pricing_philosophy");
  if (s.no_go_zones?.length) populated.push("no_go_zones");
  if (s.growth_priorities?.length) populated.push("growth_priorities");
  if (s.additional_guidance?.trim()) populated.push("additional_guidance");
  return populated;
}
