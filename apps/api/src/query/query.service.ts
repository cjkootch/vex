import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  ApprovalRepository,
  EventRepository,
  withTenant,
  WorkspaceRepository,
  type Db,
  type RetrievalService,
} from "@vex/db";
import {
  addApprovalExecutorJob,
  type ApprovalExecutorJobData,
} from "@vex/agents";
import type {
  AnthropicAdapter,
  OpenAIAdapter,
  ProcurClient,
  ApolloClient,
  ProposedAction,
  SupplierAnalysisResult,
  TavilyClient,
  ToolDefinition,
  ToolRunner,
} from "@vex/integrations";
import {
  QUERY_SYSTEM_PROMPT,
  renderStrategyPreamble,
  renderWhatsAppTemplatesPreamble,
  renderTemplatesPreamble,
  renderTargetRolesPreamble,
  extractPlaceholders,
  ActionDescriptor,
} from "@vex/agents";
import { createId, isUlid, TenantId, type AgentRunId } from "@vex/domain";
import { manifestFallback, validateManifest, type ViewManifest } from "@vex/ui";
import type { CostLedger } from "@vex/telemetry";
import { pricing, unitsToUsdMicros } from "@vex/integrations";
import {
  ANTHROPIC_ADAPTER,
  APPROVAL_EXECUTOR_QUEUE,
  COST_LEDGER,
  DB_CLIENT,
  DEFAULT_WORKSPACE_ID,
  OPENAI_ADAPTER,
  PROCUR_CLIENT,
  RETRIEVAL_SERVICE,
  TAVILY_CLIENT,
  APOLLO_CLIENT,
} from "./tokens.js";
import { extractOrgActionsFromPanels } from "./profile-panel-extractor.js";

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
  /**
   * The proposed payload that will execute on approve. Surfaced so
   * the chat UI can render an inline draft preview (subject + body
   * for email.send, body for sms.send, etc.) without a follow-up
   * fetch per chip. Stripped of the internal `tier`/`rationale`
   * fields the executor injects but the UI doesn't render.
   */
  payload: Record<string, unknown>;
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
    @Inject(APOLLO_CLIENT) private readonly apollo: ApolloClient,
    @Inject(PROCUR_CLIENT) private readonly procur: ProcurClient,
    @Inject(COST_LEDGER) private readonly costLedger: CostLedger,
    @Inject(APPROVAL_EXECUTOR_QUEUE)
    private readonly approvalExecutorQueue: Queue<ApprovalExecutorJobData>,
    @Inject(DEFAULT_WORKSPACE_ID)
    private readonly defaultWorkspaceId: string,
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

    const tools: ToolDefinition[] = [];
    if (this.tavily) {
      tools.push({
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
      });
    }
    if (this.apollo.isEnabled()) {
      tools.push({
        name: "apollo_people_search",
        description:
          "Find net-new people at a target company via Apollo's database — the structured alternative to research_contact. Best when the operator names a company + a role or function ('find me a fuel procurement manager at Vitol', 'who runs trading at Trafigura'). Returns up to 10 candidates per call with first name, obfuscated last name, title, has_email/has_phone flags. Does NOT return actual emails or phones — those come from a follow-up enrichment step. Prefer this over research_contact when the operator's intent is a structured 'find someone with role X at company Y' query; fall back to research_contact for fuzzy or non-corporate queries (LinkedIn URL discovery, biography research).",
        input_schema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description:
                "The company's primary domain — no www, no @. Strongly recommended for narrow results. Example: vitol.com",
            },
            titles: {
              type: "array",
              items: { type: "string" },
              description:
                "Job titles to match (loose match; 'marketing manager' also returns 'content marketing manager'). Pull from `target_roles_by_category` registry when available.",
            },
            seniorities: {
              type: "array",
              items: { type: "string" },
              description:
                "Seniority filter — values: owner, founder, c_suite, partner, vp, head, director, manager, senior, entry, intern. Combine with titles to scope precisely.",
            },
            keywords: {
              type: "string",
              description:
                "Free-text keyword filter (region, commodity, language, etc.). Optional.",
            },
            perPage: {
              type: "integer",
              description:
                "Results per page (max 100, default 10). Keep tight unless the operator explicitly asks to widen.",
            },
          },
        },
      });
    }
    if (this.procur.isEnabled()) {
      tools.push({
        name: "lookup_in_procur",
        description:
          "Pull entity-level intelligence on a supplier from procur (the procurement-data platform vex integrates with). Use when the operator names a company alongside 'from procur', 'in procur', 'procur data', etc., or when an answer needs supplier-graph context (award velocity, distress signals, recent counterparties) we don't already have. Server caches each (name, hash) for 7 days, so re-asks within that window are free. Returns a compact profile (legalName, country, industry, awardCount, recent counterparties, distress signals) — cite sourceUrl=procur in any panel you write.",
        input_schema: {
          type: "object",
          properties: {
            companyName: {
              type: "string",
              description:
                "Company name as the user stated it. Procur disambiguates fuzzy matches; on multiple candidates we surface them and ask the operator to pick.",
            },
          },
          required: ["companyName"],
        },
      });
    }

    const toolRunner: ToolRunner = async (name, input) => {
      if (name === "research_contact") {
        if (!this.tavily) return { error: "research_contact not available" };
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
      }
      if (name === "apollo_people_search") {
        if (!this.apollo.isEnabled()) {
          return { error: "apollo_people_search not available (APOLLO_API_KEY unset)" };
        }
        const domain =
          typeof input["domain"] === "string" ? input["domain"].trim() : "";
        const titles = Array.isArray(input["titles"])
          ? (input["titles"] as unknown[]).filter(
              (t): t is string => typeof t === "string" && t.length > 0,
            )
          : [];
        const seniorities = Array.isArray(input["seniorities"])
          ? (input["seniorities"] as unknown[]).filter(
              (s): s is string => typeof s === "string" && s.length > 0,
            )
          : [];
        const keywords =
          typeof input["keywords"] === "string" ? input["keywords"] : "";
        const perPage =
          typeof input["perPage"] === "number" ? input["perPage"] : 10;
        const result = await this.apollo.peopleSearch({
          ...(domain ? { q_organization_domains_list: [domain] } : {}),
          ...(titles.length > 0 ? { person_titles: titles } : {}),
          ...(seniorities.length > 0 ? { person_seniorities: seniorities } : {}),
          ...(keywords ? { q_keywords: keywords } : {}),
          per_page: perPage,
        });
        if (!result.ok) {
          return {
            error: `apollo_people_search failed: ${result.reason}${
              result.message ? ` (${result.message.slice(0, 200)})` : ""
            }`,
          };
        }
        // Compact projection — strip the booleans the model doesn't
        // need to reason over and just hand back identity + title +
        // employer + has_email/has_phone signal (the operator-
        // facing data we'd actually surface in a draft).
        return {
          total: result.data.total_entries,
          people: result.data.people.map((p) => ({
            id: p.id,
            firstName: p.first_name,
            lastName: p.last_name_obfuscated,
            title: p.title,
            org: p.organization?.name ?? null,
            hasEmail: p.has_email,
            hasPhone: p.has_direct_phone,
            lastRefreshed: p.last_refreshed_at,
          })),
        };
      }
      if (name === "lookup_in_procur") {
        if (!this.procur.isEnabled()) {
          return { error: "lookup_in_procur not available (procur disabled)" };
        }
        const companyName =
          typeof input["companyName"] === "string"
            ? input["companyName"].trim()
            : "";
        if (!companyName) {
          return { error: "companyName is required" };
        }
        const result = await this.procur.analyzeSupplier({
          supplierName: companyName,
          yearsLookback: 3,
        });
        if (!result.ok) {
          return { error: `procur error: ${result.reason}` };
        }
        return shapeProcurSupplierResult(result.data);
      }
      return { error: `tool ${name} not available` };
    };

    // Sprint S — prepend the tenant's operator-authored strategy
    // so every answer, drafted email, and proposed action is
    // conditioned on company context (mission, ICP, brand voice,
    // no-go zones, growth priorities). Empty strategy → empty
    // preamble → prompt is the vanilla QUERY_SYSTEM_PROMPT.
    const strategy = await this.workspaces.getStrategy(this.db, tenantId);
    const preamble = renderStrategyPreamble(strategy);
    // Surface registered WhatsApp templates so the chat agent knows
    // which contentSids it can emit in `whatsapp.send_template` for
    // cold outreach. Empty list → preamble is empty string and the
    // agent gracefully responds "no templates registered" if the
    // operator asks for one.
    const settings = await this.workspaces.getSettings(this.db, tenantId);
    const waTemplatesPreamble = renderWhatsAppTemplatesPreamble(
      settings?.whatsapp_templates,
    );
    // Vex-native template registry (email / sms / call). Same
    // mechanism as the WhatsApp templates preamble — empty across all
    // three lists → empty string and the agent treats "send the X
    // template" as "no such template" instead of inventing one.
    const templatesPreamble = renderTemplatesPreamble(
      settings?.email_templates,
      settings?.sms_templates,
      settings?.call_templates,
    );
    // Per-category target-role registry (#316). Empty registry →
    // empty preamble and the agent skips the role-bias clarifier
    // (no options to offer); falls back to a broad enrichment.
    const targetRolesPreamble = renderTargetRolesPreamble(
      settings?.target_roles_by_category,
    );
    const systemPrompt = `${preamble}${waTemplatesPreamble}${templatesPreamble}${targetRolesPreamble}${QUERY_SYSTEM_PROMPT}`;

    const queryResult = await this.anthropic.query({
      tenantId,
      ...(input.agentRunId !== undefined ? { agentRunId: input.agentRunId } : {}),
      idempotencyKey: input.idempotencyKey,
      systemPrompt,
      evidencePack: pack,
      userMessage: composeUserMessage(input.message, input.history),
      // Bumped from the 2048 default. A multi-org enrichment turn
      // (e.g. operator: "enrich these 5 caribbean utilities") needs
      // headroom for the final composition AFTER tool-use rounds:
      // 5 enrichment summaries + manifest + 5 crm.create_contact
      // proposed_actions easily blows 2048 mid-JSON. 8192 is safe
      // and still fits well inside Anthropic's per-model ceiling.
      maxTokens: 8192,
      // Bumped from the default 3. Same multi-entity case — operator
      // asks for N enrichments, model needs N research_contact calls
      // back-to-back. 3 was tight for 5+ orgs; 8 covers the long
      // tail without opening a runaway cost vector (each iteration
      // is gated by Tavily cost too).
      maxToolIterations: 8,
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

    // Server-side panel-to-action extractor (Path B). The chat model
    // is reliable at producing a profile panel with the right
    // structured facts, but unreliable at also emitting the parallel
    // proposed_actions JSON to persist them. Even with v7.22's
    // mandatory rule the model skips action emission ~half the time
    // and lies about completion. This step closes the gap
    // deterministically: scan profile panels for known fields, emit
    // the matching T1 actions, append to the model's list. Dedupes
    // against anything the model DID emit so we don't double-tag.
    const extractedActions = extractOrgActionsFromPanels({
      panels: manifest.panels ?? [],
      existingActions: queryResult.proposedActions,
      isValidUlid: isUlid,
    });
    const allActions = [...queryResult.proposedActions, ...extractedActions];
    // Always log the panel + extraction stats — Path B is silent when
    // no actions come out, which made it hard to diagnose whether the
    // extractor is running or the panels just don't match the
    // mapping. This gives us one log line per chat turn we can grep.
    const panelSummary = (manifest.panels ?? []).map((p) =>
      p.type === "profile"
        ? {
            type: p.type,
            objectType: p.objectType,
            objectId: p.objectId,
            fieldKeys: Object.keys(p.fields ?? {}),
          }
        : { type: p.type },
    );
    this.log.log(
      `chat: panel-extractor panels=${JSON.stringify(panelSummary)} extracted=${extractedActions.length} model_emitted=${queryResult.proposedActions.length}`,
    );

    // Hard signal when the model returned nothing actionable AND
    // nothing readable. Triggered the "Vex couldn't compose a
    // response" fallback in the UI; the only prior signal was the
    // panel-extractor line above which doesn't carry enough context
    // to diagnose. Log the request shape so the next failure is
    // debuggable from logs alone — message length, evidence pack
    // size, tool-loop iteration count, max-token hit indication.
    const isEmptyTurn =
      (!queryResult.answer || queryResult.answer.trim().length === 0) &&
      panelSummary.length === 0 &&
      queryResult.proposedActions.length === 0;
    if (isEmptyTurn) {
      this.log.warn(
        `chat: empty turn (no answer, no panels, no actions) — likely token cap, tool-iteration cap, or invalid JSON from model. ` +
          `tenantId=${tenantId} ` +
          `messageLen=${input.message.length} ` +
          `evidenceItems=${pack.items.length} ` +
          `evidenceSummaries=${pack.summaries.length} ` +
          `tokensIn=${queryResult.tokensIn} ` +
          `tokensOut=${queryResult.tokensOut} ` +
          `costUsd=${queryResult.costUsd?.toFixed(4) ?? "n/a"} ` +
          `messagePreview="${input.message.slice(0, 120).replace(/\n/g, " ")}"`,
      );
    }

    // Persist T2+ proposals as pending approvals so the chat-proposed
    // side effects (email.send, crm.create_deal, outbound_call, etc.)
    // actually land in /app/approvals where the operator can review
    // and fire them. Until this existed, Claude would prose-say
    // "I'll set up the call" without any row ever reaching the DB
    // and the approval-executor worker had nothing to act on.
    const normalizedActions = enforceAiModeWhenVexIsTheCaller(
      allActions,
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
    // T1 actions used to be silently dropped here — only T2/T3 went
    // into the approval queue. That broke the chat's auto-capture
    // path: org.update_fields / org.tag / org.set_kind / crm.note
    // are all T1 and never executed even though the model emitted
    // them correctly. Now T1 lands as auto_approved approvals + an
    // immediate executor enqueue, so the same worker dispatch the
    // operator-approval path uses applies them. Operator never sees
    // a gate; chat-driven mutations finally persist.
    const persistable = actions.filter(
      (a) => a.tier === "T1" || APPROVAL_TIERS.has(a.tier),
    );
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
    for (const a of persistable) {
      const flattened = {
        kind: a.kind,
        tier: a.tier,
        ...a.payload,
        ...(a.rationale ? { rationale: a.rationale } : {}),
      };
      const parsed = ActionDescriptor.safeParse(flattened);
      if (!parsed.success) {
        const reason = parsed.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ");
        this.log.warn(
          `rejecting malformed ${a.kind} proposal from chat: ${reason}`,
        );
        rejected.push({ actionType: a.kind, tier: a.tier, reason });
        continue;
      }
      // Hard guard: if the agent rendered a templated action and left
      // any `{{name}}` placeholder unresolved, refuse to persist —
      // the literal braces would otherwise ship to the recipient
      // (email/SMS) or to the AI agent's system prompt during a
      // call, which sounds broken in both modes. Rejected with a
      // structured reason so the operator sees exactly what the
      // model was missing.
      const unresolvedReason = unresolvedPlaceholderReason(a, flattened);
      if (unresolvedReason) {
        this.log.warn(
          `rejecting ${a.kind} proposal from chat with unresolved variables: ${unresolvedReason}`,
        );
        rejected.push({ actionType: a.kind, tier: a.tier, reason: unresolvedReason });
        continue;
      }
      pending.push(a);
    }
    if (pending.length === 0) return { created: [], rejected };
    const created: CreatedApproval[] = [];
    /** Approvals to enqueue post-tx (T1 auto-approved actions only). */
    const autoApprovedIds: string[] = [];
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
          // T1 auto-approves immediately. T2/T3 stay pending for the
          // operator. Same approvals row shape, just different decision.
          if (action.tier === "T1") {
            await this.approvals.decide(tx, approval.id, "auto_approved", null);
            autoApprovedIds.push(approval.id);
          }
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
              ...(action.tier === "T1" ? { auto_approved: true } : {}),
            },
          });
          created.push({
            approvalId: approval.id,
            actionType: action.kind,
            tier: action.tier,
            payload: action.payload,
          });
        }
      });

      // Enqueue executor for the auto-approved T1 batch. Done outside
      // the tx so a Redis hiccup can't fail the approval row write —
      // the row is the source of truth, the queue is the trigger.
      for (const approvalId of autoApprovedIds) {
        try {
          await addApprovalExecutorJob(this.approvalExecutorQueue, {
            approval_id: approvalId,
            workspace_id: this.defaultWorkspaceId,
          });
        } catch (err) {
          this.log.warn(
            `T1 auto-approve executor enqueue failed for ${approvalId}: ${(err as Error).message}`,
          );
        }
      }
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
/**
 * Action kinds the chat surfaces as a carousel of inline draft
 * previews. When a turn proposes 2+ of these AND they're all the same
 * kind, we keep them as N individual approvals so the carousel can
 * render one chip per draft. Mixed action lists (e.g. crm.note +
 * email.send) keep bundling — the carousel only handles homogeneous
 * draft batches.
 */
const CAROUSEL_KINDS = new Set([
  "email.send",
  "sms.send",
  "whatsapp.send",
]);

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

  // Same-kind draft batches stay un-bundled so the chat UI can group
  // them into a carousel of independently-approvable drafts. The
  // operator pages through subject + body + lang per recipient and
  // approves each, instead of seeing one collapsed "bundle" chip.
  const firstKind = flat[0]?.kind;
  if (
    firstKind &&
    CAROUSEL_KINDS.has(firstKind) &&
    flat.every((a) => a.kind === firstKind)
  ) {
    return flat;
  }

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

/**
 * Scan the rendered fields of a templated action proposal for any
 * `{{name}}` placeholders the agent failed to substitute. Returns a
 * structured reason string when found (e.g.
 * `"unresolved variables in body: call_topic, proposed_windows"`),
 * `null` otherwise.
 *
 * Per-kind which fields are user-visible content:
 *   - email.send      → subject + body
 *   - sms.send        → body
 *   - whatsapp.send   → body  (freeform path)
 *   - outbound_call   → aiInstructions
 *   - whatsapp.send_template
 *                     → contentVariables values  (the rendered values
 *                       Twilio will splice into the template)
 *
 * Other action kinds (org.tag, deal.status_change, …) don't take
 * free-text content from templates, so they never need this check.
 */
function unresolvedPlaceholderReason(
  action: ProposedAction,
  flattened: Record<string, unknown>,
): string | null {
  const fields: Array<{ label: string; value: unknown }> = [];
  switch (action.kind) {
    case "email.send":
      fields.push({ label: "subject", value: flattened["subject"] });
      fields.push({ label: "body", value: flattened["body"] });
      break;
    case "sms.send":
    case "whatsapp.send":
      fields.push({ label: "body", value: flattened["body"] });
      break;
    case "outbound_call":
      fields.push({
        label: "aiInstructions",
        value: flattened["aiInstructions"],
      });
      break;
    case "whatsapp.send_template": {
      const vars = flattened["contentVariables"];
      if (vars && typeof vars === "object") {
        for (const [k, v] of Object.entries(vars as Record<string, unknown>)) {
          fields.push({ label: `contentVariables[${k}]`, value: v });
        }
      }
      break;
    }
    default:
      return null;
  }
  const offenders: string[] = [];
  for (const { label, value } of fields) {
    if (typeof value !== "string") continue;
    const unresolved = extractPlaceholders(value);
    if (unresolved.length > 0) {
      offenders.push(`${label}: ${unresolved.join(", ")}`);
    }
  }
  if (offenders.length === 0) return null;
  return `unresolved template variable(s) — ${offenders.join("; ")}`;
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

/**
 * Project procur's analyzeSupplier response down to the high-signal
 * fields the chat model actually needs to write a profile panel +
 * propose persistence actions. Procur's full payload includes raw
 * award-history rows; surfacing those bloats the model's context for
 * no upside (chat doesn't reason over per-award detail). Keeps
 * disambiguation + not-found shapes intact so the model can ask the
 * operator to pick the right entity or fall back gracefully.
 */
export function shapeProcurSupplierResult(
  data: SupplierAnalysisResult,
): Record<string, unknown> {
  if (data.kind === "not_found") {
    return {
      kind: "not_found",
      searched: data.searched,
      hint: "no matching supplier in procur",
    };
  }
  if (data.kind === "disambiguation_needed") {
    return {
      kind: "disambiguation_needed",
      candidates: data.candidates.slice(0, 5).map((c) => ({
        supplier_id: c.supplierId,
        legal_name: c.legalName,
        country: c.country,
        award_count: c.awardCount,
      })),
    };
  }
  return {
    kind: "profile",
    supplier_id: data.supplierId,
    legal_name: data.legalName,
    country: data.country,
    role: data.role,
    categories: data.categories.slice(0, 6),
    award_count: data.awardCount,
    award_total_usd: data.awardTotalUsd,
    recent_award_count: data.recentAwardCount,
    days_since_last_award: data.daysSinceLastAward,
    tags: data.tags.slice(0, 6),
    distress_signals: data.distressSignals.slice(0, 3).map((s) => ({
      kind: s.kind,
      detail: s.detail,
      observed_at: s.observedAt,
    })),
    notes: data.notes,
  };
}
