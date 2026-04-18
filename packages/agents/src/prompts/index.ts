export { QUERY_SYSTEM_PROMPT, QUERY_PROMPT_VERSION } from "./query.js";
export { DAILY_BRIEF_SYSTEM_PROMPT, DAILY_BRIEF_PROMPT_VERSION } from "./daily-brief.js";
export { RESEARCH_SYSTEM_PROMPT, RESEARCH_PROMPT_VERSION } from "./research.js";
export { FOLLOW_UP_SYSTEM_PROMPT, FOLLOW_UP_PROMPT_VERSION } from "./follow-up.js";
export {
  VOICE_REALTIME_SYSTEM_PROMPT,
  VOICE_REALTIME_PROMPT_VERSION,
  TRANSCRIPT_SUMMARY_SYSTEM_PROMPT,
  TRANSCRIPT_SUMMARY_PROMPT_VERSION,
  TRANSCRIPT_ACTION_ITEMS_SYSTEM_PROMPT,
  TRANSCRIPT_ACTION_ITEMS_PROMPT_VERSION,
} from "./voice.js";
export {
  MARKET_OUTREACH_SYSTEM_PROMPT,
  MARKET_OUTREACH_PROMPT_VERSION,
} from "./market-outreach.js";

/** Symbolic prompt registry — convenient for telemetry tagging. */
export const QueryName = {
  Query: "query",
  DailyBrief: "daily_brief",
  Research: "research",
  FollowUp: "follow_up",
  VoiceRealtime: "voice_realtime",
  TranscriptSummary: "transcript_summary",
  TranscriptActionItems: "transcript_action_items",
  MarketOutreach: "market_outreach",
} as const;
export type QueryName = (typeof QueryName)[keyof typeof QueryName];
