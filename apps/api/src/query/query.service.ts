import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  ApprovalRepository,
  EventRepository,
  withTenant,
  WorkspaceRepository,
  type Db,
  type RetrievalService,
} from "@vex/db";
import type {
  AnthropicAdapter,
  OpenAIAdapter,
  ProposedAction,
  TavilyClient,
  ToolDefinition,
  ToolRunner,
} from "@vex/integrations";
import { QUERY_SYSTEM_PROMPT, renderStrategyPreamble, ActionDescriptor } from "@vex/agents";
import { createId, TenantId, type AgentRunId } from "@vex/domain";
import { manifestFallback, validateManifest, type ViewManifest } from "@vex/ui";
import type { CostLedger } from "@vex/telemetry";
import { pricing, unitsToUsdMicros } from "@vex/integrations";
import {
  ANTHROPIC_ADAPTER,
  COST_LEDGER,
  DB_CLIENT,
  OPENAI_ADAPTER,
  RETRIEVAL_SERVICE,
  TAVILY_CLIENT,
} from "./tokens.js";

export interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
}

export interface RunQueryInput {
  tenantId: string;
  agentRunId?: AgentRunId;
  /** Idempotency key for the CostLedger entries; default = ULID at call site. */
  idempotencyKey: string;
  message: string;
  /**
   * Prior turns from the same chat thread (oldest → newest). Used to
   * (a) seed the retrieval query so name-match fallbacks find entities
   * referenced earlier, and (b) give Claude a short window of context
   * for follow-up questions like "change this status to won".
   */
  history?: HistoryTurn[];
  /**
   * Sprint T — subject-scoped chat. When the operator clicks "Ask Vex"
   * from a contact/deal/organization/campaign page or opens the floating
   * widget while on one of those subjects, the scope is passed through
   * and the retrieval service pins the subject's full context at the
   * top of the evidence pack regardless of embedding-score rank. Every
   * answer in the session is thereby biased toward the subject unless
   * the operator explicitly clears the scope (X on the chip).
   */
  scope?: {
    type: "contact" | "deal" | "organization" | "campaign";
    id: string;
  };
}

export interface CreatedApproval {
  approvalId: string;
  actionType: string;
  tier: string;
}

export interface RejectedProposal {
  /** e.g. "outbound_call", "crm.create_deal". */
  actionType: string;
  tier: string;
  /** Human-readable zod failure(s), joined with "; ". */
  reason: string;
}

export interface RunQueryOutput {
  answer: string;
  manifest: ViewManifest;
  proposedActions: ProposedAction[];
  /**
   * Approvals that were persisted server-side for T2+ proposals in
   * this turn. Returned so the chat UI can render Approve/Reject
   * chips inline instead of forcing the operator to /app/approvals.
   */
  createdApprovals: CreatedApproval[];
  /**
   * T2+ proposals Claude emitted that failed ActionDescriptor
   * validation (e.g. contactId isn't a ULID, toNumber isn't E.164).
   * Surfaced to the UI so the operator sees a muted "Claude tried
   * to propose X but the shape was invalid: …" chip instead of
   * silent nothing, which used to read like Vex ignored the
   * request.
   */
  rejectedProposals: RejectedProposal[];
  evidenceRefs: string[];
  costUsd: number;
  cacheHit: boolean;
  manifestValid: boolean;
}

/** T2+ chat proposals become pending approvals; T0/T1 stay informational. */
const APPROVAL_TIERS = new Set(["T2", "T3"]);

@Injectable()
export class QueryService {
  private readonly log = new Logger(QueryService.name);
  private readonly workspaces = new WorkspaceRepository();
  private readonly approvals = new ApprovalRepository();
  private readonly events = new EventRepository();

  constructor(
    @Inject(DB_CLIENT) private readonly db: Db,
    @Inject(RETRIEVAL_SERVICE) private readonly retrieval: RetrievalService,
    @Inject(OPENAI_ADAPTER) private readonly openai: OpenAIAdapter,
    @Inject(ANTHROPIC_ADAPTER) private readonly anthropic: AnthropicAdapter,
    @Inject(TAVILY_CLIENT) private readonly tavily: TavilyClient | null,
    @Inject(COST_LEDGER) private readonly costLedger: CostLedger,
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

    // Build a context-aware retrieval query so follow-ups like
    // "change this status to won" — which on their own contain no
    // entity reference — still surface the deal mentioned a turn ago.
    const retrievalQuery = buildRetrievalQuery(input.message, input.history);

    const embedding = await this.openai.embed(
      tenantId,
      `${input.idempotencyKey}:embed`,
      retrievalQuery,
    );

    const pack = await withTenant(this.db, input.tenantId, async (tx) =>
      this.retrieval.buildEvidencePack(tx, retrievalQuery, embedding, {
        ...(input.scope ? { pinned: input.scope } : {}),
      }),
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

    const tools: ToolDefinition[] = this.tavily
      ? [
          {
            name: "research_contact",
            description:
              "Search the public web for details about a person — likely title, work email, phone, LinkedIn profile. Use only when the user asks you to enrich a contact, or when proposing crm.create_contact with missing optional fields. Returns raw search snippets; the model extracts candidates and cites sources.",
            input_schema: {
              type: "object",
              properties: {
                fullName: {
                  type: "string",
                  description: "Person's name as the user stated it.",
                },
                orgName: {
                  type: "string",
                  description:
                    "Company / organisation they work at. Improves result quality significantly.",
                },
                context: {
                  type: "string",
                  description:
                    "Free-text context (role hints, industry, location) — appended to the search query.",
                },
              },
              required: ["fullName"],
            },
          },
        ]
      : [];

    const toolRunner: ToolRunner = async (name, input) => {
      if (name !== "research_contact" || !this.tavily) {
        return { error: `tool ${name} not available` };
      }
      const fullName = typeof input["fullName"] === "string" ? input["fullName"] : "";
      const orgName = typeof input["orgName"] === "string" ? input["orgName"] : "";
      const context = typeof input["context"] === "string" ? input["context"] : "";
      const q = [fullName, orgName, context, "email title linkedin"]
        .filter((s) => s.length > 0)
        .join(" ");
      const result = await this.tavily.search(q, {
        depth: "basic",
        maxResults: 5,
        includeAnswer: true,
      });
      // Record Tavily search cost on the ledger. Basic search ≈ 1
      // credit ≈ $0.0045 on the default plan. Idempotency key
      // includes the query-hash + current ISO minute so retries of
      // the same tool call inside one turn don't double-charge.
      await this.costLedger.record({
        idempotencyKey: `web.search:${input.idempotencyKey}:${q.slice(0, 32)}`,
        tenantId,
        operation: "web.search",
        provider: "tavily",
        units: 1,
        unitKind: "search",
        costUsdMicros: unitsToUsdMicros(1, pricing.tavily.searchBasicUsd),
        occurredAt: new Date(),
      });
      return {
        query: q,
        answer: result.answer,
        results: result.results.map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.content.slice(0, 800),
        })),
      };
    };

    // Sprint S — prepend the tenant's operator-authored strategy
    // so every answer, drafted email, and proposed action is
    // conditioned on company context (mission, ICP, brand voice,
    // no-go zones, growth priorities). Empty strategy → empty
    // preamble → prompt is the vanilla QUERY_SYSTEM_PROMPT.
    const strategy = await this.workspaces.getStrategy(this.db, tenantId);
    const preamble = renderStrategyPreamble(strategy);
    const systemPrompt = preamble
      ? `${preamble}${QUERY_SYSTEM_PROMPT}`
      : QUERY_SYSTEM_PROMPT;

    const queryResult = await this.anthropic.query({
      tenantId,
      ...(input.agentRunId !== undefined ? { agentRunId: input.agentRunId } : {}),
      idempotencyKey: input.idempotencyKey,
      systemPrompt,
      evidencePack: pack,
      userMessage: composeUserMessage(input.message, input.history),
      ...(tools.length > 0 ? { tools, toolRunner } : {}),
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

    // Persist T2+ proposals as pending approvals so the chat-proposed
    // side effects (email.send, crm.create_deal, outbound_call, etc.)
    // actually land in /app/approvals where the operator can review
    // and fire them. Until this existed, Claude would prose-say
    // "I'll set up the call" without any row ever reaching the DB
    // and the approval-executor worker had nothing to act on.
    const normalizedActions = enforceAiModeWhenVexIsTheCaller(
      queryResult.proposedActions,
      input.message,
    );
    // Multi-action requests land as one approval, not N. The operator
    // reviews the checklist as a single card and can per-item uncheck
    // anything they want to skip before approving.
    const bundledActions = bundleActionsIfMultiple(normalizedActions);
    const { created: createdApprovals, rejected: rejectedProposals } =
      await this.persistProposedActions(
        tenantId,
        input.agentRunId,
        bundledActions,
      );

    return {
      answer,
      manifest,
      proposedActions: queryResult.proposedActions,
      createdApprovals,
      rejectedProposals,
      evidenceRefs,
      costUsd: queryResult.costUsd,
      cacheHit: queryResult.cacheReadTokens > 0,
      manifestValid: validated.success,
    };
  }

  /**
   * For each T2+ proposed action, write an `approvals` row + a matching
   * `approval.created` audit event inside one `withTenant` transaction.
   * Mirrors the agent-side `ApprovalGate.create` pattern so the
   * approval executor, /app/approvals inbox, and hot-lead notifier
   * all behave identically regardless of whether the action came from
   * an autonomous agent run or a chat turn.
   *
   * Errors are logged but swallowed — we don't want an approval-write
   * hiccup to mask the answer the user just got.
   */
  private async persistProposedActions(
    tenantId: string,
    agentRunId: AgentRunId | undefined,
    actions: ProposedAction[],
  ): Promise<{ created: CreatedApproval[]; rejected: RejectedProposal[] }> {
    const tierCandidates = actions.filter((a) => APPROVAL_TIERS.has(a.tier));
    // Validate each candidate against the ActionDescriptor zod schema
    // before persisting. Claude occasionally emits a shape that's
    // close-but-not-quite (missing toNumber on outbound_call, wrong
    // enum on crm.create_deal, non-E.164 phone, etc.). Validate
    // up-front so the approval never exists if it can't possibly fire.
    // Rejected shapes ride back to the UI via `rejected` — so the
    // operator sees a muted chip telling them WHY their request
    // silently didn't land instead of wondering why chat ignored it.
    const pending: ProposedAction[] = [];
    const rejected: RejectedProposal[] = [];
    for (const a of tierCandidates) {
      const flattened = {
        kind: a.kind,
        tier: a.tier,
        ...a.payload,
        ...(a.rationale ? { rationale: a.rationale } : {}),
      };
      const parsed = ActionDescriptor.safeParse(flattened);
      if (parsed.success) {
        pending.push(a);
      } else {
        const reason = parsed.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ");
        this.log.warn(
          `rejecting malformed ${a.kind} proposal from chat: ${reason}`,
        );
        rejected.push({ actionType: a.kind, tier: a.tier, reason });
      }
    }
    if (pending.length === 0) return { created: [], rejected };
    const created: CreatedApproval[] = [];
    try {
      await withTenant(this.db, tenantId, async (tx) => {
        for (const action of pending) {
          const approval = await this.approvals.create(tx, tenantId, {
            agentRunId: agentRunId ?? null,
            actionType: action.kind,
            proposedPayload: {
              ...action.payload,
              tier: action.tier,
              ...(action.rationale ? { rationale: action.rationale } : {}),
            },
          });
          await this.events.insertIfNotExists(tx, tenantId, {
            verb: "approval.created",
            subjectType: "approval",
            subjectId: approval.id,
            actorType: "system",
            actorId: "chat_query",
            objectType: "approval",
            objectId: approval.id,
            occurredAt: new Date(),
            idempotencyKey: `approval.created:${approval.id}`,
            metadata: {
              action_type: action.kind,
              tier: action.tier,
              source: "chat",
              audit_event_id: createId(),
            },
          });
          created.push({
            approvalId: approval.id,
            actionType: action.kind,
            tier: action.tier,
          });
        }
      });
    } catch (err) {
      this.log.warn(
        `failed to persist ${pending.length} chat-proposed action(s): ${(err as Error).message}`,
      );
    }
    return { created, rejected };
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

/**
 * Deterministic safety net for `outbound_call` proposals. Defaults
 * `aiMode=true` for every chat-initiated call unless the user
 * explicitly said they want to join the conference themselves
 * ("I'll take the call", "join the call", "conference in", etc.).
 *
 * Why default on: the conference-bridge path requires an operator to
 * click "join" — there's no UX surface doing that today, so an
 * unsupervised conference call means the callee picks up to hold
 * music. AI mode keeps the conversation moving; the user can still
 * escalate via the Sprint I backup request flow.
 *
 * Preserves an explicitly-set `aiMode=false` so operators who *do*
 * want to take the call themselves can opt back in.
 */
export function enforceAiModeWhenVexIsTheCaller(
  actions: ProposedAction[],
  userMessage: string,
): ProposedAction[] {
  const operatorWantsToJoin = OPERATOR_JOIN_RE.test(userMessage);
  return actions.map((a) => {
    if (a.kind !== "outbound_call") return a;
    if (a.payload["aiMode"] !== undefined) return a;
    return {
      ...a,
      payload: { ...a.payload, aiMode: !operatorWantsToJoin },
    };
  });
}

// Matches phrases where the user wants the operator-join conference
// flow instead of AI mode. Anything else defaults to aiMode=true.
const OPERATOR_JOIN_RE =
  /\b(i'?ll\s+(take|join|handle|be\s+on)|join\s+(the\s+)?call|conference\s+(in|me|us)|bridge\s+me|let\s+me\s+(join|take|handle))\b/i;

const TIER_RANK: Record<string, number> = { T0: 0, T1: 1, T2: 2, T3: 3 };
const RANK_TIER: Record<number, "T0" | "T1" | "T2" | "T3"> = {
  0: "T0",
  1: "T1",
  2: "T2",
  3: "T3",
};

/**
 * When a single chat turn produces multiple proposed actions, wrap
 * them in one `bundle` approval so the operator reviews a single
 * card instead of N scattered inbox rows. The operator can still
 * per-item uncheck anything before approving — that subset handling
 * lives on the approve endpoint.
 *
 * A single-item list is returned as-is — no need to wrap.
 * A bundle already in the list isn't nested (defensive); we flatten.
 * Tier bubbles up to the max across items.
 *
 * Each item is validated against `ActionDescriptor` before the
 * bundle is emitted. An invalid item (e.g. the LLM proposed an
 * `outbound_call` missing `toNumber`) is dropped and logged in
 * `droppedItems` on the bundle's payload so the operator can see
 * what got filtered + why. Without this guard, invalid items
 * passed validation via the bundle's own `.passthrough()` items
 * schema and only surfaced as executor failures at apply time —
 * after the bundle had already auto-approved.
 */
export function bundleActionsIfMultiple(
  actions: ProposedAction[],
): ProposedAction[] {
  if (actions.length <= 1) return actions;
  // Defensive flatten: if a caller already bundled upstream, unwrap.
  const flat: ProposedAction[] = [];
  for (const a of actions) {
    if (a.kind === "bundle" && Array.isArray((a.payload as { items?: unknown }).items)) {
      const nested = (a.payload as { items: ProposedAction[] }).items;
      for (const n of nested) flat.push(n);
    } else {
      flat.push(a);
    }
  }
  if (flat.length <= 1) return flat;

  // Validate each item. The bundle itself only passthroughs items;
  // without this pre-check the executor is left holding the bag on
  // malformed payloads the LLM hallucinated.
  const valid: ProposedAction[] = [];
  const droppedItems: Array<{
    kind: string;
    reason: string;
    payload: Record<string, unknown>;
  }> = [];
  for (const item of flat) {
    const candidate = {
      kind: item.kind,
      tier: item.tier,
      ...item.payload,
      ...(item.rationale !== undefined ? { rationale: item.rationale } : {}),
    };
    const parsed = ActionDescriptor.safeParse(candidate);
    if (parsed.success) {
      valid.push(item);
    } else {
      droppedItems.push({
        kind: item.kind,
        reason: parsed.error.issues
          .map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`)
          .join("; "),
        payload: item.payload,
      });
    }
  }

  // If validation dropped us back to 0–1 valid items, there's
  // nothing to bundle — return the surviving items as-is.
  if (valid.length <= 1) return valid;

  const maxRank = valid.reduce(
    (acc, a) => Math.max(acc, TIER_RANK[a.tier] ?? 1),
    0,
  );
  const tier = RANK_TIER[maxRank] ?? "T2";
  const summary = valid
    .map((a) => a.kind)
    .slice(0, 5)
    .join(", ");
  const rationale =
    droppedItems.length > 0
      ? `${valid.length} actions: ${summary}${valid.length > 5 ? ", …" : ""} (${droppedItems.length} invalid item${droppedItems.length === 1 ? "" : "s"} dropped: ${droppedItems.map((d) => d.kind).join(", ")})`
      : `${valid.length} actions: ${summary}${valid.length > 5 ? ", …" : ""}`;
  return [
    {
      kind: "bundle",
      tier,
      payload: {
        items: valid,
        ...(droppedItems.length > 0 ? { _droppedItems: droppedItems } : {}),
      },
      rationale,
    },
  ];
}

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
    createdApprovals: [],
    rejectedProposals: [],
    evidenceRefs: [],
    costUsd: 0,
    cacheHit: false,
    manifestValid: true,
  };
}

/**
 * Combine the current message with prior user-turn tokens for the
 * retrieval layer. Assistant turns are deliberately excluded — Claude's
 * answers can mention dozens of unrelated entities and would pollute
 * the FTS/embedding query. We keep just the last 4 user turns so name-
 * match fallback can pick up entity refs (deal IDs, org names).
 */
function buildRetrievalQuery(
  message: string,
  history?: HistoryTurn[],
): string {
  if (!history || history.length === 0) return message;
  const recentUser = history
    .slice(-8)
    .filter((t) => t.role === "user")
    .slice(-4)
    .map((t) => t.text);
  if (recentUser.length === 0) return message;
  return [...recentUser, message].join("\n");
}

/**
 * Render prior turns inline so Claude can resolve references in the
 * current message ("change this status", "show me that one"). Last 6
 * turns is plenty — the system prompt + evidence pack already carry
 * the heavy context, and bigger windows hurt the prompt cache hit
 * rate (the message block is the only uncached part).
 */
function composeUserMessage(
  message: string,
  history?: HistoryTurn[],
): string {
  if (!history || history.length === 0) return message;
  const recent = history.slice(-6);
  if (recent.length === 0) return message;
  const lines = recent.map(
    (t) => `${t.role === "user" ? "user" : "vex"}: ${t.text.trim()}`,
  );
  return [
    "Prior conversation (oldest → newest):",
    ...lines,
    "",
    `Current user message: ${message}`,
  ].join("\n");
}

function manifestFallbackText(): string {
  // Mirror the message manifestFallback uses for parity in the response.
  return manifestFallback("Vex couldn't compose a response.").panels[0]?.type === "table"
    ? "Vex couldn't compose a response."
    : "";
}
