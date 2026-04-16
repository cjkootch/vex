import Anthropic from "@anthropic-ai/sdk";
import type { CostLedger, CostEntry } from "@vex/telemetry";
import type { TenantId, AgentRunId } from "@vex/domain";
import { pricing, tokensToUsdMicros } from "./pricing.js";

export interface AnthropicDeps {
  apiKey: string;
  /** Pinned reasoning model; defaults to the Sprint 0 target. */
  model?: keyof typeof pricing.anthropic;
  costLedger: CostLedger;
}

export interface CompletionRequest {
  tenantId: TenantId;
  agentRunId?: AgentRunId;
  /** Idempotency key for the CostLedger; typically the agent step id. */
  idempotencyKey: string;
  messages: Anthropic.Messages.MessageParam[];
  system?: string;
  maxTokens: number;
}

/**
 * Thin wrapper around the Anthropic SDK that enforces the "every LLM call
 * records to CostLedger" invariant. All callers in @vex/agents must go
 * through this — never construct `new Anthropic()` directly in app code.
 */
export function createAnthropicClient(deps: AnthropicDeps) {
  const client = new Anthropic({ apiKey: deps.apiKey });
  const model = deps.model ?? "claude-sonnet-4-20250514";
  const prices = pricing.anthropic[model];

  return {
    async complete(req: CompletionRequest): Promise<Anthropic.Messages.Message> {
      const response = await client.messages.create({
        model,
        max_tokens: req.maxTokens,
        messages: req.messages,
        ...(req.system !== undefined ? { system: req.system } : {}),
      });

      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const occurredAt = new Date();

      const baseEntry = {
        tenantId: req.tenantId,
        operation: "llm.completion" as const,
        provider: "anthropic",
        model,
        occurredAt,
        ...(req.agentRunId !== undefined ? { agentRunId: req.agentRunId } : {}),
      };

      const inputEntry: CostEntry = {
        ...baseEntry,
        idempotencyKey: `${req.idempotencyKey}:input`,
        units: inputTokens,
        unitKind: "input_tokens",
        costUsdMicros: tokensToUsdMicros(inputTokens, prices.inputUsdPerMillion),
      };
      const outputEntry: CostEntry = {
        ...baseEntry,
        idempotencyKey: `${req.idempotencyKey}:output`,
        units: outputTokens,
        unitKind: "output_tokens",
        costUsdMicros: tokensToUsdMicros(outputTokens, prices.outputUsdPerMillion),
      };

      await deps.costLedger.record(inputEntry);
      await deps.costLedger.record(outputEntry);

      return response;
    },
  };
}
