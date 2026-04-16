import { createId } from "@vex/domain";
import type { Db } from "../client.js";
import { touchpoints, type Touchpoint } from "../schema/touchpoints.js";

export interface TouchpointInsert {
  channel: string;
  actor?: string | null;
  occurredAt: Date;
  campaignId?: string | null;
  leadId?: string | null;
  contactId?: string | null;
  orgId?: string | null;
  metadata?: Record<string, unknown>;
}

export class TouchpointRepository {
  constructor(private readonly db: Db) {}

  async insert(tenantId: string, data: TouchpointInsert): Promise<Touchpoint> {
    const [row] = await this.db
      .insert(touchpoints)
      .values({
        id: createId(),
        tenantId,
        channel: data.channel,
        actor: data.actor ?? null,
        occurredAt: data.occurredAt,
        campaignId: data.campaignId ?? null,
        leadId: data.leadId ?? null,
        contactId: data.contactId ?? null,
        orgId: data.orgId ?? null,
        metadata: data.metadata ?? {},
      })
      .returning();
    if (!row) throw new Error("touchpoint insert returned no row");
    return row;
  }
}
