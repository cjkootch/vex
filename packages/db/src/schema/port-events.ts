import {
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { ports } from "./ports.js";

/**
 * Port events — closures, congestion spikes, strikes, tariff changes,
 * regulatory updates (0020_ports). Append-only + FK-cascade on the
 * port so deleting a port cleans up its events.
 *
 * `ends_at IS NULL` means the event is ongoing; the port-intelligence
 * agent queries this table to fire signals against every live deal
 * touching an affected port. Text columns for `event_type` + `severity`
 * keep the vocabulary open — new event kinds don't need a schema bump.
 */
export const portEvents = pgTable(
  "port_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    portId: text("port_id")
      .notNull()
      .references(() => ports.id, { onDelete: "cascade" }),
    /** "closure" | "congestion" | "strike" | "tariff_change" | "regulatory" */
    eventType: text("event_type").notNull(),
    /** "info" | "warn" | "critical" */
    severity: text("severity").notNull().default("info"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    title: text("title").notNull(),
    body: text("body"),
    sourceUrl: text("source_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    portIdx: index("port_events_port_idx").on(t.portId, t.startsAt),
    activeIdx: index("port_events_active_idx").on(t.tenantId, t.startsAt),
  }),
);

export type PortEvent = typeof portEvents.$inferSelect;
export type NewPortEvent = typeof portEvents.$inferInsert;
