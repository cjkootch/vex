export { QUERY_SYSTEM_PROMPT, QUERY_PROMPT_VERSION } from "./query.js";
export { DAILY_BRIEF_SYSTEM_PROMPT, DAILY_BRIEF_PROMPT_VERSION } from "./daily-brief.js";
export { RESEARCH_SYSTEM_PROMPT, RESEARCH_PROMPT_VERSION } from "./research.js";
export { FOLLOW_UP_SYSTEM_PROMPT, FOLLOW_UP_PROMPT_VERSION } from "./follow-up.js";
export {
  MARKETING_ANALYST_SYSTEM_PROMPT,
  MARKETING_ANALYST_PROMPT_VERSION,
} from "./marketing-analyst.js";

/** Symbolic prompt registry — convenient for telemetry tagging. */
export const QueryName = {
  Query: "query",
  DailyBrief: "daily_brief",
  Research: "research",
  FollowUp: "follow_up",
  MarketingAnalyst: "marketing_analyst",
} as const;
export type QueryName = (typeof QueryName)[keyof typeof QueryName];
