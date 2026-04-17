import { describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { buildTranscriptProcessor } from "./transcript-processor.js";
import type { TranscriptJobData } from "../queues.js";

const TENANT = "01HSEEDWRK0000000000000001";
const WORKSPACE = TENANT;
const SESSION = "sess_12345";

function makeDb() {
  const tx = { execute: vi.fn(async () => undefined) };
  const db = {
    async transaction<T>(cb: (tx: unknown) => Promise<T>): Promise<T> {
      return cb(tx);
    },
  };
  return db as unknown as Parameters<typeof buildTranscriptProcessor>[0]["db"];
}

function makeDeps() {
  const s3Puts: { key: string; body: string }[] = [];
  const insertedActivities: { sessionId: string; id: string }[] = [];
  const insertedTouchpoints: unknown[] = [];
  const createdApprovals: {
    actionType: string;
    payload: Record<string, unknown>;
    id: string;
  }[] = [];
  const upsertedSummaries: {
    subjectId: string;
    content: string;
    id: string;
  }[] = [];
  const events: { verb: string; idempotencyKey: string }[] = [];
  const realtimeUsage: Array<{ idempotencyKey: string; inputAudioTokens: number }> = [];

  const existingActivity = { id: "" };

  const deps: Parameters<typeof buildTranscriptProcessor>[0] = {
    db: makeDb(),
    s3: {
      async putText(key: string, body: string): Promise<void> {
        s3Puts.push({ key, body });
      },
      async getText(): Promise<string> {
        return "";
      },
      bucketName: "vex-local",
    } as never,
    activities: {
      async findByTypeAndSessionId(
        _tx: unknown,
        _type: string,
        sessionId: string,
      ) {
        if (existingActivity.id && sessionId === SESSION) {
          return { id: existingActivity.id, transcriptRef: "existing-ref" } as never;
        }
        return null;
      },
      async insert(
        _tx: unknown,
        _tenantId: string,
        data: {
          transcriptRef?: string | null;
          metadata?: Record<string, unknown>;
        },
      ) {
        const id = `act_${insertedActivities.length + 1}`;
        insertedActivities.push({
          id,
          sessionId: (data.metadata?.["session_id"] as string) ?? "",
        });
        return { id, transcriptRef: data.transcriptRef ?? null } as never;
      },
    } as never,
    touchpoints: {
      async insert(
        _tx: unknown,
        _tenantId: string,
        data: Record<string, unknown>,
      ) {
        insertedTouchpoints.push(data);
        return { id: "tp_1" } as never;
      },
    } as never,
    summaries: {
      async upsert(
        _tx: unknown,
        _tenantId: string,
        data: { subjectId: string; content: string },
      ) {
        const id = `sum_${upsertedSummaries.length + 1}`;
        upsertedSummaries.push({
          id,
          subjectId: data.subjectId,
          content: data.content,
        });
        return { id } as never;
      },
      async getLatest(): Promise<null> {
        return null;
      },
      async listBySubject(): Promise<never[]> {
        return [];
      },
    } as never,
    approvals: {
      async create(
        _tx: unknown,
        _tenantId: string,
        data: { actionType: string; proposedPayload: Record<string, unknown> },
      ) {
        const id = `appr_${createdApprovals.length + 1}`;
        createdApprovals.push({
          actionType: data.actionType,
          payload: data.proposedPayload,
          id,
        });
        return { id } as never;
      },
      async listByDecision(): Promise<never[]> {
        return [];
      },
      async findById(): Promise<null> {
        return null;
      },
      async decide(): Promise<never> {
        throw new Error("not used");
      },
    } as never,
    events: {
      async insertIfNotExists(
        _tx: unknown,
        _tenantId: string,
        data: { verb: string; idempotencyKey: string },
      ) {
        events.push({ verb: data.verb, idempotencyKey: data.idempotencyKey });
        return { id: "ev_1" } as never;
      },
    } as never,
    anthropic: {
      async query() {
        return {
          answer: "The user agreed to send pricing by Friday.",
          viewManifest: {
            panels: [
              { type: "kpi_rail", metrics: [{ label: "Duration", value: "120s" }] },
            ],
          },
          proposedActions: [],
          tokensIn: 100,
          tokensOut: 50,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          costUsd: 0.01,
        };
      },
      async complete() {
        return {
          content: [
            {
              type: "text" as const,
              text:
                '```json\n{ "action_items": [\n  { "title": "Send pricing by Friday", "owner": "user", "due_hint": "Friday", "rationale": "User said: I\'ll send pricing by Friday." }\n] }\n```',
            },
          ],
          usage: { input_tokens: 50, output_tokens: 30 },
        } as never;
      },
    } as never,
    openai: {
      async recordRealtimeUsage(args: {
        idempotencyKey: string;
        inputAudioTokens: number;
        outputAudioTokens: number;
        inputTextTokens: number;
        outputTextTokens: number;
      }) {
        realtimeUsage.push({
          idempotencyKey: args.idempotencyKey,
          inputAudioTokens: args.inputAudioTokens,
        });
        return 0.02;
      },
    } as never,
  };

  return {
    deps,
    s3Puts,
    insertedActivities,
    insertedTouchpoints,
    createdApprovals,
    upsertedSummaries,
    events,
    realtimeUsage,
    existingActivity,
  };
}

function makeJob(overrides: Partial<TranscriptJobData> = {}): Job<TranscriptJobData> {
  return {
    id: SESSION,
    data: {
      session_id: SESSION,
      tenant_id: TENANT,
      workspace_id: WORKSPACE,
      transcript_text: "User: Hi.\nAssistant: Hello.",
      duration_seconds: 120,
      input_audio_tokens: 500,
      output_audio_tokens: 300,
      ...overrides,
    },
  } as unknown as Job<TranscriptJobData>;
}

describe("transcriptProcessor", () => {
  it("uploads transcript, writes activity+touchpoint+summary, and creates T2 approvals from action items", async () => {
    const harness = makeDeps();
    const processor = buildTranscriptProcessor(harness.deps);

    const result = await processor(makeJob());

    expect(result.alreadyProcessed).toBe(false);
    expect(harness.s3Puts).toHaveLength(1);
    expect(harness.s3Puts[0]!.key).toBe(`transcripts/${TENANT}/${SESSION}.txt`);
    expect(harness.s3Puts[0]!.body).toContain("Hello");

    expect(harness.insertedActivities).toHaveLength(1);
    expect(harness.insertedActivities[0]!.sessionId).toBe(SESSION);
    expect(harness.insertedTouchpoints).toHaveLength(1);
    expect(harness.upsertedSummaries).toHaveLength(1);

    expect(harness.createdApprovals).toHaveLength(1);
    expect(harness.createdApprovals[0]!.actionType).toBe("voice_followup");
    expect(harness.createdApprovals[0]!.payload["tier"]).toBe("T2");
    expect(harness.createdApprovals[0]!.payload["session_id"]).toBe(SESSION);

    const verbs = harness.events.map((e) => e.verb);
    expect(verbs).toContain("voice.action_item.created");
    expect(verbs).toContain("voice.session.processed");

    expect(harness.realtimeUsage).toHaveLength(1);
    expect(harness.realtimeUsage[0]!.inputAudioTokens).toBe(500);
    expect(harness.realtimeUsage[0]!.idempotencyKey).toBe(`voice.usage:${SESSION}`);
  });

  it("is idempotent: second run with same session_id is a no-op write-wise", async () => {
    const harness = makeDeps();
    harness.existingActivity.id = "act_existing";
    const processor = buildTranscriptProcessor(harness.deps);

    const result = await processor(makeJob());

    expect(result.alreadyProcessed).toBe(true);
    expect(harness.s3Puts).toHaveLength(0);
    expect(harness.insertedActivities).toHaveLength(0);
    expect(harness.insertedTouchpoints).toHaveLength(0);
    expect(harness.createdApprovals).toHaveLength(0);
  });

  it("rejects jobs missing tenant_id or transcript_text immediately", async () => {
    const harness = makeDeps();
    const processor = buildTranscriptProcessor(harness.deps);

    await expect(
      processor(makeJob({ tenant_id: "" as never })),
    ).rejects.toThrow(/tenant_id/);
    await expect(
      processor(makeJob({ transcript_text: undefined as never })),
    ).rejects.toThrow(/transcript_text/);
  });
});
