/**
 * Voice session shared types.
 *
 * A VoiceContext is the compact brief the VoicePanel UI shows before the
 * user starts a realtime call, and the TranscriptProcessor reuses after the
 * call to anchor the summarisation prompt. Everything in it is text-only —
 * no audio, no raw event blobs — so it can be safely embedded in a Claude
 * prompt and rendered in a browser pane.
 */
export interface VoiceContext {
  /** Optional org the call is scoped to. */
  orgId: string | null;
  /** Optional primary contact. */
  contactId: string | null;
  /** Latest org summary (or null if none). */
  orgSummary: VoiceContextBlock | null;
  /** Last ~3 recent call summaries (most recent first). */
  recentCalls: VoiceContextBlock[];
  /** Open follow-ups from the approval queue. */
  openFollowUps: VoiceContextBlock[];
  /** Key contacts (name + title). */
  keyContacts: VoiceContextBlock[];
  /** Recent email click activity (last 7 days). */
  recentEmailClicks: VoiceContextBlock[];
  /** Summed tiktoken estimate. Guaranteed <= budget.hardMax. */
  totalEstimatedTokens: number;
  /** Budget used to build this context (for debug / logging). */
  budget: TokenBudget;
  /** Was any block truncated to fit the budget? */
  truncated: boolean;
}

export interface VoiceContextBlock {
  kind: VoiceContextBlockKind;
  label: string;
  text: string;
  estimatedTokens: number;
}

export type VoiceContextBlockKind =
  | "org_summary"
  | "recent_call"
  | "open_follow_up"
  | "key_contact"
  | "email_click";

export interface TokenBudget {
  /** Target we try to stay under. Called "soft cap" in Sprint 9 spec. */
  target: number;
  /** Hard ceiling. We truncate oldest items until we're below this. */
  hardMax: number;
  /** Per-block caps so one noisy source can't crowd everything else out. */
  perBlock: {
    orgSummary: number;
    recentCall: number;
    openFollowUp: number;
    keyContact: number;
    emailClick: number;
  };
}

export const DEFAULT_VOICE_TOKEN_BUDGET: TokenBudget = {
  target: 6_000,
  hardMax: 10_000,
  perBlock: {
    orgSummary: 800,
    recentCall: 600,
    openFollowUp: 400,
    keyContact: 120,
    emailClick: 200,
  },
};
