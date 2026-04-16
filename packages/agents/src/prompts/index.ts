export { QUERY_SYSTEM_PROMPT, QUERY_PROMPT_VERSION } from "./query.js";

/** Symbolic prompt registry — convenient for telemetry tagging. */
export const QueryName = {
  Query: "query",
} as const;
export type QueryName = (typeof QueryName)[keyof typeof QueryName];
