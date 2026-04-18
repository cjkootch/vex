import {
  MarketDataAgent,
  type MarketDataAgentInput,
  type MarketDataProvider,
  type MarketDataSeries,
  type AgentContext,
  type AgentOutput,
} from "@vex/agents";
import {
  ActivityRepository,
  AgentRunRepository,
  ApprovalRepository,
  ContactRepository,
  EventRepository,
  FuelMarketRateRepository,
  LeadRepository,
  OrganizationRepository,
  RetrievalService,
  SummaryRepository,
  ThreadRepository,
  TouchpointRepository,
  WorkspaceRepository,
  withTenant,
  type Db,
} from "@vex/db";
import { FUEL_SERIES, EiaAdapter } from "@vex/integrations";
import type { AnthropicAdapter, OpenAIAdapter } from "@vex/integrations";
import type { CostLedger } from "@vex/telemetry";

/**
 * Market-data ingestion job. Schedules the provider-agnostic
 * {@link MarketDataAgent} on a recurring timer for a workspace.
 *
 * Unlike the BullMQ agents queue, this is infrastructure — not gated on
 * `workspace.settings.enabled_agents`. The feed always runs when its
 * upstream provider is configured; individual tenants opt into
 * downstream alerting via the MarketAlertAgent.
 */

export interface MarketDataJobDeps {
  db: Db;
  anthropic: AnthropicAdapter;
  openai: OpenAIAdapter;
  costLedger: CostLedger;
  /** Provider the agent will ingest from this tick. */
  provider: MarketDataProvider;
  /** Series list driving the scan — typically FUEL_SERIES_CONFIG. */
  series: MarketDataSeries[];
  /** Single-workspace scheduling for now; Sprint 12+ will iterate. */
  workspaceId: string;
  /** Optional tenant override when tenant != workspace. */
  tenantId?: string;
  /** How many days of history to request each tick. Default 7. */
  lookbackDays?: number;
}

export interface MarketDataJobTick {
  status: "ran" | "failed";
  output?: AgentOutput;
  error?: string;
}

/**
 * Default series config — WTI + Brent daily crude, NY ULSD + US regular
 * retail weekly, Henry Hub natural gas daily. `bblPerMt` overrides follow
 * standard petroleum conversion tables (crude 7.33, gasoline 8.5, diesel
 * 7.45, natgas MMBtu has no mass equivalent so we leave the default and
 * downstream consumers ignore price_per_mt for gas).
 */
export const FUEL_SERIES_CONFIG: MarketDataSeries[] = [
  {
    seriesId: FUEL_SERIES.WTI,
    product: "crude",
    benchmark: "WTI",
    nativeUnit: "per_bbl",
    bblPerMt: 7.33,
  },
  {
    seriesId: FUEL_SERIES.BRENT,
    product: "crude",
    benchmark: "BRENT",
    nativeUnit: "per_bbl",
    bblPerMt: 7.33,
  },
  {
    seriesId: FUEL_SERIES.GASOLINE_RETAIL,
    product: "gasoline",
    benchmark: "US_RETAIL",
    nativeUnit: "per_gal",
    bblPerMt: 8.5,
  },
  {
    seriesId: FUEL_SERIES.DIESEL_NY,
    product: "diesel",
    benchmark: "NY_HARBOR_ULSD",
    nativeUnit: "per_gal",
    bblPerMt: 7.45,
  },
  {
    seriesId: FUEL_SERIES.NATGAS_HH,
    product: "natural_gas",
    benchmark: "HENRY_HUB",
    nativeUnit: "per_bbl",
    bblPerMt: 7.33,
  },
];

/**
 * Run a single market-data tick. Opens `withTenant`, builds the minimum
 * {@link AgentContext} the MarketDataAgent needs, and invokes
 * `agent.run`. Errors are swallowed and returned so the timer that wraps
 * this job never crashes the worker.
 */
export async function runMarketDataTick(deps: MarketDataJobDeps): Promise<MarketDataJobTick> {
  const tenantId = deps.tenantId ?? deps.workspaceId;
  const rates = new FuelMarketRateRepository();

  const agentInput: MarketDataAgentInput = {
    provider: deps.provider,
    rates,
    series: deps.series,
    ...(deps.lookbackDays !== undefined ? { lookbackDays: deps.lookbackDays } : {}),
  };
  const agent = new MarketDataAgent(agentInput);

  try {
    const output = await withTenant(deps.db, tenantId, async (tx) => {
      const ctx: AgentContext = {
        tenantId,
        workspaceId: deps.workspaceId,
        // Infrastructure runs don't create an agent_runs row — the agent
        // writes its own ingestion events instead. The `agentRunId` is
        // only consulted by ApprovalGate (T2+ path), which this T1 agent
        // never touches.
        agentRunId: "",
        tx,
        anthropic: deps.anthropic,
        openai: deps.openai,
        costLedger: deps.costLedger,
        retrieval: new RetrievalService(),
        organizations: new OrganizationRepository(),
        contacts: new ContactRepository(),
        leads: new LeadRepository(),
        summaries: new SummaryRepository(),
        touchpoints: new TouchpointRepository(),
        activities: new ActivityRepository(),
        threads: new ThreadRepository(),
        events: new EventRepository(),
        approvals: new ApprovalRepository(),
        agentRuns: new AgentRunRepository(),
        workspaces: new WorkspaceRepository(),
      };
      return agent.run(ctx);
    });
    return { status: "ran", output };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Construct the default EIA-backed provider from an env-provided API key.
 * Returns null when the key is absent, so the worker can skip wiring the
 * job entirely rather than fail open on an unauthenticated feed.
 */
export function buildEiaProvider(apiKey: string | undefined): MarketDataProvider | null {
  if (!apiKey) return null;
  const eia = new EiaAdapter({ apiKey });
  return {
    name: "eia",
    fetchRates: (params) => eia.fetchSeries(params),
  };
}
