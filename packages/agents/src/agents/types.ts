import type { ApprovalTier } from "@vex/domain";
import type {
  ActivityRepository,
  AgentRunRepository,
  ApprovalRepository,
  ContactRepository,
  DocumentRepository,
  EventRepository,
  FuelDealMarketContextRepository,
  LeadRepository,
  OrganizationProductRepository,
  OrganizationRepository,
  ProcurSnapshotRepository,
  RetrievalService,
  SignalRepository,
  SummaryRepository,
  ThreadRepository,
  TouchpointRepository,
  Tx,
  WorkspaceRepository,
} from "@vex/db";
import type {
  AnthropicAdapter,
  OpenAIAdapter,
  ProcurClient,
  TavilyClient,
} from "@vex/integrations";
import type { CostLedger } from "@vex/telemetry";
import type { ProposedAction } from "@vex/integrations";

/**
 * Per-run dependency surface. `AgentRunner` builds this once for each agent
 * invocation; the `tx` is opened by `withTenant` so every DB call is RLS-
 * scoped to the right tenant.
 */
export interface AgentContext {
  tenantId: string;
  workspaceId: string;
  /** The id of the `agent_runs` row already created for this run. */
  agentRunId: string;
  tx: Tx;

  anthropic: AnthropicAdapter;
  openai: OpenAIAdapter;
  costLedger: CostLedger;
  retrieval: RetrievalService;

  organizations: OrganizationRepository;
  orgProducts: OrganizationProductRepository;
  contacts: ContactRepository;
  leads: LeadRepository;
  summaries: SummaryRepository;
  touchpoints: TouchpointRepository;
  activities: ActivityRepository;
  threads: ThreadRepository;
  events: EventRepository;
  approvals: ApprovalRepository;
  agentRuns: AgentRunRepository;
  workspaces: WorkspaceRepository;
  documents: DocumentRepository;
  signals: SignalRepository;
  /**
   * Procur HTTP client. Always present on the runner; isEnabled() is
   * false when env is unconfigured. Agents that call procur should
   * check `isEnabled()` and degrade gracefully when false.
   */
  procur: ProcurClient;
  /** Cache layer for procur intelligence — see ProcurEnrichmentAgent. */
  procurSnapshots: ProcurSnapshotRepository;
  /** Per-deal market context populated by DealMarketContextAgent. */
  fuelDealMarketContext: FuelDealMarketContextRepository;
  /** Snapshot freshness window. Fed from PROCUR_CACHE_TTL_DAYS env. */
  procurCacheTtlDays: number;
  /**
   * Tavily web-search client. Null when TAVILY_API_KEY is unset; agents
   * that depend on web research must check and degrade gracefully.
   */
  tavily: TavilyClient | null;
}

/**
 * The shape every agent returns. `AgentRunner` writes the run record from
 * this and routes any T2+ actions through ApprovalGate.
 */
export interface AgentOutput {
  /** USD cost recorded against this run (sum of all LLM calls inside it). */
  costUsd: number;
  /** Free-form references the run produced (summary id, etc.). */
  outputRefs: Record<string, unknown>;
  /** Actions the agent proposes — T2+ get gated through ApprovalGate. */
  proposedActions: ProposedAction[];
  /** Number of T1 internal writes the agent already performed. Audit only. */
  internalWrites: number;
  /** Optional human-readable reason for the run, surfaced in audit events. */
  rationale?: string;
}

export interface IAgent {
  /** Stable identifier used by `enabled_agents` and audit verbs. */
  readonly name: string;
  /** Highest tier of action the agent can produce. T2+ require approval. */
  readonly tier: ApprovalTier;
  run(ctx: AgentContext): Promise<AgentOutput>;
}
