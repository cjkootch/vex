import { Inject, Injectable } from "@nestjs/common";
import {
  withTenant,
  type Db,
  type EventRepository,
  type WorkspaceRepository,
  type WorkspaceStrategy,
} from "@vex/db";
import {
  STRATEGY_DB_CLIENT,
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
        // One event per save. A future audit-history surface can
        // dedupe or keep all versions by reading `events` filtered
        // on this verb.
        idempotencyKey: `strategy.updated:${workspaceId}:${row.strategy.updated_at ?? Date.now()}`,
        metadata: {
          updated_by: updatedBy,
          fields_populated: describePopulatedFields(row.strategy),
        },
      });
    });

    return row.strategy;
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
