import { randomUUID } from "node:crypto";
import {
  OfacScreenRepository,
  SignalRepository,
  schema,
  type OfacMatchRecord,
  type OfacScreenStatus,
  type Organization,
} from "@vex/db";
import { eq } from "drizzle-orm";
import {
  CSLAdapter,
  EUConsolidatedAdapter,
  OFACSdnAdapter,
  UKOFSIAdapter,
  type CslEntry,
  type SdnEntry,
  type SdnScreenResult,
} from "@vex/integrations";
import type { ProposedAction } from "@vex/integrations";
import type { AgentContext, AgentOutput, IAgent } from "./types.js";

/**
 * Sanctions-screening sources. The agent fans out to every enabled
 * adapter in parallel, screens each org against each source, and
 * stamps each match row with its origin so reviewers can triage
 * list-specific noise (UVL hits routinely false-positive; an EU
 * regime hit on Russia is a hard block).
 *
 * `us_csl` — Either the legacy OFAC SDN feed (single Treasury list,
 *   ~10k entries) or trade.gov's Consolidated Screening List (~13 US
 *   lists, ~150k entries — adds BIS Entity / Denied Persons /
 *   Unverified, State DDTC, etc). Which one runs is gated by the
 *   `SCREENING_SOURCE` env var inside the US adapter.
 * `eu` — European Council Consolidated Financial Sanctions list.
 * `uk_ofsi` — UK Office of Financial Sanctions Implementation.
 *
 * Selected per-workspace via `WorkspaceSettings.enabled_sanctions_lists`.
 * Default when unset / empty: `["us_csl"]` — every existing tenant
 * keeps today's behaviour without any settings change.
 */
type SanctionsSource = "us_csl" | "eu" | "uk_ofsi";

type ScreeningSource = "ofac" | "csl";

/**
 * Adapter shape every list adapter satisfies. Lets the agent treat
 * them identically.
 */
interface SanctionsAdapter {
  getEntries(): Promise<SdnEntry[]>;
  screen(
    name: string,
    entries: SdnEntry[],
    threshold?: number,
  ): SdnScreenResult[];
}

/**
 * OFAC SDN screening agent. Runs in two modes:
 *
 *   - Batch (`{}`): screens every active organization in the workspace.
 *     Designed for the daily 07:00 cron — fires after OFAC's overnight
 *     SDN publication.
 *   - Targeted (`{ orgId }`): screens a single organization on demand.
 *     Triggered automatically when a new counterparty lands (so the
 *     deal creator's buyer-intel card is never "unscreened" for more
 *     than a few seconds) and from the admin panel's "Screen now"
 *     button.
 *
 * Same code path, same persistence, same signals — only the input
 * scope differs.
 *
 * Tier policy:
 *   - T1 for clean screens (internal writes only: org state, audit
 *     row, summary) — no human review needed.
 *   - T3 surfaces as `proposedActions` whenever a match lands above
 *     the threshold. The AgentRunner routes T3 through ApprovalGate,
 *     which already blocks downstream deal execution until a human
 *     clears the hold.
 *
 * No LLM calls — screening is rule-based, so costUsd is always 0.
 */

const SCORE_THRESHOLD = 0.85;
const HIGH_CONFIDENCE_THRESHOLD = 0.95;

export interface OfacScreeningAgentInput {
  /** Screen a specific org. Omit to screen all active organizations. */
  orgId?: string;
}

export class OFACScreeningAgent implements IAgent {
  readonly name = "ofac_screening";
  /**
   * Reported as T3 because the *highest* action the agent can emit is a
   * T3 `ofac.hold`. Clean screens still complete without blocking —
   * proposedActions simply stays empty in that case.
   */
  readonly tier = "T3" as const;

  private readonly screens = new OfacScreenRepository();
  private readonly signals = new SignalRepository();

  constructor(
    private readonly input: OfacScreeningAgentInput = {},
    /**
     * Optional explicit adapter map override — used by tests. Keys
     * are the SanctionsSource ids; the agent runs every entry in
     * parallel and merges results. In production, leave unset and
     * let `buildAdapters()` construct the right map based on the
     * workspace's `enabled_sanctions_lists` setting.
     */
    private readonly adaptersOverride?: ReadonlyMap<
      SanctionsSource,
      SanctionsAdapter
    >,
  ) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const enabled = this.adaptersOverride
      ? [...this.adaptersOverride.keys()]
      : await resolveEnabledLists(ctx);
    const adapters: Map<SanctionsSource, SanctionsAdapter> = this
      .adaptersOverride
      ? new Map(this.adaptersOverride)
      : buildAdapters(enabled);
    if (adapters.size === 0) {
      return {
        costUsd: 0,
        outputRefs: { skipped: "no_lists_enabled" },
        proposedActions: [],
        internalWrites: 0,
        rationale:
          "workspace has no sanctions lists enabled — set " +
          "enabled_sanctions_lists in admin settings",
      };
    }

    // Fan out to every enabled list in parallel. Each adapter
    // caches its own snapshot so two batch runs in quick succession
    // only hit the network once per source. A failure on any single
    // list short-circuits the whole run — half-screened is worse
    // than not-screened from a compliance posture: an operator who
    // sees a "clear" verdict expects every enabled list to have
    // contributed.
    const entriesPerSource = await loadEntriesPerSource(adapters);
    const totalEntries = [...entriesPerSource.values()].reduce(
      (sum, e) => sum + e.length,
      0,
    );
    if (totalEntries === 0) {
      return {
        costUsd: 0,
        outputRefs: {
          skipped: "empty_sanctions_lists",
          enabled: [...adapters.keys()],
        },
        proposedActions: [],
        internalWrites: 0,
        rationale:
          "every enabled sanctions list returned 0 entries — skipping screen",
      };
    }
    const sdnListDate = new Date().toISOString().slice(0, 10);

    // Scope — single org or every active org under the tenant.
    const orgs = this.input.orgId
      ? await loadSingleOrg(ctx, this.input.orgId)
      : await ctx.organizations.listActive(ctx.tx);
    if (orgs.length === 0) {
      return {
        costUsd: 0,
        outputRefs: { skipped: "no_orgs", scope: this.input.orgId ?? "all" },
        proposedActions: [],
        internalWrites: 0,
      };
    }

    let clearCount = 0;
    let potentialCount = 0;
    let internalWrites = 0;
    const proposedActions: ProposedAction[] = [];
    const potentialMatchOrgs: string[] = [];

    for (const org of orgs) {
      const matches = screenOrgAcrossSources(org, entriesPerSource, adapters);
      const status = deriveStatus(matches);
      const highestScore = matches[0]?.score ?? 0;

      // Audit row — always written, even for clean screens, so the
      // compliance timeline shows every assessment.
      await this.screens.insert(ctx.tx, ctx.tenantId, {
        orgId: org.id,
        sdnListDate,
        status,
        highestScore,
        matchCount: matches.length,
        matches: matches.map(toMatchRecord),
      });
      internalWrites++;

      // Rolling state on the org — cheap to query from the buyer-intel
      // card, the admin panel, and anywhere else that needs to know
      // "is this counterparty blocked?"
      await this.screens.updateOrgState(ctx.tx, org.id, {
        status,
        screenedAt: new Date(),
        highestScore,
      });
      internalWrites++;

      // Best-effort push of the verdict back to procur for orgs we
      // know about there. Fires for `clear` AND `potential_match` so
      // procur learns "vex screened this and it came back clean as
      // of T". `cleared_by_operator` is intentionally NOT shared —
      // see shareOrgSanctionsStatus docstring (operator decisions
      // stay tenant-local). Failure is fail-soft: a 5xx from procur
      // doesn't fail the screen run; we just log and move on.
      //
      // `sourcesChecked` is the set of lists this run actually ran
      // against. On the current single-adapter agent that's always
      // `["us_csl"]`. The multi-list agent (#290) will pass the
      // workspace's `enabled_sanctions_lists` here.
      await this.maybeShareSanctionsToProcur(
        ctx,
        org,
        status,
        matches,
        ["us_csl"],
      );

      if (status === "clear") {
        clearCount++;
        continue;
      }

      potentialCount++;
      potentialMatchOrgs.push(org.legalName);

      // Signal — lands in the signals inbox at critical severity. The
      // SignalRepository.fire call is idempotent on
      // (tenant, ruleId, subjectId) so re-running this agent against
      // the same org doesn't produce duplicate open signals.
      const top = matches[0]!;
      const topSourceList = (top.entry as Partial<CslEntry>).sourceList ?? "SDN";
      await this.signals.fire(ctx.tx, ctx.tenantId, {
        ruleId: "ofac.potential_match",
        severity: "critical",
        subjectType: "organization",
        subjectId: org.id,
        title: `Sanctions screen: potential ${topSourceList} match for ${org.legalName}`,
        body:
          `Highest match score: ${(top.score * 100).toFixed(1)}% (${topSourceList}). ` +
          `Matched: ${top.matchedName} (${top.entry.programs.join(", ") || "no programs listed"}). ` +
          `Review required before any deal execution.`,
        metadata: {
          matches: matches.map(toMatchRecord),
          screenedAt: new Date().toISOString(),
          sdnUid: top.entry.uid,
          highestScore: top.score,
          sourceLists: [...new Set(matches.map(
            (m) => (m.entry as Partial<CslEntry>).sourceList ?? "SDN",
          ))],
        },
      });
      internalWrites++;

      // T3 proposed action — blocks deal execution until an operator
      // reviews. AgentRunner routes T3 through ApprovalGate.
      proposedActions.push({
        tier: "T3",
        kind: "ofac.hold",
        rationale:
          `${org.legalName}: ${(top.score * 100).toFixed(1)}% match ` +
          `against ${topSourceList} uid ${top.entry.uid} (${top.matchedName}).`,
        payload: {
          org_id: org.id,
          org_name: org.legalName,
          highest_score: top.score,
          matched_entry: {
            uid: top.entry.uid,
            name: top.matchedName,
            sdn_type: top.entry.sdnType,
            programs: top.entry.programs,
            source_list: topSourceList,
          },
          recommended_action: "suspend_all_deals_pending_review",
        },
      });
    }

    // Workspace-level summary — one line per run, lands on the admin
    // overview so "did the OFAC screen run today?" is answerable at a
    // glance.
    await ctx.summaries.upsert(ctx.tx, ctx.tenantId, {
      subjectType: "workspace",
      subjectId: ctx.workspaceId,
      summaryType: "ofac_screen_run",
      content:
        `Screened ${orgs.length} ${orgs.length === 1 ? "organization" : "organizations"}. ` +
        `${clearCount} clear. ` +
        `${potentialCount} potential ${potentialCount === 1 ? "match" : "matches"}` +
        (potentialMatchOrgs.length > 0
          ? `: ${potentialMatchOrgs.slice(0, 5).join(", ")}${potentialMatchOrgs.length > 5 ? "…" : ""}. `
          : ". ") +
        (potentialCount > 0 ? "Review required." : "No action required."),
    });
    internalWrites++;

    return {
      costUsd: 0,
      outputRefs: {
        total: orgs.length,
        clear: clearCount,
        potential_matches: potentialCount,
        orgs_held: potentialMatchOrgs,
        sdn_list_date: sdnListDate,
      },
      proposedActions,
      internalWrites,
      rationale:
        potentialCount > 0
          ? `${potentialCount}/${orgs.length} organizations flagged for OFAC review`
          : `${orgs.length}/${orgs.length} organizations clear`,
    };
  }

  /**
   * Best-effort push of the screening verdict back to procur. Mirrors
   * the contact-enrichment share path (`maybeShareToProcur` in
   * contact-enrichment.ts): only fires for orgs procur already
   * knows about (`external_keys.procur` set), only when procur is
   * configured, and a failure here never fails the screen run.
   *
   * Privacy posture is documented on `ProcurClient.shareOrgSanctionsScreen`.
   * Short version: share status + public list metadata + banded
   * confidence + an opaque `vex_tenant_id` so procur can attribute
   * cross-tenant disagreement. Don't share raw scores, matched-name
   * strings, or operator-cleared decisions.
   *
   * Each call generates a fresh UUIDv4 `screenId` so procur dedupes
   * on `(vex_tenant_id, screen_id)` for retry safety. We don't need
   * the screen id on our side post-call — procur stores it; vex's
   * own audit row is keyed by `id` in the `ofac_screens` table.
   */
  private async maybeShareSanctionsToProcur(
    ctx: AgentContext,
    org: Organization,
    status: OfacScreenStatus,
    matches: SdnScreenResult[],
    sourcesChecked: string[],
  ): Promise<void> {
    // Operator-cleared verdicts stay tenant-local — procur's reviewers
    // make their own judgement on the underlying objective match.
    if (status === "cleared_by_operator") return;
    const procurSlug = (org.externalKeys as Record<string, string> | null)?.[
      "procur"
    ];
    if (!procurSlug) return;
    if (!ctx.procur.isEnabled()) return;

    const shareMatches = matches.map((r) => {
      const sourceList =
        (r.entry as Partial<CslEntry>).sourceList ?? "SDN";
      return {
        sourceList,
        sdnUid: r.entry.uid,
        programs: r.entry.programs,
        confidenceBand:
          r.score >= HIGH_CONFIDENCE_THRESHOLD
            ? ("high_confidence" as const)
            : ("fuzzy_review" as const),
        sdnType: r.entry.sdnType,
      };
    });

    try {
      await ctx.procur.shareOrgSanctionsScreen({
        entitySlug: procurSlug,
        vexTenantId: ctx.tenantId,
        screenId: randomUUID(),
        legalName: org.legalName,
        status: status as "clear" | "potential_match" | "confirmed_match",
        sourcesChecked,
        matches: shareMatches,
        screenedAt: new Date().toISOString(),
      });
    } catch {
      /* fail-soft — a procur outage shouldn't fail the screen run */
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadSingleOrg(
  ctx: AgentContext,
  orgId: string,
): Promise<Organization[]> {
  const row = await ctx.organizations.findById(ctx.tx, orgId);
  return row ? [row] : [];
}

/**
 * Screen one org against every enabled sanctions source and merge
 * the hits into a single newest-first-sorted list. Also pulls any
 * aliases stored in `field_confidence` so an org's known AKAs are
 * compared too.
 *
 * Dedupe key is `(sourceList, uid, matchedName)` — the same target
 * appearing on multiple lists (e.g. an SDN listing also on the EU
 * regime list and the UK OFSI list) produces three separate match
 * rows so the reviewer sees the cross-list confirmation.
 */
function screenOrgAcrossSources(
  org: Organization,
  entriesPerSource: ReadonlyMap<SanctionsSource, SdnEntry[]>,
  adapters: ReadonlyMap<SanctionsSource, SanctionsAdapter>,
): SdnScreenResult[] {
  const seen = new Set<string>();
  const combined: SdnScreenResult[] = [];
  const names = new Set<string>([org.legalName]);
  const aliasesEntry = org.fieldConfidence?.["aliases"]?.value;
  if (Array.isArray(aliasesEntry)) {
    for (const a of aliasesEntry) {
      if (typeof a === "string" && a.trim()) names.add(a);
    }
  }
  for (const [source, adapter] of adapters) {
    const entries = entriesPerSource.get(source) ?? [];
    if (entries.length === 0) continue;
    for (const name of names) {
      const results = adapter.screen(name, entries, SCORE_THRESHOLD);
      for (const r of results) {
        const sourceList =
          (r.entry as Partial<CslEntry>).sourceList ??
          fallbackSourceForAdapter(source);
        const key = `${sourceList}:${r.entry.uid}:${r.matchedName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        combined.push(r);
      }
    }
  }
  combined.sort((a, b) => b.score - a.score);
  return combined;
}

/**
 * Source-list fallback for adapters whose entries don't carry a
 * `sourceList` tag (legacy `OFACSdnAdapter`). All other adapters
 * (CSL/EU/UK) populate the field on every entry; this fallback
 * only fires for the SDN-only path.
 */
function fallbackSourceForAdapter(source: SanctionsSource): string {
  if (source === "eu") return "EU";
  if (source === "uk_ofsi") return "UK_OFSI";
  return "SDN";
}

function deriveStatus(matches: SdnScreenResult[]): OfacScreenStatus {
  if (matches.length === 0) return "clear";
  const top = matches[0]!;
  if (top.score >= HIGH_CONFIDENCE_THRESHOLD) return "potential_match";
  return "potential_match";
}

function toMatchRecord(r: SdnScreenResult): OfacMatchRecord {
  // CSL entries carry a `sourceList` tag; OFAC SDN entries don't.
  // Capture it when present so the reviewer UI can render a list-
  // specific chip (BIS Entity List vs OFAC SDN, etc). Historical
  // rows written before this field existed read as undefined and
  // the UI treats those as legacy SDN.
  const cslEntry = r.entry as Partial<CslEntry>;
  const sourceList = cslEntry.sourceList;
  return {
    sdnUid: r.entry.uid,
    matchedName: r.matchedName,
    score: r.score,
    matchType: r.matchType,
    programs: r.entry.programs,
    sdnType: r.entry.sdnType,
    ...(sourceList ? { sourceList } : {}),
  };
}

/**
 * Decide which US-side adapter the agent uses (legacy SDN vs CSL).
 * Reads `SCREENING_SOURCE` env var; defaults to OFAC SDN so existing
 * tenants keep today's behaviour until an operator deliberately opts
 * in. EU / UK adapters are independent of this — they're added to
 * the enabled-list set directly via the workspace setting.
 */
function resolveScreeningSource(): ScreeningSource {
  const envSource = process.env["SCREENING_SOURCE"]?.toLowerCase();
  if (envSource === "csl") return "csl";
  return "ofac";
}

/**
 * Resolve the per-tenant sanctions list set from the workspace's
 * `enabled_sanctions_lists` setting. Default `["us_csl"]` when
 * unset / empty so existing workspaces keep today's behaviour. We
 * read directly via `ctx.tx` (not the WorkspaceRepository) because
 * its methods open a fresh transaction; nesting that inside the
 * already-open agent tx would burn a savepoint we don't need.
 */
async function resolveEnabledLists(
  ctx: AgentContext,
): Promise<SanctionsSource[]> {
  try {
    const rows = await ctx.tx
      .select({ settings: schema.workspaces.settings })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, ctx.tenantId))
      .limit(1);
    const list = rows[0]?.settings?.enabled_sanctions_lists;
    if (Array.isArray(list) && list.length > 0) {
      return list.filter((s): s is SanctionsSource =>
        s === "us_csl" || s === "eu" || s === "uk_ofsi",
      );
    }
  } catch {
    /* fall through to default */
  }
  return ["us_csl"];
}

/**
 * Construct one adapter per enabled list. Each adapter owns its
 * own in-memory cache so a batch screen across N orgs only fetches
 * each list once. The US adapter respects the legacy
 * `SCREENING_SOURCE` env (SDN vs CSL).
 */
function buildAdapters(
  enabled: readonly SanctionsSource[],
): Map<SanctionsSource, SanctionsAdapter> {
  const out = new Map<SanctionsSource, SanctionsAdapter>();
  for (const source of enabled) {
    if (source === "us_csl") {
      out.set(
        "us_csl",
        resolveScreeningSource() === "csl"
          ? new CSLAdapter()
          : new OFACSdnAdapter(),
      );
    } else if (source === "eu") {
      out.set("eu", new EUConsolidatedAdapter());
    } else if (source === "uk_ofsi") {
      out.set("uk_ofsi", new UKOFSIAdapter());
    }
  }
  return out;
}

/**
 * Pull each adapter's snapshot in parallel. Failures bubble — a
 * compliance run with half its sources offline is worse than no
 * run at all because an operator who sees "clear" expects every
 * enabled list to have contributed.
 */
async function loadEntriesPerSource(
  adapters: ReadonlyMap<SanctionsSource, SanctionsAdapter>,
): Promise<Map<SanctionsSource, SdnEntry[]>> {
  const tasks: Promise<[SanctionsSource, SdnEntry[]]>[] = [];
  for (const [source, adapter] of adapters) {
    tasks.push(
      adapter.getEntries().then((entries) => [source, entries] as const),
    );
  }
  const results = await Promise.all(tasks);
  return new Map(results);
}

/**
 * Used by the counterparty score pipeline to translate a screen into a
 * `sanctions_exposure_risk` 0..100 score. Exposed so the score upsert
 * path (today called from seed + manual review; future: wired into the
 * agent once the counterparty score has a mutator hook) uses the same
 * cut-offs as the screen.
 */
export function sanctionsExposureRiskFor(
  status: OfacScreenStatus,
  highestScore: number,
): number {
  switch (status) {
    case "clear":
      return 5;
    case "cleared_by_operator":
      return 15;
    case "potential_match":
      return highestScore >= HIGH_CONFIDENCE_THRESHOLD ? 90 : 70;
    case "confirmed_match":
      return 100;
    case "unscreened":
    default:
      return 50;
  }
}
