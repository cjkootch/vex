import type { Redis } from "ioredis";

export interface VoiceSessionRecord {
  sessionId: string;
  tenantId: string;
  workspaceId: string;
  userId: string;
  orgId: string | null;
  contactId: string | null;
  createdAt: number;
  expiresAt: number;
  status: VoiceSessionStatus;
  /** Set when `/end` is called. */
  endedAt?: number;
  /** Set when the TranscriptProcessor finishes (worker → API sync is out of
   *  scope for Sprint 9 — the API polls the activity row instead). */
  activityId?: string;
}

export type VoiceSessionStatus = "active" | "ended" | "processing" | "processed";

/**
 * Redis-backed voice-session registry. Keyed by session_id with a 1-hour
 * TTL. Sprint 9 keeps session state out of Postgres because:
 *   - sessions are short-lived (the ephemeral token itself only lives ~60s)
 *   - the durable record is the `activity` row the TranscriptProcessor
 *     writes after the session ends — this store is just the in-flight
 *     bookkeeping layer.
 */
export class VoiceSessionStore {
  private static readonly TTL_SECONDS = 3600;

  constructor(private readonly redis: Redis) {}

  private key(sessionId: string): string {
    return `voice:session:${sessionId}`;
  }

  async create(record: VoiceSessionRecord): Promise<void> {
    await this.redis.set(
      this.key(record.sessionId),
      JSON.stringify(record),
      "EX",
      VoiceSessionStore.TTL_SECONDS,
    );
  }

  async get(sessionId: string): Promise<VoiceSessionRecord | null> {
    const raw = await this.redis.get(this.key(sessionId));
    if (!raw) return null;
    return JSON.parse(raw) as VoiceSessionRecord;
  }

  async update(
    sessionId: string,
    patch: Partial<VoiceSessionRecord>,
  ): Promise<VoiceSessionRecord | null> {
    const existing = await this.get(sessionId);
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    await this.redis.set(
      this.key(sessionId),
      JSON.stringify(merged),
      "EX",
      VoiceSessionStore.TTL_SECONDS,
    );
    return merged;
  }
}
