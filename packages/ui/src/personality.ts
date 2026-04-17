/**
 * Vex voice + copy system.
 *
 * Single source of truth for every user-facing string the web surface,
 * the chat canvas, and the agent prompts emit. Components never invent
 * a greeting — they pick one from {@link vexCopy}. Agent prompts
 * reference {@link VEX_VOICE} when instructing the model on tone.
 *
 * Voice summary: crisp, commercially sharp, proactive, calm, slightly
 * challenging. Chief-of-staff energy. Never sycophantic, never verbose.
 */

// ---------------------------------------------------------------------------
// Voice guidelines — documentation only, not consumed at runtime. Included
// verbatim in agent system prompts so the model writes in the same voice.
// ---------------------------------------------------------------------------

export const VEX_VOICE = {
  tone: "crisp, commercially sharp, proactive, calm, slightly challenging",
  archetype: "chief of staff to a revenue leader — never sycophantic",
  sentence_length: "short. one or two clauses.",
  pronouns:
    "first person for Vex ('I', 'Vex'); second person for the user ('you').",
  forbidden: [
    "apologies without reason",
    "filler words: 'just', 'simply', 'basically'",
    "exclamation marks",
    "emoji in primary copy",
    "hedging: 'maybe', 'perhaps', 'kind of'",
    "empty empathy: 'I understand', 'great question'",
  ],
  preferred: [
    "active voice",
    "imperatives in approval prompts",
    "numbers with units, not adjectives",
    "concrete nouns over abstractions",
    "lead with the decision, trailing rationale in one clause",
  ],
} as const;

export type VexPersonality = typeof VEX_VOICE;

// ---------------------------------------------------------------------------
// Copy — organized by surface. Strings with {placeholders} are rendered
// through formatVexCopy; plain strings are used verbatim.
// ---------------------------------------------------------------------------

export const vexCopy = {
  brief: {
    greeting_morning: "Here's what needs your attention today.",
    greeting_afternoon: "Here's where things stand.",
    nothing_urgent: "Pipeline is moving. Nothing urgent.",
    all_clear: "Vex handled the routine. Focus on these.",
  },
  approvals: {
    prompt: "Vex is proposing this. Review before it goes out.",
    confirm: "Confirmed. Vex will proceed.",
    reject: "Noted. Vex will stand down.",
    auto_approved: "Handled automatically — low risk.",
    needs_attention: "This one needs your eyes.",
  },
  uncertainty: {
    low_confidence: "Best current view — limited evidence.",
    disambiguation: "Found more than one match. Which did you mean?",
    confirm_entity: "I think this relates to {entity}. Correct?",
    confirm_update: "This may change {field}. Approve?",
    stale_data: "This data is {hours}h old. Treat with caution.",
  },
  agents: {
    working: "Vex is on it.",
    completed: "Done.",
    blocked: "Blocked — needs your input.",
    skipped: "Skipped — policy.",
    failed: "Failed. Review required.",
  },
  deals: {
    strong: "Strong deal. Proceed.",
    acceptable: "Acceptable. Watch the margin.",
    marginal: "Marginal. Negotiate harder or walk.",
    do_not_proceed: "Do not proceed. {reason}",
    critical_warning: "Stop. {warning}",
    vessel_underutilized:
      "Freight is {multiplier}x optimal. Fill the vessel or restructure.",
  },
  navigation: {
    context_chip_deal: "Deal · {dealRef}",
    context_chip_org: "Company · {name}",
    context_chip_contact: "Contact · {name}",
    context_chip_mode: "{mode} mode",
    exit_workspace: "Exit workspace",
    back_to_brief: "Back to brief",
  },
} as const;

export type VexCopy = typeof vexCopy;
export type VexCopySurface = keyof VexCopy;

// ---------------------------------------------------------------------------
// Template formatter
// ---------------------------------------------------------------------------

/**
 * Replace `{key}` placeholders in `template` with values from `vars`.
 *
 * Contract:
 *   - When `template` has no `{` character the string is returned as-is
 *     (fast path — avoids the regex allocation in the hot render loop).
 *   - When a placeholder has no matching key in `vars`, the original
 *     `{key}` marker is left in place. The formatter never throws, so
 *     a missing var can't crash a component that's already rendering.
 *   - Keys match `\w+` (alphanumerics + underscore). That's the set of
 *     characters actually used by {@link vexCopy}; tighter than
 *     free-form so malformed templates don't silently swallow braces.
 */
export function formatVexCopy(
  template: string,
  vars: Record<string, string>,
): string {
  if (template.indexOf("{") === -1) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = vars[key];
    return value !== undefined ? value : match;
  });
}
