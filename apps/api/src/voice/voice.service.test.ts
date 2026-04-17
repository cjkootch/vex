import { describe, expect, it, vi } from "vitest";
import { VoiceService } from "./voice.service.js";
import type { VoiceSessionRecord, VoiceSessionStore } from "./voice-session-store.js";

const TENANT = "01HSEEDWRK000000000000000A";
const WORKSPACE = TENANT;
const USER = "01HSEEDPRS000000000000000A";
const SESSION_ID = "sess_openai_abc";

function makeBuilder() {
  return {
    async build() {
      return {
        orgId: null,
        contactId: null,
        orgSummary: null,
        recentCalls: [],
        openFollowUps: [],
        keyContacts: [],
        recentEmailClicks: [],
        totalEstimatedTokens: 42,
        budget: {
          target: 6000,
          hardMax: 10000,
          perBlock: {
            orgSummary: 800,
            recentCall: 600,
            openFollowUp: 400,
            keyContact: 120,
            emailClick: 200,
          },
        },
        truncated: false,
      };
    },
  } as never;
}

function makeStore(): VoiceSessionStore & {
  records: Map<string, VoiceSessionRecord>;
} {
  const records = new Map<string, VoiceSessionRecord>();
  const store = {
    records,
    async create(record: VoiceSessionRecord) {
      records.set(record.sessionId, record);
    },
    async get(sessionId: string) {
      return records.get(sessionId) ?? null;
    },
    async update(sessionId: string, patch: Partial<VoiceSessionRecord>) {
      const existing = records.get(sessionId);
      if (!existing) return null;
      const merged = { ...existing, ...patch };
      records.set(sessionId, merged);
      return merged;
    },
  };
  return store as unknown as VoiceSessionStore & {
    records: Map<string, VoiceSessionRecord>;
  };
}

function makeService() {
  const store = makeStore();
  const mintedTokens: string[] = [];
  const enqueued: unknown[] = [];
  const transcriptQueue = {
    async add(_name: string, data: unknown, _opts: unknown) {
      enqueued.push(data);
      return { id: "job_1" } as never;
    },
  };

  const openai = {
    async createRealtimeEphemeralToken(req: { instructions: string }) {
      mintedTokens.push(`ephemeral_${mintedTokens.length + 1}`);
      expect(req.instructions.length).toBeGreaterThan(0);
      return {
        sessionId: SESSION_ID,
        ephemeralToken: mintedTokens[mintedTokens.length - 1]!,
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        model: "gpt-4o-realtime-preview-2024-12-17",
      };
    },
  };

  const tx = { execute: vi.fn(async () => undefined) };
  const service = new VoiceService(
    { transaction: async <T>(cb: (tx: unknown) => Promise<T>) => cb(tx) } as never,
    openai as never,
    store as never,
    makeBuilder(),
    transcriptQueue as never,
  );

  return { service, store, mintedTokens, enqueued, openai };
}

describe("VoiceService", () => {
  it("mints an ephemeral token and stores the session", async () => {
    const { service, store, mintedTokens } = makeService();

    const result = await service.start({
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      userId: USER,
      orgId: null,
      contactId: null,
    });

    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.ephemeralToken).toMatch(/^ephemeral_/);
    expect(result.ephemeralToken).not.toMatch(/^sk-/);
    expect(mintedTokens).toHaveLength(1);
    expect(store.records.get(SESSION_ID)?.status).toBe("active");
    expect(store.records.get(SESSION_ID)?.tenantId).toBe(TENANT);
  });

  it("ending a session enqueues a transcript job and flips the record to processing", async () => {
    const { service, store, enqueued } = makeService();

    await service.start({
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      userId: USER,
      orgId: null,
      contactId: null,
    });

    await service.end({
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      sessionId: SESSION_ID,
      transcriptText: "User: Hi.\nVex: Hello.",
      durationSeconds: 42,
      inputAudioTokens: 500,
      outputAudioTokens: 400,
    });

    expect(store.records.get(SESSION_ID)?.status).toBe("processing");
    expect(enqueued).toHaveLength(1);
    const job = enqueued[0] as Record<string, unknown>;
    expect(job["session_id"]).toBe(SESSION_ID);
    expect(job["tenant_id"]).toBe(TENANT);
    expect(job["input_audio_tokens"]).toBe(500);
  });

  it("ending a session from a different tenant yields 404", async () => {
    const { service } = makeService();

    await service.start({
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      userId: USER,
      orgId: null,
      contactId: null,
    });

    await expect(
      service.end({
        tenantId: "01HSEEDWRK000000000000000B",
        workspaceId: "01HSEEDWRK000000000000000B",
        sessionId: SESSION_ID,
        transcriptText: "...",
        durationSeconds: 1,
      }),
    ).rejects.toMatchObject({ message: "voice_session_not_found" });
  });
});

