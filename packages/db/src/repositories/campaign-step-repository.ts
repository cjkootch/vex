import { and, asc, eq } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import {
  campaignSteps,
  type CampaignStep,
} from "../schema/campaign-steps.js";

/**
 * Repository for campaign plan steps. Mutations take `tenantId`
 * explicitly because the RLS `WITH CHECK` constraint requires the
 * column on insert; reads rely on RLS to filter. The Temporal
 * CampaignEnrollmentWorkflow (Sprint D) fetches an ordered list per
 * campaign via `listByCampaign` — the `(tenant_id, campaign_id,
 * position)` unique index keeps positions contiguous.
 */

export interface CampaignStepCreateInput {
  id?: string;
  campaignId: string;
  position: number;
  channel: string;
  delayAfterPriorMs?: number;
  templateRef?: string | null;
  gateConditionJson?: Record<string, unknown>;
  tier?: string;
  autoApprove?: boolean;
}

export interface CampaignStepUpdatePatch {
  channel?: string;
  delayAfterPriorMs?: number;
  templateRef?: string | null;
  gateConditionJson?: Record<string, unknown>;
  tier?: string;
  autoApprove?: boolean;
  position?: number;
}

export class CampaignStepRepository {
  async findById(tx: Tx, id: string): Promise<CampaignStep | null> {
    const [row] = await tx
      .select()
      .from(campaignSteps)
      .where(eq(campaignSteps.id, id))
      .limit(1);
    return row ?? null;
  }

  /** All steps for a campaign, ordered by position ascending. */
  async listByCampaign(
    tx: Tx,
    campaignId: string,
  ): Promise<CampaignStep[]> {
    return tx
      .select()
      .from(campaignSteps)
      .where(eq(campaignSteps.campaignId, campaignId))
      .orderBy(asc(campaignSteps.position));
  }

  async create(
    tx: Tx,
    tenantId: string,
    data: CampaignStepCreateInput,
  ): Promise<CampaignStep> {
    const [row] = await tx
      .insert(campaignSteps)
      .values({
        id: data.id ?? createId(),
        tenantId,
        campaignId: data.campaignId,
        position: data.position,
        channel: data.channel,
        delayAfterPriorMs: data.delayAfterPriorMs ?? 0,
        templateRef: data.templateRef ?? null,
        gateConditionJson: data.gateConditionJson ?? {},
        tier: data.tier ?? "T2",
        autoApprove: data.autoApprove ?? false,
      })
      .returning();
    if (!row) throw new Error("campaign_steps insert returned no row");
    return row;
  }

  async update(
    tx: Tx,
    id: string,
    patch: CampaignStepUpdatePatch,
  ): Promise<CampaignStep | null> {
    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.channel !== undefined) values["channel"] = patch.channel;
    if (patch.delayAfterPriorMs !== undefined)
      values["delayAfterPriorMs"] = patch.delayAfterPriorMs;
    if (patch.templateRef !== undefined)
      values["templateRef"] = patch.templateRef;
    if (patch.gateConditionJson !== undefined)
      values["gateConditionJson"] = patch.gateConditionJson;
    if (patch.tier !== undefined) values["tier"] = patch.tier;
    if (patch.autoApprove !== undefined)
      values["autoApprove"] = patch.autoApprove;
    if (patch.position !== undefined) values["position"] = patch.position;

    const [row] = await tx
      .update(campaignSteps)
      .set(values)
      .where(eq(campaignSteps.id, id))
      .returning();
    return row ?? null;
  }

  async delete(tx: Tx, id: string): Promise<void> {
    await tx.delete(campaignSteps).where(eq(campaignSteps.id, id));
  }

  /**
   * Validate a step sequence for a campaign:
   *   - positions start at 0
   *   - positions are contiguous (no gaps)
   *   - no duplicate positions
   *
   * Returns `null` when the sequence is valid, otherwise a
   * human-readable reason. Callers use this before marking a
   * campaign ready-to-enroll; the DB uniqueness index already blocks
   * duplicates, so this mostly catches gaps the editor might leave.
   */
  async validateSequence(
    tx: Tx,
    campaignId: string,
  ): Promise<string | null> {
    const steps = await this.listByCampaign(tx, campaignId);
    if (steps.length === 0) return "plan has no steps";
    for (let i = 0; i < steps.length; i++) {
      if (steps[i]!.position !== i) {
        return `position gap at step ${i} (got ${steps[i]!.position})`;
      }
    }
    return null;
  }

  /**
   * Atomically re-number steps based on an ordered id list. Used by
   * the editor after drag-to-reorder. Under the same tx so the
   * unique-position constraint never transiently fires — we push all
   * to negative indices first, then to the real positions.
   */
  async reorder(
    tx: Tx,
    campaignId: string,
    orderedIds: string[],
  ): Promise<void> {
    // Phase 1: shuffle to negative space so the unique index is
    // never violated mid-write.
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(campaignSteps)
        .set({ position: -1 - i, updatedAt: new Date() })
        .where(
          and(
            eq(campaignSteps.id, orderedIds[i]!),
            eq(campaignSteps.campaignId, campaignId),
          ),
        );
    }
    // Phase 2: assign real positions.
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(campaignSteps)
        .set({ position: i, updatedAt: new Date() })
        .where(
          and(
            eq(campaignSteps.id, orderedIds[i]!),
            eq(campaignSteps.campaignId, campaignId),
          ),
        );
    }
  }
}
