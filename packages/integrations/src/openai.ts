import OpenAI from "openai";
import type { CostLedger } from "@vex/telemetry";
import type { TenantId } from "@vex/domain";
import { pricing, tokensToUsdMicros } from "./pricing.js";

export interface OpenAIDeps {
  apiKey: string;
  embeddingModel?: keyof typeof pricing.openai;
  costLedger: CostLedger;
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
  private readonly embeddingModel: keyof typeof pricing.openai;

  constructor(private readonly deps: OpenAIDeps) {
    this.client = new OpenAI({ apiKey: deps.apiKey });
    this.embeddingModel = deps.embeddingModel ?? "text-embedding-3-small";
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
