import { Inject, Injectable } from "@nestjs/common";
import { withTenant, type Db, type RetrievalService } from "@vex/db";
import type { AnthropicAdapter, OpenAIAdapter, ProposedAction } from "@vex/integrations";
import { QUERY_SYSTEM_PROMPT } from "@vex/agents";
import { TenantId, type AgentRunId } from "@vex/domain";
import { manifestFallback, validateManifest, type ViewManifest } from "@vex/ui";
import {
  ANTHROPIC_ADAPTER,
  DB_CLIENT,
  OPENAI_ADAPTER,
  RETRIEVAL_SERVICE,
} from "./tokens.js";

export interface RunQueryInput {
  tenantId: string;
  agentRunId?: AgentRunId;
  /** Idempotency key for the CostLedger entries; default = ULID at call site. */
  idempotencyKey: string;
  message: string;
}

export interface RunQueryOutput {
  answer: string;
  manifest: ViewManifest;
  proposedActions: ProposedAction[];
  evidenceRefs: string[];
  costUsd: number;
  cacheHit: boolean;
  manifestValid: boolean;
}

@Injectable()
export class QueryService {
  constructor(
    @Inject(DB_CLIENT) private readonly db: Db,
    @Inject(RETRIEVAL_SERVICE) private readonly retrieval: RetrievalService,
    @Inject(OPENAI_ADAPTER) private readonly openai: OpenAIAdapter,
    @Inject(ANTHROPIC_ADAPTER) private readonly anthropic: AnthropicAdapter,
  ) {}

  /**
   * End-to-end Vex query: resolve scope → embed → assemble pack → ask Claude
   * → validate manifest. Always returns a renderable manifest (uses
   * `manifestFallback` on validation failure). Always tenant-scoped via
   * `withTenant` so RLS isolates DB reads.
   *
   * Empty-workspace short-circuit: if the retrieved pack has zero
   * summaries AND zero items, we do NOT call Claude. We've seen Claude
   * produce a forbidden fallback phrase here regardless of the system
   * prompt's instructions, and a capabilities answer is deterministic
   * without the model. The answer is a fixed capabilities + onboarding
   * prose block; cost is zero.
   */
  async run(input: RunQueryInput): Promise<RunQueryOutput> {
    const tenantId = TenantId(input.tenantId);

    const embedding = await this.openai.embed(
      tenantId,
      `${input.idempotencyKey}:embed`,
      input.message,
    );

    const pack = await withTenant(this.db, input.tenantId, async (tx) =>
      this.retrieval.buildEvidencePack(tx, input.message, embedding),
    );

    // Short-circuit ONLY for plainly conversational openers (hello,
    // hi, help) AND only when the pack is empty. For substantive
    // questions with empty packs we still call Claude — the v5
    // prompt handles that case with a positive, jargon-free answer,
    // and the retrieval ILIKE fallback will usually have populated
    // the pack anyway once the workspace has records.
    if (
      pack.summaries.length === 0 &&
      pack.items.length === 0 &&
      isConversationalOpener(input.message)
    ) {
      return emptyWorkspaceResponse();
    }

    const queryResult = await this.anthropic.query({
      tenantId,
      ...(input.agentRunId !== undefined ? { agentRunId: input.agentRunId } : {}),
      idempotencyKey: input.idempotencyKey,
      systemPrompt: QUERY_SYSTEM_PROMPT,
      evidencePack: pack,
      userMessage: input.message,
    });

    const validated = validateManifest(queryResult.viewManifest);
    const manifest = validated.success ? validated.manifest : validated.fallback;

    const evidenceRefs = [
      ...pack.summaries.map((s) => s.chunk_id),
      ...pack.items.map((i) => i.chunk_id),
    ];

    // Deterministic limited-evidence prefix — the v5 prompt asks
    // Claude to add this when avg confidence < 0.5, but the model
    // sometimes skips it. Compute it server-side so the badge is
    // always present whenever the evidence shape warrants it.
    const cited = [...pack.summaries, ...pack.items];
    const avgConfidence =
      cited.length > 0
        ? cited.reduce((sum, item) => sum + item.confidence_score, 0) /
          cited.length
        : 1;
    const needsLimitedPrefix = cited.length > 0 && avgConfidence < 0.5;
    const PREFIX = "[Best current view — limited evidence] ";
    const rawAnswer = queryResult.answer || manifestFallbackText();
    const answer =
      needsLimitedPrefix && !rawAnswer.startsWith(PREFIX)
        ? `${PREFIX}${rawAnswer}`
        : rawAnswer;

    return {
      answer,
      manifest,
      proposedActions: queryResult.proposedActions,
      evidenceRefs,
      costUsd: queryResult.costUsd,
      cacheHit: queryResult.cacheReadTokens > 0,
      manifestValid: validated.success,
    };
  }
}

const EMPTY_WORKSPACE_ANSWER = [
  "I'm Vex — your revenue-intelligence analyst. I can analyze organizations, contacts, deals, and campaigns; assemble timelines; compute KPIs; and propose tiered actions (higher-risk actions wait for your approval).",
  "",
  "Your workspace doesn't have any records loaded yet. Once you create a few (via the + New buttons on the Companies, Contacts, and Deals pages — or the ingestion API), ask me things like:",
  "",
  "- Show me all deals with compliance holds",
  "- Summarise the last 30 days of activity for Acme",
  "- Which contacts at Initech are likely decision-makers?",
].join("\n");

/**
 * True iff the message reads as a plain greeting or help request
 * with no specific workspace intent. Keeps the empty-workspace
 * canned response focused on "hi"/"hello"/"what can you do" while
 * letting substantive queries fall through to Claude — where the v5
 * prompt handles the empty-evidence case with a positive answer.
 */
const CONVERSATIONAL_OPENERS = new Set([
  "hi",
  "hello",
  "hey",
  "help",
  "yo",
  "sup",
]);

function isConversationalOpener(message: string): boolean {
  const trimmed = message.trim().toLowerCase();
  if (trimmed.length === 0) return true;
  // Strip trailing punctuation.
  const clean = trimmed.replace(/[!?.,]+$/g, "");
  if (CONVERSATIONAL_OPENERS.has(clean)) return true;
  const phrases = [
    "what can you do",
    "what can you tell me",
    "what data do you have",
    "how does this work",
    "how do i start",
    "who are you",
    "what are you",
  ];
  return phrases.some((p) => clean === p || clean.startsWith(`${p} `));
}

function emptyWorkspaceResponse(): RunQueryOutput {
  return {
    answer: EMPTY_WORKSPACE_ANSWER,
    manifest: { panels: [] },
    proposedActions: [],
    evidenceRefs: [],
    costUsd: 0,
    cacheHit: false,
    manifestValid: true,
  };
}

function manifestFallbackText(): string {
  // Mirror the message manifestFallback uses for parity in the response.
  return manifestFallback("Vex couldn't compose a response.").panels[0]?.type === "table"
    ? "Vex couldn't compose a response."
    : "";
}
