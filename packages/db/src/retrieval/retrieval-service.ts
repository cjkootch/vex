import { and, desc, gte, inArray, lte, sql } from "drizzle-orm";
import {
  approxTokens,
  packTokens,
  type EvidenceItem,
  type EvidencePack,
} from "@vex/domain";
import type { Tx } from "../client.js";
import { embeddingChunks } from "../schema/embedding-chunks.js";
import { summaries } from "../schema/summaries.js";
import { ScopeResolver, type ResolvedScope } from "./scope-resolver.js";

export { ScopeResolver, type ResolvedScope };

/** Reciprocal Rank Fusion constant — standard value from the literature. */
const RRF_K = 60;

/** Re-rank weights — must sum to 1.0. */
const W_RELEVANCE = 0.4;
const W_FRESHNESS = 0.3;
const W_CONFIDENCE = 0.2;
const W_CORROBORATION = 0.1;

/** Token budget for the assembled pack. Truncate oldest items to fit. */
const DEFAULT_TOKEN_CAP = 28_000;

interface ChunkRow {
  id: string;
  ownerObjectType: string;
  ownerObjectId: string;
  chunkText: string;
  permissionScope: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export class RetrievalService {
  private readonly scope = new ScopeResolver();

  resolveScope(tx: Tx, query: string): Promise<ResolvedScope> {
    return this.scope.resolve(tx, query);
  }

  /**
   * Hybrid search with optional scope filter. Runs FTS and pgvector queries
   * separately, merges via RRF, then returns the fused top `limit`.
   *
   * Caller must already be inside `withTenant`. RLS scopes the tables; the
   * `scopeFilter` narrows further by owner_object_id and date range.
   */
  async hybridSearch(
    tx: Tx,
    queryText: string,
    queryEmbedding: number[],
    scopeFilter: ResolvedScope = {},
    limit = 12,
  ): Promise<EvidenceItem[]> {
    const candidatePerSide = Math.max(20, limit * 2);
    const scopedIds = collectScopedIds(scopeFilter);

    const baseConds = [];
    if (scopedIds.length > 0) {
      baseConds.push(inArray(embeddingChunks.ownerObjectId, scopedIds));
    }
    if (scopeFilter.date_range) {
      baseConds.push(gte(embeddingChunks.createdAt, scopeFilter.date_range.start));
      baseConds.push(lte(embeddingChunks.createdAt, scopeFilter.date_range.end));
    }

    const ftsCond = and(
      sql`${embeddingChunks.searchVector} @@ plainto_tsquery('english', ${queryText})`,
      ...baseConds,
    );
    const ftsRows = await tx
      .select({
        id: embeddingChunks.id,
        ownerObjectType: embeddingChunks.ownerObjectType,
        ownerObjectId: embeddingChunks.ownerObjectId,
        chunkText: embeddingChunks.chunkText,
        permissionScope: embeddingChunks.permissionScope,
        metadata: embeddingChunks.metadata,
        createdAt: embeddingChunks.createdAt,
      })
      .from(embeddingChunks)
      .where(ftsCond)
      .orderBy(
        desc(
          sql`ts_rank(${embeddingChunks.searchVector}, plainto_tsquery('english', ${queryText}))`,
        ),
      )
      .limit(candidatePerSide);

    const vectorLiteral = `[${queryEmbedding.join(",")}]`;
    const vecCond = baseConds.length > 0 ? and(...baseConds) : undefined;
    const vecRows = await tx
      .select({
        id: embeddingChunks.id,
        ownerObjectType: embeddingChunks.ownerObjectType,
        ownerObjectId: embeddingChunks.ownerObjectId,
        chunkText: embeddingChunks.chunkText,
        permissionScope: embeddingChunks.permissionScope,
        metadata: embeddingChunks.metadata,
        createdAt: embeddingChunks.createdAt,
      })
      .from(embeddingChunks)
      .where(vecCond)
      .orderBy(sql`${embeddingChunks.embedding} <=> ${vectorLiteral}::vector`)
      .limit(candidatePerSide);

    const rrfScores = new Map<string, number>();
    const rowsById = new Map<string, ChunkRow>();
    ftsRows.forEach((row, i) => {
      rowsById.set(row.id, row);
      rrfScores.set(row.id, (rrfScores.get(row.id) ?? 0) + 1 / (RRF_K + i + 1));
    });
    vecRows.forEach((row, i) => {
      rowsById.set(row.id, row);
      rrfScores.set(row.id, (rrfScores.get(row.id) ?? 0) + 1 / (RRF_K + i + 1));
    });

    const corroboration = countCorroboration([...rowsById.values()]);
    const now = Date.now();

    const enriched = [...rrfScores.entries()].map(([id, rrf]) => {
      const row = rowsById.get(id)!;
      const item = toEvidenceItem(row, now, corroboration);
      return { item, rrf };
    });

    const reRanked = enriched
      .map(({ item, rrf }) => ({ item, score: rerankScore(rrf, item) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ item }) => item);

    return reRanked;
  }

  /**
   * Build the EvidencePack a Claude query gets handed:
   *   1. Resolve scope from the query text.
   *   2. Pull current summaries for every scoped object (acts as a cache-
   *      friendly "context" block in the prompt).
   *   3. Run hybridSearch for chunk-level evidence.
   *   4. Truncate to fit the token budget — oldest items first.
   */
  async buildEvidencePack(
    tx: Tx,
    queryText: string,
    queryEmbedding: number[],
    options: { tokenCap?: number; limit?: number } = {},
  ): Promise<EvidencePack> {
    const scope = await this.resolveScope(tx, queryText);
    const summariesItems = await this.fetchScopeSummaries(tx, scope);
    const items = await this.hybridSearch(tx, queryText, queryEmbedding, scope, options.limit);

    const cap = options.tokenCap ?? DEFAULT_TOKEN_CAP;
    let pack: EvidencePack = {
      summaries: summariesItems,
      items,
      estimated_tokens: packTokens({ summaries: summariesItems, items }),
    };

    if (pack.estimated_tokens > cap) {
      pack = truncateToCap(pack, cap);
    }
    return pack;
  }

  /**
   * Collect the latest summary row for every (subjectType, subjectId) pair
   * implied by the resolved scope, projected as `EvidenceItem`s.
   */
  private async fetchScopeSummaries(
    tx: Tx,
    scope: ResolvedScope,
  ): Promise<EvidenceItem[]> {
    const subjects: { type: string; id: string }[] = [];
    for (const id of scope.org_ids ?? []) subjects.push({ type: "organization", id });
    for (const id of scope.contact_ids ?? []) subjects.push({ type: "contact", id });
    for (const id of scope.campaign_ids ?? []) subjects.push({ type: "campaign", id });
    if (subjects.length === 0) return [];

    const rows = await tx
      .select()
      .from(summaries)
      .where(
        and(
          inArray(summaries.subjectId, subjects.map((s) => s.id)),
          inArray(
            summaries.subjectType,
            [...new Set(subjects.map((s) => s.type))],
          ),
        ),
      )
      .orderBy(desc(summaries.version));

    // Keep the highest version per (subjectType, subjectId).
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = `${row.subjectType}:${row.subjectId}`;
      if (!latest.has(key)) latest.set(key, row);
    }

    const now = Date.now();
    return [...latest.values()].map((row) => {
      const occurredAt = row.validityWindowStart ?? row.updatedAt;
      const ageMs = now - occurredAt.getTime();
      return {
        chunk_id: row.id,
        object_type: row.subjectType,
        object_id: row.subjectId,
        chunk_text: row.content,
        source_ref: `summary v${row.version} / ${row.subjectType} ${row.subjectId}`,
        source_type: "summary",
        occurred_at: occurredAt,
        freshness_hours: Math.max(0, ageMs / (1000 * 60 * 60)),
        confidence_score: 0.85,
        corroborated_by_count: 0,
        permission_scope: "workspace",
        raw_event_ref: null,
        summary_version: row.version,
      } satisfies EvidenceItem;
    });
  }
}

function collectScopedIds(scope: ResolvedScope): string[] {
  return [
    ...(scope.org_ids ?? []),
    ...(scope.contact_ids ?? []),
    ...(scope.campaign_ids ?? []),
  ];
}

function countCorroboration(rows: ChunkRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.ownerObjectType}:${row.ownerObjectId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // Subtract the row itself when looking up below.
  return counts;
}

function toEvidenceItem(
  row: ChunkRow,
  nowMs: number,
  corroboration: Map<string, number>,
): EvidenceItem {
  const ageMs = nowMs - row.createdAt.getTime();
  const key = `${row.ownerObjectType}:${row.ownerObjectId}`;
  const cohortSize = corroboration.get(key) ?? 1;
  const metadata = row.metadata as Record<string, unknown>;
  const conf = typeof metadata["confidence"] === "number" ? Number(metadata["confidence"]) : 0.6;
  const rawEventRef =
    typeof metadata["raw_event_ref"] === "string" ? (metadata["raw_event_ref"] as string) : null;
  return {
    chunk_id: row.id,
    object_type: row.ownerObjectType,
    object_id: row.ownerObjectId,
    chunk_text: row.chunkText,
    source_ref: `${row.ownerObjectType} ${row.ownerObjectId} chunk`,
    source_type: typeof metadata["source_type"] === "string" ? (metadata["source_type"] as string) : "chunk",
    occurred_at: row.createdAt,
    freshness_hours: Math.max(0, ageMs / (1000 * 60 * 60)),
    confidence_score: clamp01(conf),
    corroborated_by_count: Math.max(0, cohortSize - 1),
    permission_scope: row.permissionScope,
    raw_event_ref: rawEventRef,
    summary_version: null,
  };
}

function rerankScore(rrf: number, item: EvidenceItem): number {
  const freshness = 1 / (1 + item.freshness_hours / 24);
  const corroboration = Math.tanh(item.corroborated_by_count / 3);
  return (
    W_RELEVANCE * normalizedRrf(rrf) +
    W_FRESHNESS * freshness +
    W_CONFIDENCE * item.confidence_score +
    W_CORROBORATION * corroboration
  );
}

/** Map RRF scores into [0, 1] by capping at the practical max (1/(K+1) * 2). */
function normalizedRrf(rrf: number): number {
  const max = 2 / (RRF_K + 1);
  return Math.min(1, rrf / max);
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * Drop oldest evidence (by occurred_at, fallback by freshness_hours) until
 * we fit under the token cap. Summaries are preserved — they're cheap and
 * carry the highest signal density.
 */
function truncateToCap(pack: EvidencePack, cap: number): EvidencePack {
  const keep: EvidenceItem[] = [];
  const sorted = [...pack.items].sort((a, b) => {
    const aTime = a.occurred_at?.getTime() ?? -Infinity;
    const bTime = b.occurred_at?.getTime() ?? -Infinity;
    return bTime - aTime;
  });
  let estimated = 0;
  for (const item of pack.summaries) estimated += approxTokens(item.chunk_text);
  for (const item of sorted) {
    const cost = approxTokens(item.chunk_text);
    if (estimated + cost > cap) break;
    estimated += cost;
    keep.push(item);
  }
  return { summaries: pack.summaries, items: keep, estimated_tokens: estimated };
}

// kept for test reuse
export const __test = { rerankScore, truncateToCap, normalizedRrf };
