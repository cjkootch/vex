import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";
import { withTenant, type Db } from "@vex/db";
import {
  VOICE_REALTIME_SYSTEM_PROMPT,
  addTranscriptJob,
  renderVoiceContext,
  type TranscriptJobData,
  type VoiceContextBuilder,
} from "@vex/agents";
import { TenantId, createId } from "@vex/domain";
import type { OpenAIAdapter } from "@vex/integrations";
import {
  VOICE_CONTEXT_BUILDER,
  VOICE_DB_CLIENT,
  VOICE_OPENAI_ADAPTER,
  VOICE_SESSION_STORE,
  VOICE_TRANSCRIPT_QUEUE,
} from "./tokens.js";
import type { VoiceSessionRecord, VoiceSessionStore } from "./voice-session-store.js";

export interface StartSessionInput {
  tenantId: string;
  workspaceId: string;
  userId: string;
  orgId: string | null;
  contactId: string | null;
}

export interface StartSessionOutput {
  sessionId: string;
  ephemeralToken: string;
  expiresAt: number;
  model: string;
  /** Compact brief shown in the UI before the call starts. */
  voiceContextBrief: string;
  voiceContextTokens: number;
}

export interface EndSessionInput {
  tenantId: string;
  workspaceId: string;
  sessionId: string;
  transcriptText: string;
  durationSeconds: number;
  inputAudioTokens?: number;
  outputAudioTokens?: number;
  inputTextTokens?: number;
  outputTextTokens?: number;
}

@Injectable()
export class VoiceService {
  constructor(
    @Inject(VOICE_DB_CLIENT) private readonly db: Db,
    @Inject(VOICE_OPENAI_ADAPTER) private readonly openai: OpenAIAdapter,
    @Inject(VOICE_SESSION_STORE) private readonly sessions: VoiceSessionStore,
    @Inject(VOICE_CONTEXT_BUILDER)
    private readonly builder: VoiceContextBuilder,
    @Inject(VOICE_TRANSCRIPT_QUEUE)
    private readonly transcriptQueue: Queue<TranscriptJobData>,
  ) {}

  async start(input: StartSessionInput): Promise<StartSessionOutput> {
    const context = await withTenant(this.db, input.tenantId, (tx) =>
      this.builder.build(tx, {
        orgId: input.orgId,
        contactId: input.contactId,
      }),
    );
    const brief = renderVoiceContext(context);

    const token = await this.openai.createRealtimeEphemeralToken({
      tenantId: TenantId(input.tenantId),
      idempotencyKey: `voice.ephemeral:${createId()}`,
      instructions: `${VOICE_REALTIME_SYSTEM_PROMPT}\n\n${brief}`,
    });

    const record: VoiceSessionRecord = {
      sessionId: token.sessionId,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      orgId: input.orgId,
      contactId: input.contactId,
      createdAt: Date.now(),
      expiresAt: token.expiresAt * 1000,
      status: "active",
    };
    await this.sessions.create(record);

    return {
      sessionId: token.sessionId,
      ephemeralToken: token.ephemeralToken,
      expiresAt: token.expiresAt,
      model: token.model,
      voiceContextBrief: brief,
      voiceContextTokens: context.totalEstimatedTokens,
    };
  }

  async end(input: EndSessionInput): Promise<{ sessionId: string; status: "processing" }> {
    const existing = await this.sessions.get(input.sessionId);
    if (!existing) throw new NotFoundException("voice_session_not_found");
    if (existing.tenantId !== input.tenantId) {
      throw new NotFoundException("voice_session_not_found");
    }

    await this.sessions.update(input.sessionId, {
      status: "processing",
      endedAt: Date.now(),
    });

    await addTranscriptJob(this.transcriptQueue, {
      session_id: input.sessionId,
      tenant_id: input.tenantId,
      workspace_id: input.workspaceId,
      ...(existing.orgId ? { org_id: existing.orgId } : {}),
      ...(existing.contactId ? { contact_id: existing.contactId } : {}),
      transcript_text: input.transcriptText,
      duration_seconds: input.durationSeconds,
      ...(input.inputAudioTokens !== undefined
        ? { input_audio_tokens: input.inputAudioTokens }
        : {}),
      ...(input.outputAudioTokens !== undefined
        ? { output_audio_tokens: input.outputAudioTokens }
        : {}),
      ...(input.inputTextTokens !== undefined
        ? { input_text_tokens: input.inputTextTokens }
        : {}),
      ...(input.outputTextTokens !== undefined
        ? { output_text_tokens: input.outputTextTokens }
        : {}),
    });

    return { sessionId: input.sessionId, status: "processing" };
  }

  async detail(tenantId: string, sessionId: string): Promise<VoiceSessionRecord> {
    const record = await this.sessions.get(sessionId);
    if (!record || record.tenantId !== tenantId) {
      throw new NotFoundException("voice_session_not_found");
    }
    return record;
  }
}
