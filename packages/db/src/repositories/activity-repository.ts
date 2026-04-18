import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm";
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

  /**
   * Look up an activity by `type` and a `session_id` stored in its
   * metadata JSONB. Used by TranscriptProcessor to make the job
   * idempotent on retry.
   */
  /**
   * Attach a transcript_ref + duration to an existing activity, merging
   * caller-supplied metadata into the JSONB column. Used by the Sprint 12
   * fetchAndStoreRecording activity to link the `voice_call` activity
   * row to the recording's S3 key once the recording callback fires.
   */
  async updateTranscriptRef(
    tx: Tx,
    id: string,
    transcriptRef: string,
    metadataPatch: Record<string, unknown>,
  ): Promise<Activity> {
    const duration =
      typeof metadataPatch["duration_seconds"] === "number"
        ? (metadataPatch["duration_seconds"] as number)
        : null;
    const [row] = await tx
      .update(activities)
      .set({
        transcriptRef,
        ...(duration !== null ? { durationSeconds: duration } : {}),
        result: "recorded",
        metadata: sql`${activities.metadata} || ${JSON.stringify(metadataPatch)}::jsonb`,
      })
      .where(eq(activities.id, id))
      .returning();
    if (!row) throw new Error(`activity ${id} not found`);
    return row;
  }

  /**
   * Keyset-paginated feed of activities filtered by type. Used by the
   * communications log to fold voice calls into the same time-sorted
   * stream as touchpoints. `contactId` matches rows whose
   * `related_object_ids.contact_id` JSONB field equals the id — that's
   * where OutboundCallWorkflow stamps the callee when a call starts.
   */
  async listFeed(
    tx: Tx,
    filters: {
      type: string;
      contactId?: string;
      before?: Date;
    },
    limit = 50,
  ): Promise<Activity[]> {
    const clauses: SQL[] = [eq(activities.type, filters.type)];
    if (filters.contactId) {
      clauses.push(
        sql`${activities.relatedObjectIds} ->> 'contact_id' = ${filters.contactId}`,
      );
    }
    if (filters.before) {
      clauses.push(lt(activities.occurredAt, filters.before));
    }
    return tx
      .select()
      .from(activities)
      .where(and(...clauses))
      .orderBy(desc(activities.occurredAt))
      .limit(limit);
  }

  async findByTypeAndSessionId(
    tx: Tx,
    type: string,
    sessionId: string,
  ): Promise<Activity | null> {
    const rows = await tx
      .select()
      .from(activities)
      .where(
        and(
          eq(activities.type, type),
          sql`${activities.metadata} ->> 'session_id' = ${sessionId}`,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
}
