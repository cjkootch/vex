import {
  customType,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  vector,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * `search_vector` is a tsvector column computed by the DB. Drizzle doesn't
 * have a built-in `tsvector` type, so we declare a custom one that maps to
 * Postgres `tsvector` and is read-only from the ORM (the value is produced
 * by a STORED GENERATED expression in the initial migration).
 */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
});

export const embeddingChunks = pgTable(
  "embedding_chunks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    ownerObjectType: text("owner_object_type").notNull(),
    ownerObjectId: text("owner_object_id").notNull(),
    chunkText: text("chunk_text").notNull(),
    searchVector: tsvector("search_vector"),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    permissionScope: text("permission_scope").notNull().default("workspace"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("embedding_chunks_tenant_idx").on(t.tenantId),
    ownerIdx: index("embedding_chunks_owner_idx").on(t.ownerObjectType, t.ownerObjectId),
    searchVectorIdx: index("embedding_chunks_search_vector_idx")
      .using("gin", t.searchVector)
      .where(sql`search_vector IS NOT NULL`),
  }),
);

export type EmbeddingChunk = typeof embeddingChunks.$inferSelect;
export type NewEmbeddingChunk = typeof embeddingChunks.$inferInsert;
