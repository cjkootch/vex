import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";
import { addApprovalExecutorJob, type ApprovalExecutorJobData } from "@vex/agents";
import {
  withTenant,
  type ApprovalRepository,
  type Approval,
  type Db,
  type EventRepository,
} from "@vex/db";
import type { Client as TemporalClient } from "@temporalio/client";
import { WorkflowId } from "@vex/integrations";
import {
  APPROVAL_EXECUTOR_QUEUE,
  APPROVALS_DB_CLIENT,
  APPROVALS_EVENTS_REPO,
  APPROVALS_REPO,
  TEMPORAL_CLIENT,
} from "./tokens.js";

export interface ListPendingArgs {
  tenantId: string;
  limit?: number;
}

export interface DecisionArgs {
  tenantId: string;
  workspaceId: string;
  approvalId: string;
  reviewerId: string;
  /** When rejecting, the reviewer's reason — stored on the audit event. */
  reason?: string;
}

@Injectable()
export class ApprovalsService {
  private readonly log = new Logger(ApprovalsService.name);

  constructor(
    @Inject(APPROVALS_DB_CLIENT) private readonly db: Db,
    @Inject(APPROVALS_REPO) private readonly approvals: ApprovalRepository,
    @Inject(APPROVALS_EVENTS_REPO) private readonly events: EventRepository,
    @Inject(APPROVAL_EXECUTOR_QUEUE)
    private readonly executorQueue: Queue<ApprovalExecutorJobData>,
    @Inject(TEMPORAL_CLIENT) private readonly temporal: TemporalClient | null,
  ) {}

  async listPending(args: ListPendingArgs): Promise<Approval[]> {
    return withTenant(this.db, args.tenantId, async (tx) =>
      this.approvals.listByDecision(tx, "pending", args.limit ?? 20),
    );
  }

  async findById(tenantId: string, id: string): Promise<Approval> {
    const approval = await withTenant(this.db, tenantId, async (tx) =>
      this.approvals.findById(tx, id),
    );
    if (!approval) throw new NotFoundException(`approval ${id} not found`);
    return approval;
  }

  async approve(args: DecisionArgs): Promise<Approval> {
    const decided = await withTenant(this.db, args.tenantId, async (tx) => {
      const approval = await this.approvals.decide(tx, args.approvalId, "approved", args.reviewerId);
      await this.events.insertIfNotExists(tx, args.tenantId, {
        verb: "approval.approved",
        subjectType: "approval",
        subjectId: approval.id,
        actorType: "user",
        actorId: args.reviewerId,
        objectType: "approval",
        objectId: approval.id,
        occurredAt: new Date(),
        idempotencyKey: `approval.approved:${approval.id}`,
        metadata: { action_type: approval.actionType },
      });
      return approval;
    });

    await addApprovalExecutorJob(this.executorQueue, {
      approval_id: decided.id,
      workspace_id: args.workspaceId,
    });

    await this.signalWorkflow(decided, "approved", args);

    return decided;
  }

  async reject(args: DecisionArgs): Promise<Approval> {
    const decided = await withTenant(this.db, args.tenantId, async (tx) => {
      const approval = await this.approvals.decide(tx, args.approvalId, "rejected", args.reviewerId);
      await this.events.insertIfNotExists(tx, args.tenantId, {
        verb: "approval.rejected",
        subjectType: "approval",
        subjectId: approval.id,
        actorType: "user",
        actorId: args.reviewerId,
        objectType: "approval",
        objectId: approval.id,
        occurredAt: new Date(),
        idempotencyKey: `approval.rejected:${approval.id}`,
        metadata: {
          action_type: approval.actionType,
          ...(args.reason ? { reason: args.reason } : {}),
        },
      });
      return approval;
    });

    await this.signalWorkflow(decided, "rejected", args);
    return decided;
  }

  /**
   * Best-effort Temporal signal. The follow-up workflow expects a signal
   * keyed by approvalId; if the approval came from a non-workflow source
   * (Sprint-6 BullMQ FollowUpAgent) the signal will fail with a
   * `WorkflowNotFound` error which we swallow and log.
   */
  private async signalWorkflow(
    approval: Approval,
    decision: "approved" | "rejected",
    args: DecisionArgs,
  ): Promise<void> {
    if (!this.temporal) return;
    if (!approval.agentRunId) return;
    const workflowId = WorkflowId.followUp(approval.agentRunId);
    try {
      const handle = this.temporal.workflow.getHandle(workflowId);
      await handle.signal("approval.decision", {
        approvalId: approval.id,
        decision,
        reviewerId: args.reviewerId,
        ...(args.reason ? { reason: args.reason } : {}),
      });
    } catch (err) {
      this.log.warn(
        `temporal signal failed for ${workflowId}: ${(err as Error).message} — workflow may not exist`,
      );
    }
  }
}
