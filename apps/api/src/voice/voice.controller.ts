import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";
import { VoiceService } from "./voice.service.js";

const StartBody = z.object({
  org_id: z.string().optional(),
  contact_id: z.string().optional(),
});

const EndBody = z.object({
  transcript_text: z.string(),
  duration_seconds: z.number().int().nonnegative(),
  input_audio_tokens: z.number().int().nonnegative().optional(),
  output_audio_tokens: z.number().int().nonnegative().optional(),
  input_text_tokens: z.number().int().nonnegative().optional(),
  output_text_tokens: z.number().int().nonnegative().optional(),
});

@Controller("voice")
@UseGuards(JwtAuthGuard)
export class VoiceController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(VoiceService) private readonly voice: VoiceService,
  ) {}

  /**
   * POST /voice/sessions — mint an ephemeral realtime token + open a
   * server-side session record. The browser uses the returned token to
   * connect to OpenAI directly over WebRTC. The permanent OPENAI_API_KEY
   * never leaves the server.
   */
  @Post("sessions")
  async start(@Body() raw: unknown) {
    const body = StartBody.parse(raw ?? {});
    const result = await this.voice.start({
      tenantId: this.tenant.tenantId,
      workspaceId: this.tenant.workspaceId,
      userId: this.tenant.userId,
      orgId: body.org_id ?? null,
      contactId: body.contact_id ?? null,
    });
    return {
      session_id: result.sessionId,
      ephemeral_token: result.ephemeralToken,
      expires_at: result.expiresAt,
      model: result.model,
      voice_context_brief: result.voiceContextBrief,
      voice_context_tokens: result.voiceContextTokens,
    };
  }

  /**
   * POST /voice/sessions/:id/end — caller hands over the transcript text
   * and we enqueue TranscriptProcessor. The job is idempotent — replaying
   * the same session_id is safe.
   */
  @Post("sessions/:id/end")
  async end(@Param("id") id: string, @Body() raw: unknown) {
    const body = EndBody.parse(raw ?? {});
    const result = await this.voice.end({
      tenantId: this.tenant.tenantId,
      workspaceId: this.tenant.workspaceId,
      sessionId: id,
      transcriptText: body.transcript_text,
      durationSeconds: body.duration_seconds,
      ...(body.input_audio_tokens !== undefined
        ? { inputAudioTokens: body.input_audio_tokens }
        : {}),
      ...(body.output_audio_tokens !== undefined
        ? { outputAudioTokens: body.output_audio_tokens }
        : {}),
      ...(body.input_text_tokens !== undefined
        ? { inputTextTokens: body.input_text_tokens }
        : {}),
      ...(body.output_text_tokens !== undefined
        ? { outputTextTokens: body.output_text_tokens }
        : {}),
    });
    return { session_id: result.sessionId, status: result.status };
  }

  /**
   * POST /voice/transcribe — one-shot Whisper transcription for short
   * clips recorded in the chat composer's mic button. Accepts a single
   * audio part via multipart/form-data; returns { text, duration_seconds }.
   */
  @Post("transcribe")
  async transcribe(@Req() req: FastifyRequest): Promise<{
    text: string;
    duration_seconds: number;
  }> {
    if (!req.isMultipart()) {
      throw new BadRequestException("expected multipart/form-data");
    }
    let body: Buffer | null = null;
    let filename = "clip.webm";
    let mimeType = "audio/webm";
    for await (const part of req.parts()) {
      if (part.type === "file" && part.fieldname === "audio") {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) chunks.push(chunk as Buffer);
        body = Buffer.concat(chunks);
        if (part.filename) filename = part.filename;
        if (part.mimetype) mimeType = part.mimetype;
      }
    }
    if (!body) throw new BadRequestException("missing audio part");
    const result = await this.voice.transcribe({
      tenantId: this.tenant.tenantId,
      audio: body,
      filename,
      mimeType,
    });
    return { text: result.text, duration_seconds: result.durationSeconds };
  }

  @Get("sessions/:id")
  async detail(@Param("id") id: string) {
    const record = await this.voice.detail(this.tenant.tenantId, id);
    return {
      session_id: record.sessionId,
      status: record.status,
      org_id: record.orgId,
      contact_id: record.contactId,
      created_at: record.createdAt,
      ended_at: record.endedAt ?? null,
      activity_id: record.activityId ?? null,
    };
  }
}
