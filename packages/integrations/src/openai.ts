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
  idempotencyKey: string;
  input: string | readonly string[];
}

export function createOpenAIClient(deps: OpenAIDeps) {
  const client = new OpenAI({ apiKey: deps.apiKey });
  const embeddingModel = deps.embeddingModel ?? "text-embedding-3-small";
  const embeddingPrices = pricing.openai[embeddingModel];

  return {
    client,
    async embed(req: EmbedRequest): Promise<number[][]> {
      const response = await client.embeddings.create({
        model: embeddingModel,
        input: req.input as string | string[],
      });

      const inputTokens = response.usage.total_tokens;
      await deps.costLedger.record({
        idempotencyKey: req.idempotencyKey,
        tenantId: req.tenantId,
        operation: "llm.embedding",
        provider: "openai",
        model: embeddingModel,
        units: inputTokens,
        unitKind: "input_tokens",
        costUsdMicros: tokensToUsdMicros(inputTokens, embeddingPrices.inputUsdPerMillion),
        occurredAt: new Date(),
      });

      return response.data.map((d) => d.embedding);
    },
  };
}
