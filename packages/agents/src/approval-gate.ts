import { createId } from "@vex/domain";
import type { ProposedAction } from "@vex/integrations";
import type { Approval } from "@vex/db";
import type { AgentContext } from "./agents/types.js";

/**
 * Centralised gate for T2+ actions. Per invariant: T2+ never executes
 * inline — the agent describes what it would do, ApprovalGate writes the
 * approval row, and a human (or auto-approval rule) decides later.
 *
 * Always emits a `approval.created` audit event so the inbox + downstream
 * notifications have a deterministic trigger.
 */
export class ApprovalGate {
  async create(
    ctx: AgentContext,
    action: ProposedAction,
    agentRunId: string,
  ): Promise<Approval> {
    const approval = await ctx.approvals.create(ctx.tx, ctx.tenantId, {
      agentRunId,
      actionType: action.kind,
      proposedPayload: { ...action.payload, tier: action.tier, rationale: action.rationale },
    });

    const occurredAt = new Date();
    await ctx.events.insertIfNotExists(ctx.tx, ctx.tenantId, {
      verb: "approval.created",
      subjectType: "approval",
      subjectId: approval.id,
      actorType: "system",
      actorId: agentRunId,
      objectType: "approval",
      objectId: approval.id,
      occurredAt,
      idempotencyKey: `approval.created:${approval.id}`,
      metadata: {
        action_type: action.kind,
        tier: action.tier,
        agent_run_id: agentRunId,
        audit_event_id: createId(),
      },
    });

    return approval;
  }
}
