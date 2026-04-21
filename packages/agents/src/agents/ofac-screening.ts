import {
  OfacScreenRepository,
  SignalRepository,
  type OfacMatchRecord,
  type OfacScreenStatus,
  type Organization,
} from "@vex/db";
import {
  OFACSdnAdapter,
  type SdnEntry,
  type SdnScreenResult,
} from "@vex/integrations";
import type { ProposedAction } from "@vex/integrations";
import type { AgentContext, AgentOutput, IAgent } from "./types.js";

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
    private readonly adapter: OFACSdnAdapter = new OFACSdnAdapter(),
  ) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    // Pull the SDN list up front so every org in this run screens
    // against the same snapshot. Logged entry count makes it obvious
    // when the list itself is empty (common failure mode: the
    // download path redirected to an error page).
    const entries = await this.adapter.getEntries();
    if (entries.length === 0) {
      return {
        costUsd: 0,
        outputRefs: { skipped: "empty_sdn_list" },
        proposedActions: [],
        internalWrites: 0,
        rationale: "SDN list fetch returned 0 entries — skipping screen",
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
      const matches = screenOrg(org, entries, this.adapter);
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
      await this.signals.fire(ctx.tx, ctx.tenantId, {
        ruleId: "ofac.potential_match",
        severity: "critical",
        subjectType: "organization",
        subjectId: org.id,
        title: `OFAC screen: potential SDN match for ${org.legalName}`,
        body:
          `Highest match score: ${(top.score * 100).toFixed(1)}%. ` +
          `Matched: ${top.matchedName} (${top.entry.programs.join(", ") || "no programs listed"}). ` +
          `Review required before any deal execution.`,
        metadata: {
          matches: matches.map(toMatchRecord),
          screenedAt: new Date().toISOString(),
          sdnUid: top.entry.uid,
          highestScore: top.score,
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
          `against SDN uid ${top.entry.uid} (${top.matchedName}).`,
        payload: {
          org_id: org.id,
          org_name: org.legalName,
          highest_score: top.score,
          matched_entry: {
            uid: top.entry.uid,
            name: top.matchedName,
            sdn_type: top.entry.sdnType,
            programs: top.entry.programs,
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
 * Screen one org against the SDN list. Also pulls any aliases stored in
 * `field_confidence` so an org's known AKAs are compared too.
 */
function screenOrg(
  org: Organization,
  entries: SdnEntry[],
  adapter: OFACSdnAdapter,
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
  for (const name of names) {
    const results = adapter.screen(name, entries, SCORE_THRESHOLD);
    for (const r of results) {
      const key = `${r.entry.uid}:${r.matchedName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      combined.push(r);
    }
  }
  combined.sort((a, b) => b.score - a.score);
  return combined;
}

function deriveStatus(matches: SdnScreenResult[]): OfacScreenStatus {
  if (matches.length === 0) return "clear";
  const top = matches[0]!;
  if (top.score >= HIGH_CONFIDENCE_THRESHOLD) return "potential_match";
  return "potential_match";
}

function toMatchRecord(r: SdnScreenResult): OfacMatchRecord {
  return {
    sdnUid: r.entry.uid,
    matchedName: r.matchedName,
    score: r.score,
    matchType: r.matchType,
    programs: r.entry.programs,
    sdnType: r.entry.sdnType,
  };
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
