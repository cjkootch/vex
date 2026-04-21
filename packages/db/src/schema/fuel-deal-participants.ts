import {
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { fuelDeals } from "./fuel-deals.js";
import { organizations } from "./organizations.js";
import { contacts } from "./contacts.js";

/**
 * Per-deal participants with heterogeneous commission structures.
 *
 * A deal typically involves more parties than the buyer/seller pair on
 * `fuel_deals`: supplier-side brokers, buyer-side brokers, and misc.
 * intermediaries (local agents, introducers). Each party may be paid
 * differently: percentage of deal value, cents per liter, USD per
 * metric ton, or a flat USD amount. Collapsing that variance into a
 * single `intermediary_fee_pct` column loses the attribution the team
 * needs to answer "what % are we paying the supplier-side broker?"
 *
 * Text columns (`party_type`, `commission_type`) instead of enums so
 * new party roles / pricing models can be added without a schema bump.
 * `display_name` is always present because operators routinely build
 * deals before the broker's company is added to the CRM — `org_id`
 * links up later if the org exists.
 */
export const fuelDealParticipants = pgTable(
  "fuel_deal_participants",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    dealId: text("deal_id")
      .notNull()
      .references(() => fuelDeals.id, { onDelete: "cascade" }),

    /** Role on this deal. Allowed values:
     *  - supplier             — actually selling the product
     *  - supplier_broker      — broker on the supplier's side
     *  - buyer                — actually buying the product
     *  - buyer_broker         — broker on the buyer's side
     *  - intermediary         — local agent, introducer, middleman
     */
    partyType: text("party_type").notNull(),

    /** Optional link to the CRM organization row. Null when the party
     *  hasn't been added to the CRM yet — display_name carries the
     *  identity in the meantime. */
    orgId: text("org_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    /** Optional contact person within the party organization. */
    contactId: text("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    /** Always present label — shown in the UI regardless of org linkage. */
    displayName: text("display_name").notNull(),

    /** Commission pricing model:
     *  - percentage      — % of sell-price (commission_value = 0.005 for 0.5%)
     *  - cents_per_liter — cents per L (commission_value = 5 for 5¢/L)
     *  - usd_per_mt      — USD per metric ton
     *  - flat_usd        — single flat USD amount for the whole deal
     *  - none            — informational row only, no commission
     */
    commissionType: text("commission_type").notNull().default("none"),
    /** Interpreted against commission_type. Null when type === 'none'. */
    commissionValue: doublePrecision("commission_value"),
    commissionNotes: text("commission_notes"),

    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantIdx: index("fuel_deal_participants_tenant_idx").on(t.tenantId),
    dealIdx: index("fuel_deal_participants_deal_idx").on(t.dealId),
    orgIdx: index("fuel_deal_participants_org_idx").on(t.orgId),
  }),
);

export type FuelDealParticipant = typeof fuelDealParticipants.$inferSelect;
export type NewFuelDealParticipant = typeof fuelDealParticipants.$inferInsert;
