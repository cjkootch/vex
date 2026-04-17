import type {
  ApprovalRepository,
  ContactRepository,
  OrganizationRepository,
  SummaryRepository,
  TouchpointRepository,
  Tx,
} from "@vex/db";
import {
  DEFAULT_VOICE_TOKEN_BUDGET,
  type TokenBudget,
  type VoiceContext,
  type VoiceContextBlock,
} from "./types.js";
import { countTokens, truncateToTokens } from "./token-counter.js";

export interface VoiceContextBuilderDeps {
  organizations: OrganizationRepository;
  contacts: ContactRepository;
  summaries: SummaryRepository;
  touchpoints: TouchpointRepository;
  approvals: ApprovalRepository;
}

export interface BuildContextParams {
  orgId: string | null;
  contactId: string | null;
  budget?: TokenBudget;
}

/**
 * Assemble a voice-call brief that fits in a token budget.
 *
 * Priority (spec):
 *   1. Latest org summary                (target 800 tokens)
 *   2. Last 3 call summaries             (target 600 each)
 *   3. Open follow-ups from approvals    (target 400 each)
 *   4. Key contact names + titles        (target 120 each)
 *   5. Recent email-click touchpoints    (target 200 each)
 *
 * Each block is per-capped so a noisy source can't crowd everything else
 * out. After collection we enforce `budget.hardMax` by truncating the
 * lowest-priority (oldest) blocks first — never throws.
 *
 * All reads happen inside the caller's `Tx` so RLS scopes them to the
 * current tenant.
 */
export class VoiceContextBuilder {
  constructor(private readonly deps: VoiceContextBuilderDeps) {}

  async build(tx: Tx, params: BuildContextParams): Promise<VoiceContext> {
    const budget = params.budget ?? DEFAULT_VOICE_TOKEN_BUDGET;

    const orgSummary = params.orgId
      ? await this.fetchOrgSummary(tx, params.orgId, budget.perBlock.orgSummary)
      : null;

    const recentCalls = params.orgId
      ? await this.fetchRecentCalls(tx, params.orgId, budget.perBlock.recentCall)
      : [];

    const openFollowUps = await this.fetchOpenFollowUps(
      tx,
      params.orgId,
      params.contactId,
      budget.perBlock.openFollowUp,
    );

    const keyContacts = params.orgId
      ? await this.fetchKeyContacts(tx, params.orgId, budget.perBlock.keyContact)
      : [];

    const recentEmailClicks = params.orgId
      ? await this.fetchRecentEmailClicks(
          tx,
          params.orgId,
          budget.perBlock.emailClick,
        )
      : [];

    const draft: VoiceContext = {
      orgId: params.orgId,
      contactId: params.contactId,
      orgSummary,
      recentCalls,
      openFollowUps,
      keyContacts,
      recentEmailClicks,
      totalEstimatedTokens: 0,
      budget,
      truncated: false,
    };
    draft.totalEstimatedTokens = estimateTotal(draft);

    return enforceHardMax(draft);
  }

  private async fetchOrgSummary(
    tx: Tx,
    orgId: string,
    cap: number,
  ): Promise<VoiceContextBlock | null> {
    const [summary, org] = await Promise.all([
      this.deps.summaries.getLatest(tx, "organization", orgId, "org_brief"),
      this.deps.organizations.findById(tx, orgId),
    ]);
    const header = org
      ? `${org.legalName}${org.industry ? ` · ${org.industry}` : ""}${
          org.fitScore != null ? ` · fit ${org.fitScore.toFixed(2)}` : ""
        }`
      : `organization ${orgId}`;
    if (!summary) {
      const text = header;
      return {
        kind: "org_summary",
        label: "Organization",
        text,
        estimatedTokens: countTokens(text),
      };
    }
    const full = `${header}\n\n${summary.content}`;
    const capped = truncateToTokens(full, cap);
    return {
      kind: "org_summary",
      label: "Organization",
      text: capped.text,
      estimatedTokens: capped.tokens,
    };
  }

  private async fetchRecentCalls(
    tx: Tx,
    orgId: string,
    cap: number,
  ): Promise<VoiceContextBlock[]> {
    const rows = await this.deps.summaries.listBySubject(tx, "organization", orgId);
    const calls = rows
      .filter((r) => r.summaryType === "call_summary")
      .slice(0, 3);
    return calls.map((row, i) => {
      const header = `Call ${i + 1} · ${row.createdAt.toISOString()}`;
      const capped = truncateToTokens(`${header}\n${row.content}`, cap);
      return {
        kind: "recent_call",
        label: `Recent call ${i + 1}`,
        text: capped.text,
        estimatedTokens: capped.tokens,
      };
    });
  }

  private async fetchOpenFollowUps(
    tx: Tx,
    orgId: string | null,
    contactId: string | null,
    cap: number,
  ): Promise<VoiceContextBlock[]> {
    const pending = await this.deps.approvals.listByDecision(tx, "pending", 50);
    const scoped = pending.filter((row) => {
      if (!orgId && !contactId) return false;
      const payload = (row.proposedPayload ?? {}) as Record<string, unknown>;
      const po = typeof payload["org_id"] === "string" ? payload["org_id"] : null;
      const pc = typeof payload["contact_id"] === "string" ? payload["contact_id"] : null;
      return (orgId && po === orgId) || (contactId && pc === contactId);
    });
    return scoped.slice(0, 5).map((row) => {
      const text = `[${row.actionType}] ${summariseActionPayload(row.proposedPayload)}`;
      const capped = truncateToTokens(text, cap);
      return {
        kind: "open_follow_up",
        label: "Open follow-up",
        text: capped.text,
        estimatedTokens: capped.tokens,
      };
    });
  }

  private async fetchKeyContacts(
    tx: Tx,
    orgId: string,
    cap: number,
  ): Promise<VoiceContextBlock[]> {
    const rows = await this.deps.contacts.findByOrgId(tx, orgId);
    const scored = rows
      .filter((c) => c.status === "active")
      .sort((a, b) => (b.roleScore ?? 0) - (a.roleScore ?? 0))
      .slice(0, 6);
    return scored.map((c) => {
      const title = c.title ? ` — ${c.title}` : "";
      const capped = truncateToTokens(`${c.fullName}${title}`, cap);
      return {
        kind: "key_contact",
        label: "Contact",
        text: capped.text,
        estimatedTokens: capped.tokens,
      };
    });
  }

  private async fetchRecentEmailClicks(
    tx: Tx,
    orgId: string,
    cap: number,
  ): Promise<VoiceContextBlock[]> {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const rows = await this.deps.touchpoints.listForOrgSince(tx, orgId, since, 20);
    const clicks = rows.filter((r) => {
      const verb = (r.metadata as Record<string, unknown>)["verb"];
      return r.channel === "email" && typeof verb === "string" && verb.includes("click");
    });
    return clicks.slice(0, 5).map((r) => {
      const subject = (r.metadata as Record<string, unknown>)["subject"];
      const when = r.occurredAt.toISOString();
      const text = `${when} · ${typeof subject === "string" ? subject : "email click"}`;
      const capped = truncateToTokens(text, cap);
      return {
        kind: "email_click",
        label: "Email click",
        text: capped.text,
        estimatedTokens: capped.tokens,
      };
    });
  }
}

function summariseActionPayload(payload: Record<string, unknown>): string {
  const note = payload["note"] ?? payload["body"] ?? payload["subject"];
  if (typeof note === "string") return note.slice(0, 160);
  return JSON.stringify(payload).slice(0, 160);
}

function estimateTotal(ctx: VoiceContext): number {
  let total = 0;
  if (ctx.orgSummary) total += ctx.orgSummary.estimatedTokens;
  for (const b of ctx.recentCalls) total += b.estimatedTokens;
  for (const b of ctx.openFollowUps) total += b.estimatedTokens;
  for (const b of ctx.keyContacts) total += b.estimatedTokens;
  for (const b of ctx.recentEmailClicks) total += b.estimatedTokens;
  return total;
}

/**
 * Drop blocks (lowest priority first) until we're under budget.hardMax.
 * Priority order — lowest first: email_click, key_contact, open_follow_up,
 * recent_call (oldest first), org_summary.
 */
function enforceHardMax(ctx: VoiceContext): VoiceContext {
  if (ctx.totalEstimatedTokens <= ctx.budget.hardMax) return ctx;
  const out = { ...ctx, truncated: true };

  const prune = (list: VoiceContextBlock[]): VoiceContextBlock[] => {
    while (out.totalEstimatedTokens > out.budget.hardMax && list.length > 0) {
      const removed = list.pop();
      if (removed) out.totalEstimatedTokens -= removed.estimatedTokens;
    }
    return list;
  };

  out.recentEmailClicks = prune([...out.recentEmailClicks]);
  if (out.totalEstimatedTokens <= out.budget.hardMax) return out;
  out.keyContacts = prune([...out.keyContacts]);
  if (out.totalEstimatedTokens <= out.budget.hardMax) return out;
  out.openFollowUps = prune([...out.openFollowUps]);
  if (out.totalEstimatedTokens <= out.budget.hardMax) return out;
  out.recentCalls = prune([...out.recentCalls]);
  if (out.totalEstimatedTokens <= out.budget.hardMax) return out;

  if (out.orgSummary) {
    const room = Math.max(0, out.budget.hardMax);
    const capped = truncateToTokens(out.orgSummary.text, room);
    out.totalEstimatedTokens =
      out.totalEstimatedTokens - out.orgSummary.estimatedTokens + capped.tokens;
    out.orgSummary = {
      ...out.orgSummary,
      text: capped.text,
      estimatedTokens: capped.tokens,
    };
  }

  return out;
}

/**
 * Render the VoiceContext as a plain-text briefing the Realtime system
 * prompt / TranscriptProcessor can consume. Deterministic — same context
 * always renders the same string (prompt-cache friendly).
 */
export function renderVoiceContext(ctx: VoiceContext): string {
  const lines: string[] = [];
  lines.push("# Voice context brief");
  if (ctx.orgSummary) {
    lines.push("\n## Organization");
    lines.push(ctx.orgSummary.text);
  }
  if (ctx.recentCalls.length > 0) {
    lines.push("\n## Recent calls");
    for (const c of ctx.recentCalls) lines.push(c.text);
  }
  if (ctx.openFollowUps.length > 0) {
    lines.push("\n## Open follow-ups");
    for (const f of ctx.openFollowUps) lines.push(`- ${f.text}`);
  }
  if (ctx.keyContacts.length > 0) {
    lines.push("\n## Key contacts");
    for (const c of ctx.keyContacts) lines.push(`- ${c.text}`);
  }
  if (ctx.recentEmailClicks.length > 0) {
    lines.push("\n## Recent email clicks");
    for (const e of ctx.recentEmailClicks) lines.push(`- ${e.text}`);
  }
  return lines.join("\n");
}
