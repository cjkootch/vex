export { QUERY_SYSTEM_PROMPT, QUERY_PROMPT_VERSION } from "./query.js";
export { DAILY_BRIEF_SYSTEM_PROMPT, DAILY_BRIEF_PROMPT_VERSION } from "./daily-brief.js";
export { RESEARCH_SYSTEM_PROMPT, RESEARCH_PROMPT_VERSION } from "./research.js";
export {
  CONTACT_ENRICHMENT_SYSTEM_PROMPT,
  CONTACT_ENRICHMENT_PROMPT_VERSION,
} from "./contact-enrichment.js";
export { FOLLOW_UP_SYSTEM_PROMPT, FOLLOW_UP_PROMPT_VERSION } from "./follow-up.js";
export {
  EMAIL_REPLY_DRAFT_SYSTEM_PROMPT,
  EMAIL_REPLY_DRAFT_PROMPT_VERSION,
} from "./email-reply-draft.js";
export {
  VOICE_REALTIME_SYSTEM_PROMPT,
  VOICE_REALTIME_PROMPT_VERSION,
  TRANSCRIPT_SUMMARY_SYSTEM_PROMPT,
  TRANSCRIPT_SUMMARY_PROMPT_VERSION,
  TRANSCRIPT_ACTION_ITEMS_SYSTEM_PROMPT,
  TRANSCRIPT_ACTION_ITEMS_PROMPT_VERSION,
} from "./voice.js";
export {
  INTENT_CLASSIFIER_SYSTEM_PROMPT,
  INTENT_CLASSIFIER_PROMPT_VERSION,
} from "./intent-classifier.js";
export { renderStrategyPreamble } from "./strategy.js";
export { renderWhatsAppTemplatesPreamble } from "./whatsapp-templates.js";
export {
  renderTemplatesPreamble,
  substituteTemplate,
  extractPlaceholders,
} from "./templates.js";
export {
  STRATEGY_DRAFT_SYSTEM_PROMPT,
  STRATEGY_DRAFT_PROMPT_VERSION,
  buildStrategyDraftUserMessage,
  parseStrategyDraft,
  slotKind,
  type StrategyDraftEvidence,
  type StrategySlot,
} from "./strategy-draft.js";

/** Symbolic prompt registry — convenient for telemetry tagging. */
export const QueryName = {
  Query: "query",
  DailyBrief: "daily_brief",
  Research: "research",
  FollowUp: "follow_up",
  VoiceRealtime: "voice_realtime",
  TranscriptSummary: "transcript_summary",
  TranscriptActionItems: "transcript_action_items",
  IntentClassifier: "intent_classifier",
} as const;
export type QueryName = (typeof QueryName)[keyof typeof QueryName];
