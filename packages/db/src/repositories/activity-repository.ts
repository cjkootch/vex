import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import { activities, type Activity } from "../schema/activities.js";

export interface ActivityInsert {
  type: string;
  relatedObjectIds?: Record<string, string>;
  occurredAt: Date;
  result?: string | null;
  transcriptRef?: string | null;
  durationSeconds?: number | null;
  metadata?: Record<string, unknown>;
}

export class ActivityRepository {
  async insert(tx: Tx, tenantId: string, data: ActivityInsert): Promise<Activity> {
    const [row] = await tx
      .insert(activities)
      .values({
        id: createId(),
        tenantId,
        type: data.type,
        relatedObjectIds: data.relatedObjectIds ?? {},
        occurredAt: data.occurredAt,
        result: data.result ?? null,
        transcriptRef: data.transcriptRef ?? null,
        durationSeconds: data.durationSeconds ?? null,
        metadata: data.metadata ?? {},
      })
      .returning();
    if (!row) throw new Error("activity insert returned no row");
    return row;
  }
}
