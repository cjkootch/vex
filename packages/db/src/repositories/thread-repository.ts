import { desc, lt } from "drizzle-orm";
import type { Tx } from "../client.js";
import { threads, type Thread } from "../schema/threads.js";

export class ThreadRepository {
  /**
   * Threads with `last_message_at` older than `cutoff` — used by the
   * follow-up agent to surface stale conversations needing a nudge.
   */
  async listStale(tx: Tx, cutoff: Date, limit = 50): Promise<Thread[]> {
    return tx
      .select()
      .from(threads)
      .where(lt(threads.lastMessageAt, cutoff))
      .orderBy(desc(threads.lastMessageAt))
      .limit(limit);
  }
}
