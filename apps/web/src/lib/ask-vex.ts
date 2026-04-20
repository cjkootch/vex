/**
 * Build the deep-link URL for a subject page's "Ask Vex" button.
 *
 * Scope travels as two URL params:
 *   scope       "<type>:<id>"      → primary context for retrieval
 *   scopeLabel  human-readable     → rendered in the scope chip
 *   ask         suggested prompt   → pre-fills the chat input
 *
 * The chat page (apps/web/src/app/app/chat/page.tsx) parses all three
 * on mount and on subsequent search-param changes so the operator can
 * chain Ask-Vex clicks across different subjects without losing the
 * thread.
 */
export type AskVexSubjectType =
  | "contact"
  | "deal"
  | "organization"
  | "campaign";

export interface AskVexArgs {
  type: AskVexSubjectType;
  id: string;
  label?: string | null;
  ask?: string | null;
}

export function buildAskVexHref(args: AskVexArgs): string {
  const params = new URLSearchParams();
  params.set("scope", `${args.type}:${args.id}`);
  if (args.label) params.set("scopeLabel", args.label);
  if (args.ask) params.set("ask", args.ask);
  return `/app/chat?${params.toString()}`;
}
