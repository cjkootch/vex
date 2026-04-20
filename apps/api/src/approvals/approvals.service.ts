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

export interface BulkDecisionArgs {
  tenantId: string;
  workspaceId: string;
  reviewerId: string;
  approvalIds: string[];
  decision: "approved" | "rejected";
  /** Reviewer's reason — applied uniformly to every audit event. */
  reason?: string;
}

export interface BulkDecisionResult {
  /** Approvals that transitioned from pending → decided. */
  decided: Approval[];
  /** Ids that were requested but skipped (already decided / not found). */
  skipped: string[];
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

  /**
   * Fetch a single approval + its executor outcome, if one has landed
   * yet. The outcome comes from the audit `events` table — the
   * approval-executor worker writes one of:
   *   - `approval.executor.failed` on validation / dispatch failure
   *   - `approval.executor.skipped` on replay (prior apply)
   * Successful sync applies stamp `applied_object_id` / `applied_at`
   * on the approval row itself, so we infer that status from the
   * row. Async paths (outbound_call → Temporal) write their own
   * workflow-lifecycle events that we ignore here — if the user
   * wants deeper detail they click the call detail page.
   */
  async findByIdWithOutcome(
    tenantId: string,
    id: string,
  ): Promise<{
    approval: Approval;
    outcome:
      | null
      | {
          status: "applied" | "failed" | "skipped" | "queued";
          reason: string | null;
          actionType: string | null;
          appliedObjectId: string | null;
          appliedAt: string | null;
          occurredAt: string | null;
        };
  }> {
    return withTenant(this.db, tenantId, async (tx) => {
      const approval = await this.approvals.findById(tx, id);
      if (!approval) throw new NotFoundException(`approval ${id} not found`);
      if (approval.decision === "pending") {
        return { approval, outcome: null };
      }
      // Approval was decided — look for executor signals.
      if (approval.appliedObjectId) {
        return {
          approval,
          outcome: {
            status: "applied" as const,
            reason: null,
            actionType: approval.actionType,
            appliedObjectId: approval.appliedObjectId,
            appliedAt: approval.appliedAt ? approval.appliedAt.toISOString() : null,
            occurredAt: approval.appliedAt ? approval.appliedAt.toISOString() : null,
          },
        };
      }
      // Scan the audit events for the latest executor verb on this
      // approval. listBySubject returns newest-first so the first
      // match wins.
      const events = await this.events.listBySubject(
        tx,
        "approval",
        approval.id,
        20,
      );
      const executorEvent = events.find(
        (e) => e.verb === "approval.executor.failed" || e.verb === "approval.executor.skipped",
      );
      if (!executorEvent) {
        return {
          approval,
          outcome: {
            status: "queued" as const,
            reason: null,
            actionType: approval.actionType,
            appliedObjectId: null,
            appliedAt: null,
            occurredAt: null,
          },
        };
      }
      const md = (executorEvent.metadata ?? {}) as Record<string, unknown>;
      const reason = typeof md["reason"] === "string" ? md["reason"] : null;
      const actionType =
        typeof md["action_type"] === "string"
          ? md["action_type"]
          : approval.actionType;
      const status: "failed" | "skipped" =
        executorEvent.verb === "approval.executor.failed" ? "failed" : "skipped";
      return {
        approval,
        outcome: {
          status,
          reason,
          actionType,
          appliedObjectId: null,
          appliedAt: null,
          occurredAt: executorEvent.occurredAt.toISOString(),
        },
      };
    });
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

  /**
   * Decide N approvals in a single transaction. Already-decided rows
   * are skipped (not an error) — the response splits `decided` and
   * `skipped` so the UI can show "N approved, M were already handled".
   * Executor jobs + Temporal signals fire per decided row after the
   * transaction commits, matching single-row semantics.
   */
  async bulkDecide(args: BulkDecisionArgs): Promise<BulkDecisionResult> {
    if (args.approvalIds.length === 0) {
      return { decided: [], skipped: [] };
    }
    const verb =
      args.decision === "approved" ? "approval.approved" : "approval.rejected";

    const decided = await withTenant(this.db, args.tenantId, async (tx) => {
      const rows = await this.approvals.bulkDecide(
        tx,
        args.approvalIds,
        args.decision,
        args.reviewerId,
      );
      for (const row of rows) {
        await this.events.insertIfNotExists(tx, args.tenantId, {
          verb,
          subjectType: "approval",
          subjectId: row.id,
          actorType: "user",
          actorId: args.reviewerId,
          objectType: "approval",
          objectId: row.id,
          occurredAt: new Date(),
          idempotencyKey: `${verb}:${row.id}`,
          metadata: {
            action_type: row.actionType,
            bulk: true,
            ...(args.reason ? { reason: args.reason } : {}),
          },
        });
      }
      return rows;
    });

    if (args.decision === "approved") {
      await Promise.all(
        decided.map((row) =>
          addApprovalExecutorJob(this.executorQueue, {
            approval_id: row.id,
            workspace_id: args.workspaceId,
          }),
        ),
      );
    }

    await Promise.all(
      decided.map((row) =>
        this.signalWorkflow(row, args.decision, {
          tenantId: args.tenantId,
          workspaceId: args.workspaceId,
          approvalId: row.id,
          reviewerId: args.reviewerId,
          ...(args.reason ? { reason: args.reason } : {}),
        }),
      ),
    );

    const decidedIds = new Set(decided.map((r) => r.id));
    const skipped = args.approvalIds.filter((id) => !decidedIds.has(id));
    return { decided, skipped };
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
   * Best-effort Temporal signal. Routes by `approval.actionType`:
   *   - `outbound_call` (Sprint 12, T3) → `WorkflowId.outboundCall(agentRunId)`.
   *     If `proposedPayload.workflow_id` is set it wins — the CallsService
   *     stamps the canonical workflow id there so the signal always
   *     reaches the exact instance even if agentRunId drifts.
   *   - everything else → `WorkflowId.followUp(agentRunId)` (pre-Sprint-12
   *     default).
   *
   * When no agentRunId and no stamped workflow_id are resolvable we
   * skip silently — the approval still lands, the executor queue still
   * fires, and the audit event is already written.
   */
  private async signalWorkflow(
    approval: Approval,
    decision: "approved" | "rejected",
    args: DecisionArgs,
  ): Promise<void> {
    if (!this.temporal) return;
    const workflowId = resolveWorkflowId(approval);
    if (!workflowId) return;
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

function resolveWorkflowId(approval: Approval): string | null {
  const stamped = approval.proposedPayload["workflow_id"];
  if (typeof stamped === "string" && stamped.length > 0) return stamped;
  if (!approval.agentRunId) return null;
  if (approval.actionType === "outbound_call") {
    return WorkflowId.outboundCall(approval.agentRunId);
  }
  return WorkflowId.followUp(approval.agentRunId);
}
