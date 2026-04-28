import { buildProcurQueryHash } from "@vex/integrations";
import type { SupplierProfile } from "@vex/integrations";
import type { AgentContext, AgentOutput, IAgent } from "./types.js";

export interface ProcurEnrichmentInput {
  organizationId: string;
  /** When true, skip the snapshot cache and force a fresh procur call. */
  force?: boolean;
}

/**
 * Brief: docs/procur-integration.md §3.1.
 *
 * For a given organization, hydrates procur intelligence into vex:
 *   - calls procur.analyzeSupplier (and analyzeSupplierPricing if the
 *     org is a supplier or broker)
 *   - upserts a `procur_intelligence_snapshots` row per result
 *   - writes a `procur_intelligence_brief` summary
 *   - appends procur:* tags to the org
 *   - updates fieldConfidence on country / kind when procur gives a
 *     stronger value than what's on file
 *   - raises a signal when distress signals or disambiguation is detected
 *
 * Tier T1 — internal writes only. No outbound contact, no T2 actions.
 *
 * Fail-soft contract:
 *   - If procur is disabled (env unset), skips with a clear rationale
 *     and returns 0 internal writes. The org keeps whatever
 *     intelligence it already had.
 *   - If procur returns http_error / timeout / exception, prefers the
 *     last-known stale snapshot when one exists (so the UI doesn't
 *     suddenly drop intelligence during a procur outage). When no
 *     snapshot exists, skips with a rationale carrying the reason.
 *   - If procur returns disambiguation_needed, raises a signal with
 *     the candidate list so the operator can pick the right entity,
 *     and exits without writing the summary.
 *   - If procur returns not_found, tags the org `procur:not_in_database`
 *     so the operator can see procur was queried and didn't have a
 *     match — distinct from "we never tried."
 */
export class ProcurEnrichmentAgent implements IAgent {
  readonly name = "procur_enrichment";
  readonly tier = "T1" as const;

  constructor(private readonly input: ProcurEnrichmentInput) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const org = await ctx.organizations.findById(
      ctx.tx,
      this.input.organizationId,
    );
    if (!org) {
      return {
        costUsd: 0,
        outputRefs: { skipped: "org_not_found" },
        proposedActions: [],
        internalWrites: 0,
        rationale: `org ${this.input.organizationId} not in scope`,
      };
    }

    if (!ctx.procur.isEnabled()) {
      return {
        costUsd: 0,
        outputRefs: { skipped: "procur_disabled", org_id: org.id },
        proposedActions: [],
        internalWrites: 0,
        rationale:
          "procur env (PROCUR_API_BASE_URL + PROCUR_API_TOKEN) not configured",
      };
    }

    const ttlMs = ctx.procurCacheTtlDays * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + ttlMs);
    let internalWrites = 0;

    // ----- analyze_supplier ----------------------------------------------
    const supplierArgs = {
      supplierName: org.legalName,
    };
    const supplierTool = "analyze_supplier";
    const supplierHash = buildProcurQueryHash(supplierTool, supplierArgs);

    let supplierData: SupplierProfile | null = null;
    let supplierFromCache = false;

    if (!this.input.force) {
      const fresh = await ctx.procurSnapshots.findFresh(
        ctx.tx,
        org.id,
        supplierTool,
        supplierHash,
      );
      if (fresh) {
        supplierFromCache = true;
        const cached = fresh.payload as Record<string, unknown>;
        if (cached["kind"] === "profile") {
          supplierData = cached as unknown as SupplierProfile;
        }
      }
    }

    if (!supplierData) {
      const result = await ctx.procur.analyzeSupplier(supplierArgs);
      if (result.ok) {
        await ctx.procurSnapshots.upsert(ctx.tx, ctx.tenantId, {
          orgId: org.id,
          procurTool: supplierTool,
          queryHash: supplierHash,
          payload: result.data as unknown as Record<string, unknown>,
          expiresAt,
        });
        internalWrites += 1;

        if (result.data.kind === "disambiguation_needed") {
          await ctx.signals.fire(ctx.tx, ctx.tenantId, {
            ruleId: "procur.disambiguation_needed",
            severity: "warn",
            subjectType: "organization",
            subjectId: org.id,
            title: `procur returned ${result.data.candidates.length} candidates for "${org.legalName}"`,
            body: "Pick the right entity in the org's procur tab so future enrichment locks onto a single supplier id.",
            metadata: { candidates: result.data.candidates },
          });
          return {
            costUsd: 0,
            outputRefs: {
              org_id: org.id,
              procur_status: "disambiguation_needed",
              candidates: result.data.candidates.length,
            },
            proposedActions: [],
            internalWrites,
            rationale: `procur disambiguation: ${result.data.candidates.length} candidates`,
          };
        }

        if (result.data.kind === "not_found") {
          await ctx.organizations.appendTag(ctx.tx, org.id, "procur:not_in_database");
          internalWrites += 1;
          return {
            costUsd: 0,
            outputRefs: {
              org_id: org.id,
              procur_status: "not_found",
            },
            proposedActions: [],
            internalWrites,
            rationale: "procur has no entity matching this org",
          };
        }

        supplierData = result.data;
      } else {
        // Procur error path. Try to fall back to a stale snapshot so
        // the operator sees last-known intelligence rather than
        // nothing during a procur outage.
        const stale = await ctx.procurSnapshots.findAny(
          ctx.tx,
          org.id,
          supplierTool,
          supplierHash,
        );
        const staleProfile =
          stale && (stale.payload as Record<string, unknown>)["kind"] === "profile"
            ? (stale.payload as unknown as SupplierProfile)
            : null;
        if (!staleProfile) {
          return {
            costUsd: 0,
            outputRefs: {
              org_id: org.id,
              procur_status: result.reason,
            },
            proposedActions: [],
            internalWrites,
            rationale: `procur unavailable: ${result.reason}; no cached snapshot`,
          };
        }
        supplierFromCache = true;
        supplierData = staleProfile;
      }
    }

    // ----- profile-derived writes (tags, fieldConfidence, summary) -------
    if (supplierData) {
      const profile = supplierData;

      // Append procur:* tags. Idempotent — duplicate tags are
      // de-duped server-side by appendTag's jsonb_agg(DISTINCT ...).
      const tagsToAdd: string[] = [];
      tagsToAdd.push("procur:tracked");
      if (profile.role === "refiner") tagsToAdd.push("procur:refiner");
      if (profile.role === "trader") tagsToAdd.push("procur:trader");
      if (profile.recentAwardCount >= 5)
        tagsToAdd.push("procur:high_award_velocity");
      if (
        profile.daysSinceLastAward !== null &&
        profile.daysSinceLastAward >= 180
      ) {
        tagsToAdd.push("procur:stale_award_history");
      }
      for (const tag of profile.tags) {
        tagsToAdd.push(`procur:${tag}`);
      }
      for (const tag of tagsToAdd) {
        await ctx.organizations.appendTag(ctx.tx, org.id, tag);
        internalWrites += 1;
      }

      // FieldConfidence — country and kind. Procur evidence is high
      // confidence; only overwrite when the existing value is missing
      // or the procur value is identical (idempotent re-stamp).
      if (profile.country) {
        await ctx.organizations.updateFieldConfidence(
          ctx.tx,
          org.id,
          "country",
          profile.country,
          "agent.procur_enrichment",
          0.85,
        );
        internalWrites += 1;
      }
      if (profile.role) {
        await ctx.organizations.updateFieldConfidence(
          ctx.tx,
          org.id,
          "kind",
          profile.role,
          "agent.procur_enrichment",
          0.8,
        );
        internalWrites += 1;
      }

      // Summary — operator-readable brief.
      const summaryContent = renderSupplierProfile(profile, supplierFromCache);
      await ctx.summaries.upsert(ctx.tx, ctx.tenantId, {
        subjectType: "organization",
        subjectId: org.id,
        summaryType: "procur_intelligence_brief",
        content: summaryContent,
      });
      internalWrites += 1;

      // Distress signals — surface every non-empty signal as a vex
      // signal so the operator sees it in /app/signals.
      for (const distress of profile.distressSignals) {
        await ctx.signals.fire(ctx.tx, ctx.tenantId, {
          ruleId: `procur.distress.${distress.kind}`,
          severity: "warn",
          subjectType: "organization",
          subjectId: org.id,
          title: `${profile.legalName}: ${distress.kind}`,
          body: distress.detail,
          metadata: {
            observed_at: distress.observedAt,
            supplier_id: profile.supplierId,
          },
        });
        internalWrites += 1;
      }
    }

    // ----- analyze_supplier_pricing (suppliers + brokers only) -----------
    const isSupplierLike =
      org.kind === "supplier" ||
      org.kind === "broker" ||
      supplierData?.role === "refiner" ||
      supplierData?.role === "trader";

    let pricingFetched = false;
    if (isSupplierLike) {
      const pricingArgs = { supplierName: org.legalName };
      const pricingTool = "analyze_supplier_pricing";
      const pricingHash = buildProcurQueryHash(pricingTool, pricingArgs);

      const pricingFresh =
        !this.input.force
          ? await ctx.procurSnapshots.findFresh(
              ctx.tx,
              org.id,
              pricingTool,
              pricingHash,
            )
          : null;

      if (!pricingFresh) {
        const pricing = await ctx.procur.analyzeSupplierPricing(pricingArgs);
        if (pricing.ok) {
          await ctx.procurSnapshots.upsert(ctx.tx, ctx.tenantId, {
            orgId: org.id,
            procurTool: pricingTool,
            queryHash: pricingHash,
            payload: pricing.data as unknown as Record<string, unknown>,
            expiresAt,
          });
          internalWrites += 1;
          pricingFetched = true;
        }
      }
    }

    return {
      costUsd: 0,
      outputRefs: {
        org_id: org.id,
        procur_status: supplierData ? "profile" : "no_data",
        from_cache: supplierFromCache,
        pricing_fetched: pricingFetched,
        ...(supplierData
          ? { supplier_id: supplierData.supplierId, role: supplierData.role }
          : {}),
      },
      proposedActions: [],
      internalWrites,
      rationale: supplierData
        ? `procur enrichment: ${supplierData.role ?? "unknown role"} · ${supplierData.awardCount} awards · ${supplierData.distressSignals.length} distress signals${supplierFromCache ? " (cached)" : ""}`
        : "procur enrichment skipped: no profile data",
    };
  }
}

/**
 * Render a SupplierProfile as a markdown brief the operator-facing
 * org-detail UI can display directly. Deterministic — same profile
 * always renders the same string so the summary table doesn't churn
 * unnecessarily on identical re-runs.
 */
function renderSupplierProfile(
  p: SupplierProfile,
  fromCache: boolean,
): string {
  const lines: string[] = [];
  lines.push(`# Procur intelligence brief — ${p.legalName}`);
  if (fromCache) {
    lines.push(`_Served from cached snapshot — procur unreachable on last fetch._`);
  }
  lines.push("");
  if (p.role || p.country) {
    const bits: string[] = [];
    if (p.role) bits.push(p.role);
    if (p.country) bits.push(p.country);
    lines.push(`**Profile:** ${bits.join(" · ")}`);
  }
  if (p.categories.length > 0) {
    lines.push(`**Categories:** ${p.categories.join(", ")}`);
  }
  lines.push("");
  lines.push(
    `**Award activity:** ${p.awardCount} total · ${p.recentAwardCount} recent` +
      (p.awardTotalUsd !== null
        ? ` · $${p.awardTotalUsd.toLocaleString()} cumulative`
        : ""),
  );
  if (p.daysSinceLastAward !== null) {
    lines.push(`**Last award:** ${p.daysSinceLastAward} days ago`);
  }
  if (p.tags.length > 0) {
    lines.push(`**Tags:** ${p.tags.join(", ")}`);
  }
  if (p.distressSignals.length > 0) {
    lines.push("");
    lines.push("**Distress signals:**");
    for (const d of p.distressSignals) {
      lines.push(`- ${d.kind} (${d.observedAt}): ${d.detail}`);
    }
  }
  if (p.notes) {
    lines.push("");
    lines.push(`**Notes:** ${p.notes}`);
  }
  return lines.join("\n");
}
