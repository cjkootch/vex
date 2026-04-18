/**
 * Narrow JSON DSL for campaign step gate conditions. The
 * CampaignEnrollmentWorkflow (Sprint D) evaluates the step's
 * `gate_condition_json` before dispatching — when it returns false
 * the step is skipped and the recipient advances with a history
 * entry explaining why.
 *
 * Grammar (kept deliberately tight so operators can hand-write it
 * without an editor):
 *
 *   node ::=
 *     | { "all": node[] }                   — AND
 *     | { "any": node[] }                   — OR
 *     | { "not": node }                     — NOT
 *     | { "intent": string }                — last touchpoint intent
 *     | { "intent_in": string[] }           — last intent ∈ set
 *     | { "opened_in_last_days": number }   — any email open within N days
 *     | { "clicked_in_last_days": number }  — any email click within N days
 *     | { "replied_in_last_days": number }  — any inbound touchpoint within N days
 *     | { "state": string }                 — enrollment.state
 *     | { "never" } / { "always" }          — trivial constants for tests
 *
 * Empty object `{}` short-circuits to true — treat "no condition" as
 * an unconditional gate so operators can skip the field entirely.
 */

export interface GateContext {
  /**
   * Most recent inbound-touchpoint `metadata.intent` string, if any.
   * Written by the intent classifier; null when no classifier has run.
   */
  lastIntent: string | null;
  /** Recent touchpoint timestamps keyed by kind. */
  recentSignals: {
    emailOpens: Date[];
    emailClicks: Date[];
    inboundReplies: Date[];
  };
  /** enrollment.state — steps can gate themselves on paused/enrolled/etc. */
  enrollmentState: string;
  /** Reference time for `*_in_last_days` comparisons. Defaults to now. */
  now?: Date;
}

export interface GateResult {
  ok: boolean;
  /** Human-readable trace of the decision. Appended to branch history. */
  reason: string;
}

export type GateNode =
  | { all: GateNode[] }
  | { any: GateNode[] }
  | { not: GateNode }
  | { intent: string }
  | { intent_in: string[] }
  | { opened_in_last_days: number }
  | { clicked_in_last_days: number }
  | { replied_in_last_days: number }
  | { state: string }
  | { never: true }
  | { always: true }
  | Record<string, never>;

export function evaluateGate(
  node: GateNode | undefined,
  ctx: GateContext,
): GateResult {
  if (!node || isEmpty(node)) return { ok: true, reason: "no gate" };
  const now = ctx.now ?? new Date();

  if ("all" in node) {
    const children = Array.isArray(node.all) ? node.all : [];
    for (const child of children) {
      const r = evaluateGate(child, ctx);
      if (!r.ok) return { ok: false, reason: `all: ${r.reason}` };
    }
    return { ok: true, reason: `all(${children.length})` };
  }

  if ("any" in node) {
    const children = Array.isArray(node.any) ? node.any : [];
    if (children.length === 0) return { ok: false, reason: "any: empty" };
    const reasons: string[] = [];
    for (const child of children) {
      const r = evaluateGate(child, ctx);
      if (r.ok) return { ok: true, reason: `any: ${r.reason}` };
      reasons.push(r.reason);
    }
    return { ok: false, reason: `any: none matched (${reasons.join(" | ")})` };
  }

  if ("not" in node) {
    const r = evaluateGate(node.not, ctx);
    return { ok: !r.ok, reason: `not(${r.reason})` };
  }

  if ("intent" in node) {
    const ok = ctx.lastIntent === node.intent;
    return {
      ok,
      reason: ok
        ? `intent=${node.intent}`
        : `intent ${ctx.lastIntent ?? "null"}≠${node.intent}`,
    };
  }

  if ("intent_in" in node) {
    const set = Array.isArray(node.intent_in) ? node.intent_in : [];
    const ok = ctx.lastIntent !== null && set.includes(ctx.lastIntent);
    return {
      ok,
      reason: ok
        ? `intent ${ctx.lastIntent} in [${set.join(",")}]`
        : `intent ${ctx.lastIntent ?? "null"} not in [${set.join(",")}]`,
    };
  }

  if ("opened_in_last_days" in node) {
    return checkRecent(
      "opened_in_last_days",
      node.opened_in_last_days,
      ctx.recentSignals.emailOpens,
      now,
    );
  }
  if ("clicked_in_last_days" in node) {
    return checkRecent(
      "clicked_in_last_days",
      node.clicked_in_last_days,
      ctx.recentSignals.emailClicks,
      now,
    );
  }
  if ("replied_in_last_days" in node) {
    return checkRecent(
      "replied_in_last_days",
      node.replied_in_last_days,
      ctx.recentSignals.inboundReplies,
      now,
    );
  }

  if ("state" in node) {
    const ok = ctx.enrollmentState === node.state;
    return {
      ok,
      reason: ok
        ? `state=${node.state}`
        : `state ${ctx.enrollmentState}≠${node.state}`,
    };
  }

  if ("never" in node) return { ok: false, reason: "never" };
  if ("always" in node) return { ok: true, reason: "always" };

  // Unknown operator — fail closed with a clear reason so bad gate
  // JSON doesn't silently slip a step through.
  const key = Object.keys(node as Record<string, unknown>)[0] ?? "<empty>";
  return { ok: false, reason: `unknown gate op: ${key}` };
}

function checkRecent(
  label: string,
  days: number,
  timestamps: Date[],
  now: Date,
): GateResult {
  if (!Number.isFinite(days) || days < 0) {
    return { ok: false, reason: `${label}: invalid days (${days})` };
  }
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  for (const t of timestamps) {
    if (t.getTime() >= cutoff) {
      return {
        ok: true,
        reason: `${label}: hit @ ${t.toISOString()}`,
      };
    }
  }
  return { ok: false, reason: `${label}: no hit in last ${days}d` };
}

function isEmpty(obj: unknown): boolean {
  return (
    typeof obj === "object" &&
    obj !== null &&
    !Array.isArray(obj) &&
    Object.keys(obj as Record<string, unknown>).length === 0
  );
}
