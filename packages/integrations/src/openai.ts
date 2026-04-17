import OpenAI from "openai";
import type { CostLedger } from "@vex/telemetry";
import type { TenantId } from "@vex/domain";
import { pricing, tokensToUsdMicros } from "./pricing.js";

export interface OpenAIDeps {
  apiKey: string;
  embeddingModel?: keyof typeof pricing.openai;
  /** Pinned realtime model. Defaults to the Sprint 9 target. */
  realtimeModel?: keyof typeof pricing.openaiRealtime;
  costLedger: CostLedger;
}

export interface RealtimeTokenRequest {
  tenantId: TenantId;
  /** Stable idempotency key for the cost-ledger audit row. */
  idempotencyKey: string;
  /** System prompt / behavior for the realtime agent. */
  instructions: string;
  /** Voice alias — "verse" is the Sprint 9 default. */
  voice?: string;
}

export interface RealtimeTokenResponse {
  /** The ephemeral session id from OpenAI. */
  sessionId: string;
  /** Ephemeral client_secret. Expires ~60s after creation. Safe for the browser. */
  ephemeralToken: string;
  /** Epoch seconds the token becomes invalid. */
  expiresAt: number;
  /** The pinned model the browser must connect with. */
  model: string;
}

export interface EmbedRequest {
  tenantId: TenantId;
  /** Idempotency key for the CostLedger entry. */
  idempotencyKey: string;
  input: string | readonly string[];
}

/**
 * High-level OpenAI adapter. Every call records to the CostLedger so the
 * "all LLM calls record cost" invariant holds. Use `OpenAIAdapter` from
 * application code; tests can swap in `InMemoryCostLedger`.
 */
export class OpenAIAdapter {
  readonly client: OpenAI;
  private readonly apiKey: string;
  private readonly embeddingModel: keyof typeof pricing.openai;
  private readonly realtimeModel: keyof typeof pricing.openaiRealtime;

  constructor(private readonly deps: OpenAIDeps) {
    this.client = new OpenAI({ apiKey: deps.apiKey });
    this.apiKey = deps.apiKey;
    this.embeddingModel = deps.embeddingModel ?? "text-embedding-3-small";
    this.realtimeModel = deps.realtimeModel ?? "gpt-4o-realtime-preview-2024-12-17";
  }

  get realtimeModelId(): string {
    return this.realtimeModel;
  }

  /**
   * Embed a single string. Returns a 1536-dim float vector for the default
   * `text-embedding-3-small` model.
   */
  async embed(tenantId: TenantId, idempotencyKey: string, text: string): Promise<number[]> {
    const [vec] = await this.embedBatch(tenantId, idempotencyKey, [text]);
    if (!vec) throw new Error("OpenAI returned no embedding");
    return vec;
  }

  async embedBatch(
    tenantId: TenantId,
    idempotencyKey: string,
    inputs: readonly string[],
  ): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.embeddingModel,
      input: [...inputs],
    });

    const inputTokens = response.usage.total_tokens;
    const prices = pricing.openai[this.embeddingModel];
    await this.deps.costLedger.record({
      idempotencyKey,
      tenantId,
      operation: "llm.embedding",
      provider: "openai",
      model: this.embeddingModel,
      units: inputTokens,
      unitKind: "input_tokens",
      costUsdMicros: tokensToUsdMicros(inputTokens, prices.inputUsdPerMillion),
      occurredAt: new Date(),
    });

    return response.data.map((d) => d.embedding);
  }

  /**
   * Mint an ephemeral session token for the OpenAI Realtime API.
   *
   * The browser connects to OpenAI directly over WebRTC using this token —
   * the permanent OPENAI_API_KEY must NEVER reach the browser. The token
   * expires ~60s after creation, so `/voice/sessions` is always a fresh
   * mint (no caching).
   *
   * Records a zero-cost audit row on the CostLedger so the voice session
   * is traceable; per-turn audio cost is booked by the TranscriptProcessor
   * after the session ends and OpenAI reports usage.
   */
  async createRealtimeEphemeralToken(
    req: RealtimeTokenRequest,
  ): Promise<RealtimeTokenResponse> {
    const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "openai-beta": "realtime=v1",
      },
      body: JSON.stringify({
        model: this.realtimeModel,
        voice: req.voice ?? "verse",
        instructions: req.instructions,
        modalities: ["audio", "text"],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `OpenAI realtime session mint failed: ${response.status} ${body.slice(0, 200)}`,
      );
    }

    const json = (await response.json()) as {
      id: string;
      client_secret?: { value: string; expires_at: number };
    };
    if (!json.client_secret?.value) {
      throw new Error("OpenAI realtime response missing client_secret.value");
    }

    await this.deps.costLedger.record({
      idempotencyKey: req.idempotencyKey,
      tenantId: req.tenantId,
      operation: "llm.voice",
      provider: "openai",
      model: this.realtimeModel,
      units: 1,
      unitKind: "session_create",
      costUsdMicros: 0,
      occurredAt: new Date(),
    });

    return {
      sessionId: json.id,
      ephemeralToken: json.client_secret.value,
      expiresAt: json.client_secret.expires_at,
      model: this.realtimeModel,
    };
  }

  /**
   * Record cost for realtime audio usage reported post-session. Splits the
   * usage record into input/output entries so the ledger preserves the
   * per-direction accounting the per-token ledgers use everywhere else.
   */
  async recordRealtimeUsage(args: {
    tenantId: TenantId;
    idempotencyKey: string;
    inputAudioTokens: number;
    outputAudioTokens: number;
    inputTextTokens: number;
    outputTextTokens: number;
  }): Promise<number> {
    const prices = pricing.openaiRealtime[this.realtimeModel];
    const audioIn = tokensToUsdMicros(args.inputAudioTokens, prices.audioInputUsdPerMillion);
    const audioOut = tokensToUsdMicros(args.outputAudioTokens, prices.audioOutputUsdPerMillion);
    const textIn = tokensToUsdMicros(args.inputTextTokens, prices.textInputUsdPerMillion);
    const textOut = tokensToUsdMicros(args.outputTextTokens, prices.textOutputUsdPerMillion);

    const occurredAt = new Date();
    const entries = [
      { key: "audio_in", units: args.inputAudioTokens, kind: "input_audio_tokens", micros: audioIn },
      { key: "audio_out", units: args.outputAudioTokens, kind: "output_audio_tokens", micros: audioOut },
      { key: "text_in", units: args.inputTextTokens, kind: "input_tokens", micros: textIn },
      { key: "text_out", units: args.outputTextTokens, kind: "output_tokens", micros: textOut },
    ];
    for (const e of entries) {
      if (e.units <= 0) continue;
      await this.deps.costLedger.record({
        idempotencyKey: `${args.idempotencyKey}:${e.key}`,
        tenantId: args.tenantId,
        operation: "llm.voice",
        provider: "openai",
        model: this.realtimeModel,
        units: e.units,
        unitKind: e.kind,
        costUsdMicros: e.micros,
        occurredAt,
      });
    }

    return (audioIn + audioOut + textIn + textOut) / 1_000_000;
  }
}

/** Backwards-compatible factory used by Sprint 0/1 callers. */
export function createOpenAIClient(deps: OpenAIDeps) {
  const adapter = new OpenAIAdapter(deps);
  return {
    client: adapter.client,
    async embed(req: EmbedRequest): Promise<number[][]> {
      const inputs = typeof req.input === "string" ? [req.input] : [...req.input];
      return adapter.embedBatch(req.tenantId, req.idempotencyKey, inputs);
    },
  };
}
