import { eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../client.js";
import {
  workspaces,
  type Workspace,
  type WorkspaceSettings,
  type WorkspaceStrategy,
} from "../schema/workspaces.js";

/**
 * The only repository that takes the parent `Db` instead of a `Tx` — workspace
 * lookups happen *before* `withTenant` opens the transaction (the tenantId is
 * the workspace id, so we need to read it to set `app.tenant_id`).
 *
 * RLS note: `workspaces` has a policy `USING (id = current_setting(...))`
 * so a bare SELECT outside a tenant-scoped transaction returns zero
 * rows. Every read + write below opens a short transaction, sets
 * `app.tenant_id` to the workspace id being looked up, then runs the
 * query. This keeps the chicken-and-egg invariant honest (the workspace
 * IS the tenant, so looking it up "proves" the caller knows the tenant
 * id) while unblocking the AgentRunner, StrategyService, and AdminService
 * that all rely on these methods to bootstrap workspace state before a
 * regular `withTenant` scope opens.
 */
export class WorkspaceRepository {
  async findById(db: Db, id: string): Promise<Workspace | null> {
    return db.transaction(async (tx) => {
      await setTenant(tx, id);
      const rows = await tx.select().from(workspaces).where(eq(workspaces.id, id));
      return rows[0] ?? null;
    });
  }

  async getSettings(db: Db, id: string): Promise<WorkspaceSettings | null> {
    const ws = await this.findById(db, id);
    return ws?.settings ?? null;
  }

  /**
   * Overwrite the entire settings blob for a workspace. Same chicken-
   * and-egg rationale as findById — RLS on workspaces is scoped to the
   * id matching `app.tenant_id`, so the UPDATE must run inside a tx
   * with the setting in place. Caller must already have established
   * that the session user is an OWNER of this workspace before invoking.
   */
  async updateSettings(
    db: Db,
    id: string,
    settings: WorkspaceSettings,
  ): Promise<Workspace> {
    return db.transaction(async (tx) => {
      await setTenant(tx, id);
      const [row] = await tx
        .update(workspaces)
        .set({ settings, updatedAt: new Date() })
        .where(eq(workspaces.id, id))
        .returning();
      if (!row) throw new Error(`workspace ${id} not found`);
      return row;
    });
  }

  /**
   * Sprint S — operator-authored company strategy. Empty blob ({})
   * means "no strategy yet" and the prompt-injection code skips
   * rendering.
   */
  async getStrategy(db: Db, id: string): Promise<WorkspaceStrategy> {
    const ws = await this.findById(db, id);
    return ws?.strategy ?? {};
  }

  /**
   * Overwrite the strategy blob. Caller owns authorization — same
   * posture as updateSettings. Stamps `updated_at` + `updated_by` on
   * the JSON so operators can see when the strategy last changed
   * without needing a separate revisions table.
   */
  async updateStrategy(
    db: Db,
    id: string,
    strategy: WorkspaceStrategy,
    updatedBy: string | null,
  ): Promise<Workspace> {
    const stamped: WorkspaceStrategy = {
      ...strategy,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    };
    return db.transaction(async (tx) => {
      await setTenant(tx, id);
      const [row] = await tx
        .update(workspaces)
        .set({ strategy: stamped, updatedAt: new Date() })
        .where(eq(workspaces.id, id))
        .returning();
      if (!row) throw new Error(`workspace ${id} not found`);
      return row;
    });
  }
}

/**
 * Set `app.tenant_id` to the given workspace id for the scope of the
 * current transaction. `set_config(..., true)` is transaction-local —
 * the value disappears on COMMIT/ROLLBACK, so the session state never
 * leaks across pooler connection reuse (same guarantee as `SET LOCAL`).
 */
async function setTenant(tx: Tx, workspaceId: string): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('app.tenant_id', ${workspaceId}, true)`,
  );
}
