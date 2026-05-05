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
  /**
   * Tools the model can invoke mid-turn (e.g. `research_contact`).
   * When provided, the query runs a short tool-use loop: model may
   * emit `tool_use` blocks; we execute them via `toolRunner`, feed
   * the results back, and continue until the model returns a final
   * text-only turn (or we hit `maxToolIterations`).
   */
  tools?: ToolDefinition[];
  toolRunner?: ToolRunner;
  /** Default 3. Safety cap against runaway tool loops. */
  maxToolIterations?: number;
  /**
   * Fired before each tool invocation so callers can stream a UI
   * indicator ("Searching Apollo…") to the client. Errors thrown by
   * the callback are swallowed — never block the tool loop on UI work.
   */
  onToolUse?: (name: string, input: Record<string, unknown>) => void;
  /**
   * Fired after each tool invocation completes (or errors). `ok=false`
   * when the tool threw.
   */
  onToolDone?: (name: string, ok: boolean) => void;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type ToolRunner = (
  name: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

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

    const messages: Anthropic.Messages.MessageParam[] = [
      { role: "user", content: userContent },
    ];
    const maxIter = Math.max(1, params.maxToolIterations ?? 3);
    let tokensIn = 0;
    let tokensOut = 0;
    let cacheReadTokens = 0;
    let cacheCreateTokens = 0;
    let finalContent: Anthropic.Messages.ContentBlock[] = [];
    for (let iter = 0; iter < maxIter; iter += 1) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: params.maxTokens ?? 2048,
        system: systemBlocks,
        messages,
        ...(params.tools && params.tools.length > 0
          ? { tools: params.tools as unknown as Anthropic.Messages.Tool[] }
          : {}),
      });

      const usage = response.usage;
      tokensIn += usage.input_tokens;
      tokensOut += usage.output_tokens;
      cacheReadTokens +=
        (usage as { cache_read_input_tokens?: number })
          .cache_read_input_tokens ?? 0;
      cacheCreateTokens +=
        (usage as { cache_creation_input_tokens?: number })
          .cache_creation_input_tokens ?? 0;

      finalContent = response.content;
      const toolUses = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
      );
      if (
        response.stop_reason !== "tool_use" ||
        toolUses.length === 0 ||
        !params.toolRunner
      ) {
        break;
      }

      // Append the model's tool-use turn + run each tool, then add
      // all tool_result blocks as a single user message so the model
      // can synthesise a final answer grounded in the outputs.
      messages.push({ role: "assistant", content: response.content });
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const input = (use.input ?? {}) as Record<string, unknown>;
        try {
          params.onToolUse?.(use.name, input);
        } catch {
          // UI callbacks must never break the tool loop.
        }
        try {
          const out = await params.toolRunner(use.name, input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: use.id,
            content:
              typeof out === "string" ? out : JSON.stringify(out, null, 2),
          });
          try {
            params.onToolDone?.(use.name, true);
          } catch {
            // UI callback errors are non-fatal.
          }
        } catch (err) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: use.id,
            is_error: true,
            content: `tool ${use.name} failed: ${(err as Error).message}`,
          });
          try {
            params.onToolDone?.(use.name, false);
          } catch {
            // UI callback errors are non-fatal.
          }
        }
      }
      messages.push({ role: "user", content: toolResults });
    }

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

    const fullText = finalContent
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
  if (pack.aggregates) {
    lines.push("\n## Workspace aggregates");
    lines.push(
      "Pre-computed roll-ups for comparative / totals questions. Quote the " +
        "numbers here when the user asks 'how many open deals', 'which " +
        "product has the best margin', 'show me pipeline by status' — " +
        "don't re-derive from item lists.",
    );
    const agg = pack.aggregates;
    lines.push(
      `- Pipeline totals: open=${agg.pipeline.totals.open_deal_count} closed_won=${agg.pipeline.totals.closed_won_deal_count} compliance_hold=${agg.pipeline.totals.compliance_hold_count}`,
    );
    for (const row of agg.pipeline.by_status) {
      lines.push(
        `- Status ${row.status}: ${row.deal_count} deal(s), ${Math.round(row.total_volume_usg).toLocaleString()} USG, revenue≈$${row.total_revenue_usd.toLocaleString()}`,
      );
    }
    for (const row of agg.pipeline.by_product) {
      const margin =
        row.avg_margin_pct === null
          ? "n/a"
          : `${(row.avg_margin_pct * 100).toFixed(1)}%`;
      lines.push(
        `- Product ${row.product}: ${row.deal_count} deal(s), ${Math.round(row.total_volume_usg).toLocaleString()} USG, avg margin ${margin}`,
      );
    }
    if (agg.pipeline.by_line_of_business.length > 0) {
      for (const row of agg.pipeline.by_line_of_business) {
        lines.push(
          `- Line ${row.line_of_business}: ${row.deal_count} deal(s), ${Math.round(row.total_volume_usg).toLocaleString()} quantity`,
        );
      }
    }
    if (agg.signals.open_total > 0) {
      lines.push(
        `- Open signals: ${agg.signals.open_total} (${agg.signals.by_severity.map((s) => `${s.severity}=${s.count}`).join(", ")})`,
      );
      for (const r of agg.signals.by_rule) {
        lines.push(`  · ${r.rule_id}: ${r.count}`);
      }
    }
    if (agg.top_counterparties.length > 0) {
      lines.push("- Top counterparties (deals in last 90d):");
      for (const c of agg.top_counterparties) {
        lines.push(
          `  · org=${c.org_id} name=${JSON.stringify(c.name)} deals=${c.deal_count}${c.latest_deal_ref ? ` latest=${c.latest_deal_ref}` : ""}`,
        );
      }
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
