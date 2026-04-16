import { describe, expect, it, vi } from "vitest";
import type { Db } from "../client.js";
import { OrganizationRepository } from "./organization-repository.js";
import { ContactRepository } from "./contact-repository.js";
import { LeadRepository } from "./lead-repository.js";
import { EmbeddingChunkRepository } from "./embedding-chunk-repository.js";

/**
 * Minimal fake Drizzle client. Records each terminal-method promise result
 * so repository methods can be tested without a live Postgres.
 */
interface StubResponses {
  select?: unknown[];
  returning?: unknown[];
}

function fakeDb(responses: StubResponses): Db {
  const thenable = (rows: unknown[]) => {
    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      leftJoin: () => chain,
      innerJoin: () => chain,
      then: (resolve: (rows: unknown[]) => void) => resolve(rows),
    };
    return chain;
  };

  const updateChain = {
    set: () => updateChain,
    where: () => updateChain,
    returning: () => Promise.resolve(responses.returning ?? []),
    then: (resolve: (r: unknown[]) => void) => resolve([]),
  };

  const insertChain = {
    values: () => insertChain,
    returning: () => Promise.resolve(responses.returning ?? []),
    then: (resolve: (r: unknown[]) => void) => resolve([]),
  };

  return {
    select: () => thenable(responses.select ?? []),
    update: () => updateChain,
    insert: () => insertChain,
    execute: vi.fn(async () => undefined),
  } as unknown as Db;
}

describe("OrganizationRepository", () => {
  it("findById returns null when the underlying query yields no rows", async () => {
    const repo = new OrganizationRepository(fakeDb({ select: [] }));
    const result = await repo.findById("tenant", "org-1");
    expect(result).toBeNull();
  });

  it("findById returns the first row when present", async () => {
    const row = { id: "org-1", tenantId: "tenant", legalName: "Acme" };
    const repo = new OrganizationRepository(fakeDb({ select: [row] }));
    const result = await repo.findById("tenant", "org-1");
    expect(result).toEqual(row);
  });

  it("findByExternalKey filters by external_keys in-memory", async () => {
    const rows = [
      { id: "a", tenantId: "t", externalKeys: { apollo: "x" }, fieldConfidence: {} },
      { id: "b", tenantId: "t", externalKeys: { apollo: "y" }, fieldConfidence: {} },
    ];
    const repo = new OrganizationRepository(fakeDb({ select: rows }));
    const result = await repo.findByExternalKey("t", "apollo", "y");
    expect(result?.id).toBe("b");
  });

  it("findByExternalKey returns null when no org matches the external system/key", async () => {
    const repo = new OrganizationRepository(fakeDb({ select: [] }));
    const result = await repo.findByExternalKey("t", "apollo", "nope");
    expect(result).toBeNull();
  });
});

describe("ContactRepository.findByEmail", () => {
  it("matches emails case-insensitively across the emails array", async () => {
    const rows = [
      { id: "c1", tenantId: "t", orgId: "o", fullName: "A", emails: ["a@x.test"] },
      { id: "c2", tenantId: "t", orgId: "o", fullName: "B", emails: ["B@X.Test", "alt@x.test"] },
    ];
    const repo = new ContactRepository(fakeDb({ select: rows }));
    expect((await repo.findByEmail("t", "b@x.test"))?.id).toBe("c2");
    expect((await repo.findByEmail("t", "A@X.TEST"))?.id).toBe("c1");
    expect(await repo.findByEmail("t", "missing@x.test")).toBeNull();
  });
});

describe("LeadRepository", () => {
  it("findById returns null when the query yields no rows", async () => {
    const repo = new LeadRepository(fakeDb({ select: [] }));
    expect(await repo.findById("t", "l1")).toBeNull();
  });

  it("updateStatus issues an update without throwing", async () => {
    const repo = new LeadRepository(fakeDb({}));
    await expect(repo.updateStatus("t", "l1", "qualified")).resolves.toBeUndefined();
  });
});

describe("EmbeddingChunkRepository.hybridSearch", () => {
  it("returns an empty array when neither search produces candidates", async () => {
    const repo = new EmbeddingChunkRepository(fakeDb({ select: [] }));
    const embedding = Array.from({ length: 1536 }, () => 0.1);
    const result = await repo.hybridSearch("t", "query text", embedding, 5);
    expect(result).toEqual([]);
  });
});
