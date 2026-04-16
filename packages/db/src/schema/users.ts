import { pgTable, uuid, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { UserRole } from "@vex/domain";
import { tenants } from "./tenants.js";

export const userRoleEnum = pgEnum("user_role", [
  UserRole.Owner,
  UserRole.Admin,
  UserRole.Member,
  UserRole.Viewer,
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  name: text("name"),
  role: userRoleEnum("role").notNull().default(UserRole.Member),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
