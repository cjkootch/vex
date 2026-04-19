import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import type { CampaignStatus } from "@vex/domain";
import type { Client as TemporalClient } from "@temporalio/client";
import type {
  ApprovalRepository,
  CampaignEnrollmentRepository,
  CampaignRepository,
  CampaignStepRepository,
  CampaignWithRollups,
  EventRepository,
  TouchpointRepository,
} from "@vex/db";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";
import { withTenant, type Db } from "@vex/db";

/**
 * GET /marketing/campaigns
 *   List campaigns for the current tenant with rollup counters
 *   (touchpointCount + sent/delivered/opened/clicked/bounced derived
 *   from touchpoints.channel). Optional `?status=` filter, `?limit=N`
 *   capped at 500.
 *
 * GET /marketing/campaigns/:id
 *   Single-campaign detail with the same rollups + the last 50
 *   touchpoints (newest-first).
 *
 * Both endpoints run inside `withTenant` so RLS isolates the query.
 */

export const MARKETING_DB_CLIENT = Symbol("MARKETING_DB_CLIENT");
export const MARKETING_CAMPAIGNS_REPO = Symbol("MARKETING_CAMPAIGNS_REPO");
export const MARKETING_TOUCHPOINTS_REPO = Symbol("MARKETING_TOUCHPOINTS_REPO");
export const MARKETING_STEPS_REPO = Symbol("MARKETING_STEPS_REPO");
export const MARKETING_ENROLLMENTS_REPO = Symbol("MARKETING_ENROLLMENTS_REPO");
export const MARKETING_TEMPORAL_CLIENT = Symbol("MARKETING_TEMPORAL_CLIENT");
export const MARKETING_APPROVALS_REPO = Symbol("MARKETING_APPROVALS_REPO");
export const MARKETING_EVENTS_REPO = Symbol("MARKETING_EVENTS_REPO");

const CAMPAIGN_STATUSES = new Set<CampaignStatus>([
  "active",
  "paused",
  "completed",
  "archived",
]);

export interface CampaignListRow {
  id: string;
  channel: string;
  source: string | null;
  medium: string | null;
  accountRef: string | null;
  spend: number | null;
  objective: string | null;
  status: string;
  touchpointCount: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignTouchpointRow {
  id: string;
  channel: string;
  actor: string | null;
  occurredAt: string;
  contactId: string | null;
  orgId: string | null;
  leadId: string | null;
  campaignId: string | null;
  metadata: Record<string, unknown>;
}

export interface CampaignDetail extends CampaignListRow {
  touchpoints: CampaignTouchpointRow[];
}

export interface CampaignStepRow {
  id: string;
  campaignId: string;
  position: number;
  channel: string;
  delayAfterPriorMs: number;
  templateRef: string | null;
  gateConditionJson: Record<string, unknown>;
  tier: string;
  autoApprove: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignEnrollmentRow {
  id: string;
  campaignId: string;
  contactId: string;
  currentStep: number;
  state: string;
  lastEventAt: string | null;
  branchHistoryJson: Array<Record<string, unknown>>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const CAMPAIGN_CHANNELS = new Set([
  "email",
  "sms",
  "whatsapp",
  "voice",
  "manual",
]);
const APPROVAL_TIERS = new Set(["T0", "T1", "T2", "T3"]);

const CreateStepBody = z.object({
  position: z.number().int().nonnegative(),
  channel: z.string().refine((s) => CAMPAIGN_CHANNELS.has(s), {
    message: "channel must be email|sms|whatsapp|voice|manual",
  }),
  delayAfterPriorMs: z.number().int().nonnegative().optional(),
  templateRef: z.string().min(1).max(500).nullable().optional(),
  gateConditionJson: z.record(z.unknown()).optional(),
  tier: z
    .string()
    .refine((s) => APPROVAL_TIERS.has(s), {
      message: "tier must be T0|T1|T2|T3",
    })
    .optional(),
  autoApprove: z.boolean().optional(),
});

const UpdateStepBody = CreateStepBody.partial().extend({
  position: z.number().int().nonnegative().optional(),
});

const EnrollBody = z.object({
  contactIds: z.array(z.string().min(1)).min(1).max(500),
});

@Controller("marketing")
@UseGuards(JwtAuthGuard)
export class MarketingController {
  private readonly log = new Logger(MarketingController.name);

  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(MARKETING_DB_CLIENT) private readonly db: Db,
    @Inject(MARKETING_CAMPAIGNS_REPO)
    private readonly campaigns: CampaignRepository,
    @Inject(MARKETING_TOUCHPOINTS_REPO)
    private readonly touchpoints: TouchpointRepository,
    @Inject(MARKETING_STEPS_REPO)
    private readonly steps: CampaignStepRepository,
    @Inject(MARKETING_ENROLLMENTS_REPO)
    private readonly enrollments: CampaignEnrollmentRepository,
    @Inject(MARKETING_TEMPORAL_CLIENT)
    private readonly temporal: TemporalClient | null,
    @Inject(MARKETING_APPROVALS_REPO)
    private readonly approvals: ApprovalRepository,
    @Inject(MARKETING_EVENTS_REPO)
    private readonly events: EventRepository,
  ) {}

  @Get("campaigns")
  async list(
    @Query("status") statusRaw?: string,
    @Query("limit") limitRaw?: string,
  ): Promise<{ campaigns: CampaignListRow[] }> {
    const status = parseStatus(statusRaw);
    const limit = clampLimit(limitRaw, 100, 500);

    const rows = await withTenant(this.db, this.tenant.tenantId, async (tx) => {
      return this.campaigns.listWithRollups(tx, limit, status);
    });

    return { campaigns: rows.map(toListRow) };
  }

  @Get("campaigns/:id")
  async detail(
    @Param("id") id: string,
  ): Promise<{ campaign: CampaignDetail }> {
    const tenantId = this.tenant.tenantId;

    const detail = await withTenant(this.db, tenantId, async (tx) => {
      const campaign = await this.campaigns.findByIdWithRollups(tx, id);
      if (!campaign) return null;
      const tps = await this.campaigns.listTouchpointsForCampaign(tx, id, 50);
      return {
        campaign: toListRow(campaign),
        touchpoints: tps.map(
          (t): CampaignTouchpointRow => ({
            id: t.id,
            channel: t.channel,
            actor: t.actor,
            occurredAt: t.occurredAt.toISOString(),
            contactId: t.contactId,
            orgId: t.orgId,
            leadId: t.leadId,
            campaignId: t.campaignId,
            metadata: t.metadata,
          }),
        ),
      };
    });

    if (!detail) throw new NotFoundException(`campaign ${id} not found`);
    return {
      campaign: { ...detail.campaign, touchpoints: detail.touchpoints },
    };
  }

  // ---------------------------------------------------------------------
  // Campaign steps — plan authoring
  // ---------------------------------------------------------------------

  @Get("campaigns/:id/steps")
  async listSteps(
    @Param("id") campaignId: string,
  ): Promise<{ steps: CampaignStepRow[]; validation: string | null }> {
    const result = await withTenant(this.db, this.tenant.tenantId, async (tx) => {
      const rows = await this.steps.listByCampaign(tx, campaignId);
      const validation = await this.steps.validateSequence(tx, campaignId);
      return { rows, validation };
    });
    return {
      steps: result.rows.map(toStepRow),
      validation: result.validation,
    };
  }

  @Post("campaigns/:id/steps")
  @HttpCode(201)
  async createStep(
    @Param("id") campaignId: string,
    @Body() raw: unknown,
  ): Promise<{ step: CampaignStepRow }> {
    const parsed = CreateStepBody.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    const input = parsed.data;
    const { tenantId } = this.tenant;

    const step = await withTenant(this.db, tenantId, async (tx) => {
      const campaign = await this.campaigns.findById(tx, campaignId);
      if (!campaign) {
        throw new NotFoundException(`campaign ${campaignId} not found`);
      }
      try {
        return await this.steps.create(tx, tenantId, {
          campaignId,
          position: input.position,
          channel: input.channel,
          ...(input.delayAfterPriorMs !== undefined
            ? { delayAfterPriorMs: input.delayAfterPriorMs }
            : {}),
          ...(input.templateRef !== undefined
            ? { templateRef: input.templateRef }
            : {}),
          ...(input.gateConditionJson !== undefined
            ? { gateConditionJson: input.gateConditionJson }
            : {}),
          ...(input.tier !== undefined ? { tier: input.tier } : {}),
          ...(input.autoApprove !== undefined
            ? { autoApprove: input.autoApprove }
            : {}),
        });
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes("duplicate") || message.includes("unique")) {
          throw new ConflictException(
            `step at position ${input.position} already exists in campaign ${campaignId}`,
          );
        }
        throw err;
      }
    });

    this.log.log(`step ${step.id} (pos=${step.position}) added to ${campaignId}`);
    return { step: toStepRow(step) };
  }

  @Patch("campaigns/:id/steps/:stepId")
  async updateStep(
    @Param("id") campaignId: string,
    @Param("stepId") stepId: string,
    @Body() raw: unknown,
  ): Promise<{ step: CampaignStepRow }> {
    const parsed = UpdateStepBody.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);

    const step = await withTenant(this.db, this.tenant.tenantId, async (tx) => {
      const existing = await this.steps.findById(tx, stepId);
      if (!existing || existing.campaignId !== campaignId) {
        throw new NotFoundException(`step ${stepId} not found in campaign ${campaignId}`);
      }
      // Strip undefineds — the repo's UpdatePatch uses exactOptional
      // property types, so `{ channel: undefined }` is a type error.
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed.data)) {
        if (v !== undefined) patch[k] = v;
      }
      const updated = await this.steps.update(tx, stepId, patch as never);
      if (!updated) throw new Error(`step ${stepId} disappeared during update`);
      return updated;
    });

    return { step: toStepRow(step) };
  }

  @Delete("campaigns/:id/steps/:stepId")
  @HttpCode(204)
  async deleteStep(
    @Param("id") campaignId: string,
    @Param("stepId") stepId: string,
  ): Promise<void> {
    await withTenant(this.db, this.tenant.tenantId, async (tx) => {
      const existing = await this.steps.findById(tx, stepId);
      if (!existing || existing.campaignId !== campaignId) {
        throw new NotFoundException(`step ${stepId} not found in campaign ${campaignId}`);
      }
      await this.steps.delete(tx, stepId);
    });
  }

  // ---------------------------------------------------------------------
  // Enrollments — recipient state
  // ---------------------------------------------------------------------

  /**
   * Sprint F — enrolling a batch is now a T2 reviewer gate. The
   * controller creates a pending `campaign.enroll_batch` approval
   * carrying the plan summary + recipient count; the approval
   * executor (apps/worker) applies it on approve: enrollment rows
   * land, CampaignEnrollmentWorkflow(s) start.
   *
   * The pre-Sprint-F direct-start path is gone — even a 1-recipient
   * batch goes through the gate. Operators who want fast-lane
   * sequences can flip `auto_approve` per step in the plan.
   */
  @Post("campaigns/:id/enroll")
  @HttpCode(201)
  async enroll(
    @Param("id") campaignId: string,
    @Body() raw: unknown,
  ): Promise<{
    approvalId: string;
    recipientCount: number;
    status: "pending";
  }> {
    const parsed = EnrollBody.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    const { tenantId, userId } = this.tenant;

    // Dedupe the contactIds at the boundary so the recipient count +
    // downstream enrollBatch stay consistent.
    const contactIds = Array.from(new Set(parsed.data.contactIds));

    const approvalId = await withTenant(this.db, tenantId, async (tx) => {
      const campaign = await this.campaigns.findById(tx, campaignId);
      if (!campaign) {
        throw new NotFoundException(`campaign ${campaignId} not found`);
      }
      const validation = await this.steps.validateSequence(tx, campaignId);
      if (validation) {
        throw new BadRequestException(`campaign plan invalid: ${validation}`);
      }
      const planSteps = await this.steps.listByCampaign(tx, campaignId);
      const planSummary = planSteps.map((s) => ({
        position: s.position,
        channel: s.channel,
        tier: s.tier,
        auto_approve: s.autoApprove,
        delay_after_prior_ms: s.delayAfterPriorMs,
      }));

      const approval = await this.approvals.create(tx, tenantId, {
        agentRunId: null,
        actionType: "campaign.enroll_batch",
        proposedPayload: {
          tier: "T2",
          campaign_id: campaignId,
          contact_ids: contactIds,
          recipient_count: contactIds.length,
          plan_summary: planSummary,
          requested_by: userId,
        },
      });

      await this.events.insertIfNotExists(tx, tenantId, {
        verb: "campaign.enrollment_batch_requested",
        subjectType: "campaign",
        subjectId: campaignId,
        actorType: "user",
        actorId: userId,
        objectType: "approval",
        objectId: approval.id,
        occurredAt: new Date(),
        idempotencyKey: `campaign.enrollment_batch_requested:${approval.id}`,
        metadata: {
          approval_id: approval.id,
          campaign_id: campaignId,
          recipient_count: contactIds.length,
          plan_step_count: planSteps.length,
        },
      });

      return approval.id;
    });

    this.log.log(
      `enroll campaign=${campaignId} approval=${approvalId} recipients=${contactIds.length}`,
    );
    return {
      approvalId,
      recipientCount: contactIds.length,
      status: "pending",
    };
  }

  @Get("campaigns/:id/enrollments")
  async listEnrollments(
    @Param("id") campaignId: string,
    @Query("state") state?: string,
    @Query("limit") limitRaw?: string,
  ): Promise<{
    enrollments: CampaignEnrollmentRow[];
    counts: Record<string, number>;
  }> {
    const limit = clampLimit(limitRaw, 100, 500);
    const result = await withTenant(this.db, this.tenant.tenantId, async (tx) => {
      const [list, counts] = await Promise.all([
        this.enrollments.list(tx, {
          campaignId,
          ...(state ? { state } : {}),
          limit,
        }),
        this.enrollments.countByState(tx, campaignId),
      ]);
      return { list, counts };
    });
    return {
      enrollments: result.list.map(toEnrollmentRow),
      counts: result.counts,
    };
  }

  /**
   * Per-campaign engagement metrics. Groups the `touchpoints` table
   * by channel verb for rows linked to this campaign and computes
   * open / click / bounce / reply rates. Fed by the existing Resend +
   * Twilio webhook normalizers — every email.sent / email.opened /
   * email.clicked / email.bounced / sms.delivered / whatsapp.replied
   * etc. lands as a row here and surfaces on the campaign page.
   */
  @Get("campaigns/:id/metrics")
  async metrics(@Param("id") campaignId: string): Promise<{
    campaignId: string;
    totals: {
      enrollments: number;
      sent: number;
      delivered: number;
      opened: number;
      clicked: number;
      replied: number;
      bounced: number;
      failed: number;
    };
    rates: {
      delivery_rate: number | null;
      open_rate: number | null;
      click_rate: number | null;
      click_through_rate: number | null;
      reply_rate: number | null;
      bounce_rate: number | null;
    };
    by_channel: Array<{
      channel: string;
      count: number;
    }>;
  }> {
    const [breakdown, enrollmentCounts] = await withTenant(
      this.db,
      this.tenant.tenantId,
      async (tx) =>
        Promise.all([
          this.touchpoints.channelBreakdownByCampaign(tx, campaignId),
          this.enrollments.countByState(tx, campaignId),
        ]),
    );

    const total = (verbSuffix: string): number =>
      breakdown
        .filter((r) => r.channel.endsWith(`.${verbSuffix}`))
        .reduce((sum, r) => sum + r.count, 0);

    const sent = total("sent");
    const delivered = total("delivered");
    const opened = total("opened");
    const clicked = total("clicked");
    const replied = total("replied");
    const bounced = total("bounced");
    const failed = total("failed");
    const enrollments = Object.values(enrollmentCounts).reduce(
      (sum: number, n) => sum + (typeof n === "number" ? n : 0),
      0,
    );

    const safe = (numerator: number, denominator: number): number | null =>
      denominator === 0 ? null : numerator / denominator;

    return {
      campaignId,
      totals: {
        enrollments,
        sent,
        delivered,
        opened,
        clicked,
        replied,
        bounced,
        failed,
      },
      rates: {
        delivery_rate: safe(delivered, sent),
        open_rate: safe(opened, sent),
        click_rate: safe(clicked, sent),
        click_through_rate: safe(clicked, opened),
        reply_rate: safe(replied, sent),
        bounce_rate: safe(bounced, sent),
      },
      by_channel: breakdown,
    };
  }
}

function toListRow(row: CampaignWithRollups): CampaignListRow {
  return {
    id: row.id,
    channel: row.channel,
    source: row.source,
    medium: row.medium,
    accountRef: row.accountRef,
    spend: row.spend,
    objective: row.objective,
    status: row.status,
    touchpointCount: row.touchpointCount,
    sent: row.sent,
    delivered: row.delivered,
    opened: row.opened,
    clicked: row.clicked,
    bounced: row.bounced,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseStatus(raw: string | undefined): CampaignStatus | null {
  if (!raw) return null;
  if (!CAMPAIGN_STATUSES.has(raw as CampaignStatus)) {
    throw new BadRequestException(
      `status '${raw}' not allowed; expected one of active|paused|completed|archived`,
    );
  }
  return raw as CampaignStatus;
}

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function toStepRow(row: {
  id: string;
  campaignId: string;
  position: number;
  channel: string;
  delayAfterPriorMs: number;
  templateRef: string | null;
  gateConditionJson: Record<string, unknown>;
  tier: string;
  autoApprove: boolean;
  createdAt: Date;
  updatedAt: Date;
}): CampaignStepRow {
  return {
    id: row.id,
    campaignId: row.campaignId,
    position: row.position,
    channel: row.channel,
    delayAfterPriorMs: row.delayAfterPriorMs,
    templateRef: row.templateRef,
    gateConditionJson: row.gateConditionJson,
    tier: row.tier,
    autoApprove: row.autoApprove,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEnrollmentRow(row: {
  id: string;
  campaignId: string;
  contactId: string;
  currentStep: number;
  state: string;
  lastEventAt: Date | null;
  branchHistoryJson: Array<Record<string, unknown>>;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}): CampaignEnrollmentRow {
  return {
    id: row.id,
    campaignId: row.campaignId,
    contactId: row.contactId,
    currentStep: row.currentStep,
    state: row.state,
    lastEventAt: row.lastEventAt ? row.lastEventAt.toISOString() : null,
    branchHistoryJson: row.branchHistoryJson,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
