import { defineConfig } from "drizzle-kit";

/**
 * Drizzle uses the *direct* (non-pooled) endpoint for migrations.
 * See packages/config for the MIGRATION_DATABASE_URL rationale.
 */
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["MIGRATION_DATABASE_URL"] ?? "",
  },
  verbose: true,
});
