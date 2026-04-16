import {
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { agentRunStatusEnum } from "./enums.js";

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    agentName: text("agent_name").notNull(),
    status: agentRunStatusEnum("status").notNull().default("pending"),
    inputRefs: jsonb("input_refs").$type<Record<string, unknown>>().notNull().default({}),
    outputRefs: jsonb("output_refs")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("agent_runs_tenant_idx").on(t.tenantId),
  }),
);

export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;
