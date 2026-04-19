import Anthropic from "@anthropic-ai/sdk";
import type { CostLedger, CostEntry } from "@vex/telemetry";
import type { AgentRunId, EvidencePack, TenantId } from "@vex/domain";
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

/** High-level query parameters. */
export interface QueryParams {
  tenantId: TenantId;
  agentRunId?: AgentRunId;
  idempotencyKey: string;
  systemPrompt: string;
  evidencePack: EvidencePack;
  userMessage: string;
  /** Default 2048. */
  maxTokens?: number;
}

/** Proposed action surfaced by the model alongside the answer. */
export interface ProposedAction {
  kind: string;
  tier: "T0" | "T1" | "T2" | "T3";
  payload: Record<string, unknown>;
  rationale?: string;
}

export interface QueryResult {
  answer: string;
  /** Raw JSON object — caller validates with `@vex/ui validateManifest`. */
  viewManifest: unknown;
  proposedActions: ProposedAction[];
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
}

/**
 * High-level Vex Anthropic adapter. Every call records to the CostLedger so
 * the "all LLM calls record cost" invariant holds. Use `query()` for the
 * canonical Vex prompt; `complete()` is exposed for other agent paths.
 */
export class AnthropicAdapter {
  private readonly client: Anthropic;
  private readonly model: keyof typeof pricing.anthropic;

  constructor(private readonly deps: AnthropicDeps) {
    this.client = new Anthropic({ apiKey: deps.apiKey });
    this.model = deps.model ?? "claude-sonnet-4-20250514";
  }

  /**
   * Run a Vex query. Prompt caching is applied to:
   *   - the system prompt (stable across calls within a session)
   *   - the rendered evidence pack (stable for retries on the same step)
   *
   * Cost is recorded immediately, including `cache_read_input_tokens` so
   * the ledger reflects the discounted spend.
   */
  async query(params: QueryParams): Promise<QueryResult> {
    const evidenceBlock = renderEvidencePack(params.evidencePack);

    // Anthropic SDK 0.27 doesn't yet expose `cache_control` on TextBlockParam
    // (prompt caching ships behind the anthropic-beta header). We cast at the
    // boundary so the SDK call compiles and the field reaches the wire.
    const systemBlocks = [
      { type: "text", text: params.systemPrompt, cache_control: { type: "ephemeral" } },
    ] as unknown as Anthropic.Messages.TextBlockParam[];
    const userContent = [
      { type: "text", text: evidenceBlock, cache_control: { type: "ephemeral" } },
      { type: "text", text: params.userMessage },
    ] as unknown as Anthropic.Messages.TextBlockParam[];

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: params.maxTokens ?? 2048,
      system: systemBlocks,
      messages: [{ role: "user", content: userContent }],
    });

    const usage = response.usage;
    const tokensIn = usage.input_tokens;
    const tokensOut = usage.output_tokens;
    const cacheReadTokens =
      (usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
    const cacheCreateTokens =
      (usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0;

    const inputCostMicros = tokensToUsdMicros(
      tokensIn,
      pricing.anthropic[this.model].inputUsdPerMillion,
    );
    const outputCostMicros = tokensToUsdMicros(
      tokensOut,
      pricing.anthropic[this.model].outputUsdPerMillion,
    );

    const occurredAt = new Date();
    const baseEntry = {
      tenantId: params.tenantId,
      provider: "anthropic",
      model: this.model,
      occurredAt,
      operation: "llm.completion" as const,
      ...(params.agentRunId !== undefined ? { agentRunId: params.agentRunId } : {}),
    };
    await this.deps.costLedger.record({
      ...baseEntry,
      idempotencyKey: `${params.idempotencyKey}:input`,
      units: tokensIn,
      unitKind: "input_tokens",
      costUsdMicros: inputCostMicros,
    } satisfies CostEntry);
    await this.deps.costLedger.record({
      ...baseEntry,
      idempotencyKey: `${params.idempotencyKey}:output`,
      units: tokensOut,
      unitKind: "output_tokens",
      costUsdMicros: outputCostMicros,
    } satisfies CostEntry);

    const fullText = response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();
    const { answer, viewManifest, proposedActions } = parseModelOutput(fullText);

    return {
      answer,
      viewManifest,
      proposedActions,
      tokensIn,
      tokensOut,
      cacheReadTokens,
      cacheCreateTokens,
      costUsd: (inputCostMicros + outputCostMicros) / 1_000_000,
    };
  }

  /**
   * Low-level completion. Used by callers that need raw control over the
   * SDK request shape (agent runs, action planners). Always records cost.
   */
  async complete(req: CompletionRequest): Promise<Anthropic.Messages.Message> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens,
      messages: req.messages,
      ...(req.system !== undefined ? { system: req.system } : {}),
    });

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const occurredAt = new Date();
    const prices = pricing.anthropic[this.model];

    const baseEntry = {
      tenantId: req.tenantId,
      operation: "llm.completion" as const,
      provider: "anthropic",
      model: this.model,
      occurredAt,
      ...(req.agentRunId !== undefined ? { agentRunId: req.agentRunId } : {}),
    };
    await this.deps.costLedger.record({
      ...baseEntry,
      idempotencyKey: `${req.idempotencyKey}:input`,
      units: inputTokens,
      unitKind: "input_tokens",
      costUsdMicros: tokensToUsdMicros(inputTokens, prices.inputUsdPerMillion),
    } satisfies CostEntry);
    await this.deps.costLedger.record({
      ...baseEntry,
      idempotencyKey: `${req.idempotencyKey}:output`,
      units: outputTokens,
      unitKind: "output_tokens",
      costUsdMicros: tokensToUsdMicros(outputTokens, prices.outputUsdPerMillion),
    } satisfies CostEntry);

    return response;
  }
}

/** Backwards-compatible factory used by Sprint 0/1 callers. */
export function createAnthropicClient(deps: AnthropicDeps) {
  const adapter = new AnthropicAdapter(deps);
  return {
    complete: adapter.complete.bind(adapter),
  };
}

/**
 * Parse the model's output into (answer text, view_manifest, proposed_actions).
 * The system prompt asks the model to follow the answer with a fenced JSON
 * block; if missing or malformed we hand back an empty manifest stub so
 * the ManifestValidator can produce its fallback.
 */
export function parseModelOutput(text: string): {
  answer: string;
  viewManifest: unknown;
  proposedActions: ProposedAction[];
} {
  const fenceMatch = /```(?:json)?\s*(\{[\s\S]+?\})\s*```/m.exec(text);
  if (!fenceMatch || !fenceMatch[1]) {
    return { answer: text.trim(), viewManifest: { panels: [] }, proposedActions: [] };
  }

  const before = text.slice(0, fenceMatch.index).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenceMatch[1]);
  } catch {
    return { answer: text.trim(), viewManifest: { panels: [] }, proposedActions: [] };
  }

  if (!isObject(parsed)) {
    return { answer: before, viewManifest: { panels: [] }, proposedActions: [] };
  }

  const viewManifest = parsed["view_manifest"] ?? { panels: [] };
  const rawActions = parsed["proposed_actions"];
  const proposedActions = Array.isArray(rawActions)
    ? (rawActions.filter(isProposedAction) as ProposedAction[])
    : [];

  return { answer: before, viewManifest, proposedActions };
}

/**
 * Render the evidence pack as a deterministic Markdown string. Stable
 * ordering keeps prompt caching effective across retries.
 */
export function renderEvidencePack(pack: EvidencePack): string {
  const lines: string[] = [];
  lines.push("# Evidence pack");
  lines.push(`Estimated tokens: ${pack.estimated_tokens}`);
  if (pack.summaries.length > 0) {
    lines.push("\n## Scope summaries");
    for (const s of pack.summaries) {
      lines.push(`### ${s.source_ref}`);
      lines.push(s.chunk_text);
    }
  }
  if (pack.items.length > 0) {
    lines.push("\n## Evidence items");
    for (const item of pack.items) {
      const occurred = item.occurred_at?.toISOString() ?? "unknown";
      lines.push(
        `### chunk_id=${item.chunk_id} type=${item.object_type} occurred_at=${occurred} confidence=${item.confidence_score.toFixed(2)} corroborated=${item.corroborated_by_count}`,
      );
      lines.push(item.chunk_text);
    }
  }
  if (pack.campaigns && pack.campaigns.length > 0) {
    lines.push("\n## Campaigns catalog");
    lines.push(
      "Existing campaign plans the agent can enroll contacts into via " +
        "`campaign.enroll_batch`. Pick by name/channel fit — NEVER invent ids.",
    );
    for (const c of pack.campaigns) {
      lines.push(
        `- id=${c.id} name=${JSON.stringify(c.name)} channels=[${c.channels.join(", ")}] steps=${c.step_count}${c.tier ? ` tier=${c.tier}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isProposedAction(x: unknown): x is ProposedAction {
  if (!isObject(x)) return false;
  if (typeof x["kind"] !== "string") return false;
  if (!["T0", "T1", "T2", "T3"].includes(x["tier"] as string)) return false;
  return isObject(x["payload"] ?? {});
}
