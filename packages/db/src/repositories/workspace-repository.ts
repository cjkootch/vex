import { eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { workspaces, type Workspace, type WorkspaceSettings } from "../schema/workspaces.js";

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
}
