import { and, desc, eq, inArray } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import {
  campaignEnrollments,
  type CampaignEnrollment,
} from "../schema/campaign-enrollments.js";

/**
 * Repository for campaign_enrollments. Writes honour the same
 * RLS-scoped pattern as the rest of the repositories. The Temporal
 * CampaignEnrollmentWorkflow (Sprint D) uses `advanceStep` +
 * `transitionState` to drive recipients through the plan; the API
 * uses `enroll` + `list` for the authoring/monitoring surface.
 */

export interface EnrollInput {
  id?: string;
  campaignId: string;
  contactId: string;
  currentStep?: number;
}

export type EnrollmentListFilter = {
  campaignId?: string;
  state?: string;
  limit?: number;
};

export class CampaignEnrollmentRepository {
  async findById(tx: Tx, id: string): Promise<CampaignEnrollment | null> {
    const [row] = await tx
      .select()
      .from(campaignEnrollments)
      .where(eq(campaignEnrollments.id, id))
      .limit(1);
    return row ?? null;
  }

  async findByContactAndCampaign(
    tx: Tx,
    campaignId: string,
    contactId: string,
  ): Promise<CampaignEnrollment | null> {
    const [row] = await tx
      .select()
      .from(campaignEnrollments)
      .where(
        and(
          eq(campaignEnrollments.campaignId, campaignId),
          eq(campaignEnrollments.contactId, contactId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async list(
    tx: Tx,
    filter: EnrollmentListFilter = {},
  ): Promise<CampaignEnrollment[]> {
    const conditions = [];
    if (filter.campaignId)
      conditions.push(eq(campaignEnrollments.campaignId, filter.campaignId));
    if (filter.state)
      conditions.push(eq(campaignEnrollments.state, filter.state));
    const q = tx.select().from(campaignEnrollments);
    const filtered = conditions.length ? q.where(and(...conditions)) : q;
    return filtered
      .orderBy(desc(campaignEnrollments.updatedAt))
      .limit(filter.limit ?? 100);
  }

  /**
   * Idempotent enrollment. If the contact is already enrolled in this
   * campaign, return the existing row unchanged — the caller can
   * inspect `state` to decide whether to reset it (Sprint D).
   */
  async enroll(
    tx: Tx,
    tenantId: string,
    input: EnrollInput,
  ): Promise<{
    enrollment: CampaignEnrollment;
    alreadyEnrolled: boolean;
  }> {
    const existing = await this.findByContactAndCampaign(
      tx,
      input.campaignId,
      input.contactId,
    );
    if (existing) return { enrollment: existing, alreadyEnrolled: true };

    const [row] = await tx
      .insert(campaignEnrollments)
      .values({
        id: input.id ?? createId(),
        tenantId,
        campaignId: input.campaignId,
        contactId: input.contactId,
        currentStep: input.currentStep ?? 0,
        state: "enrolled",
        branchHistoryJson: [],
      })
      .returning();
    if (!row) throw new Error("campaign_enrollments insert returned no row");
    return { enrollment: row, alreadyEnrolled: false };
  }

  async enrollBatch(
    tx: Tx,
    tenantId: string,
    campaignId: string,
    contactIds: string[],
  ): Promise<{ createdIds: string[]; existingCount: number }> {
    const createdIds: string[] = [];
    let existingCount = 0;
    for (const contactId of contactIds) {
      const result = await this.enroll(tx, tenantId, { campaignId, contactId });
      if (result.alreadyEnrolled) existingCount += 1;
      else createdIds.push(result.enrollment.id);
    }
    return { createdIds, existingCount };
  }

  /**
   * Advance to the next step and append a branch-history entry. Used
   * by the workflow after a step dispatch completes; the caller is
   * responsible for picking the next step number (may be `current + 1`
   * or a branch target).
   */
  async advanceStep(
    tx: Tx,
    id: string,
    nextStep: number,
    historyEntry: Record<string, unknown>,
  ): Promise<CampaignEnrollment | null> {
    const current = await this.findById(tx, id);
    if (!current) return null;
    const history = Array.isArray(current.branchHistoryJson)
      ? current.branchHistoryJson
      : [];
    const [row] = await tx
      .update(campaignEnrollments)
      .set({
        currentStep: nextStep,
        branchHistoryJson: [...history, historyEntry],
        lastEventAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(campaignEnrollments.id, id))
      .returning();
    return row ?? null;
  }

  async transitionState(
    tx: Tx,
    id: string,
    state: string,
    error?: string,
  ): Promise<CampaignEnrollment | null> {
    const [row] = await tx
      .update(campaignEnrollments)
      .set({
        state,
        ...(error !== undefined ? { error } : {}),
        lastEventAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(campaignEnrollments.id, id))
      .returning();
    return row ?? null;
  }

  async countByState(
    tx: Tx,
    campaignId: string,
  ): Promise<Record<string, number>> {
    const rows = await tx
      .select()
      .from(campaignEnrollments)
      .where(eq(campaignEnrollments.campaignId, campaignId));
    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.state] = (counts[row.state] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Sprint E — enrollments a single contact is currently participating
   * in across every campaign. The intent classifier uses this to know
   * which workflows to signal when a new inbound reply is labelled:
   * one contact may be in 3 different campaigns at once.
   *
   * Only `enrolled` + `paused` are returned; `completed`, `unsubscribed`,
   * and `errored` don't have a running workflow worth signalling.
   */
  async listActiveForContact(
    tx: Tx,
    contactId: string,
  ): Promise<CampaignEnrollment[]> {
    return tx
      .select()
      .from(campaignEnrollments)
      .where(
        and(
          eq(campaignEnrollments.contactId, contactId),
          inArray(campaignEnrollments.state, ["enrolled", "paused"]),
        ),
      );
  }

  async findActiveEnrollmentsForContacts(
    tx: Tx,
    campaignId: string,
    contactIds: string[],
  ): Promise<CampaignEnrollment[]> {
    if (contactIds.length === 0) return [];
    return tx
      .select()
      .from(campaignEnrollments)
      .where(
        and(
          eq(campaignEnrollments.campaignId, campaignId),
          inArray(campaignEnrollments.contactId, contactIds),
        ),
      );
  }
}
