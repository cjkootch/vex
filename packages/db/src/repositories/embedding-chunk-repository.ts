import { and, eq, sql } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Db } from "../client.js";
import { embeddingChunks, type EmbeddingChunk } from "../schema/embedding-chunks.js";

export interface EmbeddingChunkInsert {
  ownerObjectType: string;
  ownerObjectId: string;
  chunkText: string;
  embedding: number[];
  permissionScope?: string;
  metadata?: Record<string, unknown>;
}

/** Reciprocal Rank Fusion constant — standard value from the literature. */
const RRF_K = 60;

export class EmbeddingChunkRepository {
  constructor(private readonly db: Db) {}

  async insertChunk(
    tenantId: string,
    data: EmbeddingChunkInsert,
  ): Promise<EmbeddingChunk> {
    const [inserted] = await this.db
      .insert(embeddingChunks)
      .values({
        id: createId(),
        tenantId,
        ownerObjectType: data.ownerObjectType,
        ownerObjectId: data.ownerObjectId,
        chunkText: data.chunkText,
        embedding: data.embedding,
        permissionScope: data.permissionScope ?? "workspace",
        metadata: data.metadata ?? {},
      })
      .returning();
    if (!inserted) throw new Error("embedding chunk insert returned no row");
    return inserted;
  }

  /**
   * Hybrid retrieval: Postgres full-text search + pgvector cosine similarity,
   * merged via Reciprocal Rank Fusion (RRF, k=60).
   *
   * Both queries run against the tenant-scoped subset. The top `limit`
   * candidates from each are merged by RRF score and the top `limit` overall
   * is returned.
   */
  async hybridSearch(
    tenantId: string,
    queryText: string,
    embedding: number[],
    limit: number,
  ): Promise<EmbeddingChunk[]> {
    const vectorLiteral = `[${embedding.join(",")}]`;

    const ftRows = await this.db
      .select({ id: embeddingChunks.id })
      .from(embeddingChunks)
      .where(
        and(
          eq(embeddingChunks.tenantId, tenantId),
          sql`${embeddingChunks.searchVector} @@ plainto_tsquery('english', ${queryText})`,
        ),
      )
      .orderBy(
        sql`ts_rank(${embeddingChunks.searchVector}, plainto_tsquery('english', ${queryText})) DESC`,
      )
      .limit(limit);

    const vecRows = await this.db
      .select({ id: embeddingChunks.id })
      .from(embeddingChunks)
      .where(eq(embeddingChunks.tenantId, tenantId))
      .orderBy(sql`${embeddingChunks.embedding} <=> ${vectorLiteral}::vector`)
      .limit(limit);

    const scores = new Map<string, number>();
    ftRows.forEach((row, i) => {
      scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (RRF_K + i + 1));
    });
    vecRows.forEach((row, i) => {
      scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (RRF_K + i + 1));
    });

    const orderedIds = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => id);
    if (orderedIds.length === 0) return [];

    const rows = await this.db
      .select()
      .from(embeddingChunks)
      .where(
        and(
          eq(embeddingChunks.tenantId, tenantId),
          sql`${embeddingChunks.id} = ANY(${orderedIds})`,
        ),
      );

    // Preserve RRF order
    const byId = new Map(rows.map((r) => [r.id, r]));
    return orderedIds.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
  }
}
