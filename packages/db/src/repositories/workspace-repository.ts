import { eq } from "drizzle-orm";
import type { Db } from "../client.js";
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
 */
export class WorkspaceRepository {
  async findById(db: Db, id: string): Promise<Workspace | null> {
    const rows = await db.select().from(workspaces).where(eq(workspaces.id, id));
    return rows[0] ?? null;
  }

  async getSettings(db: Db, id: string): Promise<WorkspaceSettings | null> {
    const ws = await this.findById(db, id);
    return ws?.settings ?? null;
  }

  /**
   * Overwrite the entire settings blob for a workspace. Same Db-not-Tx
   * rationale as findById — workspaces row is its own tenant boundary
   * (RLS USING `id = current_setting('app.tenant_id', true)`), so the
   * caller must already have established that the session user is an
   * OWNER of this workspace before invoking.
   */
  async updateSettings(
    db: Db,
    id: string,
    settings: WorkspaceSettings,
  ): Promise<Workspace> {
    const [row] = await db
      .update(workspaces)
      .set({ settings, updatedAt: new Date() })
      .where(eq(workspaces.id, id))
      .returning();
    if (!row) throw new Error(`workspace ${id} not found`);
    return row;
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
    const [row] = await db
      .update(workspaces)
      .set({ strategy: stamped, updatedAt: new Date() })
      .where(eq(workspaces.id, id))
      .returning();
    if (!row) throw new Error(`workspace ${id} not found`);
    return row;
  }
}
