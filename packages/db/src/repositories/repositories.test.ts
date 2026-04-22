import { describe, expect, it } from "vitest";
import type { Tx } from "../client.js";
import { OrganizationRepository } from "./organization-repository.js";
import { ContactRepository } from "./contact-repository.js";
import { LeadRepository } from "./lead-repository.js";
import { EmbeddingChunkRepository } from "./embedding-chunk-repository.js";

/**
 * Minimal fake Tx. Records each terminal-method promise result so repository
 * methods can be tested without a live Postgres. The chain returns `this`
 * until awaited; `await` resolves to the configured rows.
 */
interface StubResponses {
  select?: unknown[];
  returning?: unknown[];
}

function fakeTx(responses: StubResponses): Tx {
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
  } as unknown as Tx;
}

describe("OrganizationRepository", () => {
  it("findById returns null when the underlying query yields no rows", async () => {
    const repo = new OrganizationRepository();
    const result = await repo.findById(fakeTx({ select: [] }), "org-1");
    expect(result).toBeNull();
  });

  it("findById returns the first row when present", async () => {
    const row = { id: "org-1", tenantId: "tenant", legalName: "Acme" };
    const repo = new OrganizationRepository();
    const result = await repo.findById(fakeTx({ select: [row] }), "org-1");
    expect(result).toEqual(row);
  });

  // findByExternalKey now filters in SQL via `external_keys @> $1::jsonb`
  // (backed by the organizations_external_keys_gin_idx index added in
  // migration 0021). Behaviour is verified end-to-end by the webhook
  // / marketing integration tests against a real Postgres; the unit
  // contract here just checks null vs. first-row pass-through through
  // the fake tx harness.
  it("findByExternalKey returns the first row the tx yields", async () => {
    const row = { id: "a", tenantId: "t", externalKeys: { apollo: "x" }, fieldConfidence: {} };
    const repo = new OrganizationRepository();
    const result = await repo.findByExternalKey(
      fakeTx({ select: [row] }),
      "apollo",
      "x",
    );
    expect(result?.id).toBe("a");
  });

  it("findByExternalKey returns null when the tx yields no rows", async () => {
    const repo = new OrganizationRepository();
    const result = await repo.findByExternalKey(fakeTx({ select: [] }), "apollo", "nope");
    expect(result).toBeNull();
  });
});

describe("ContactRepository.findByEmail", () => {
  // Case-insensitive matching across the jsonb emails array now runs
  // inside Postgres via `jsonb_array_elements_text` + `lower()`. The
  // integration suite (apps/api test/webhooks/*) exercises this; the
  // unit harness here only confirms the tx pass-through contract.
  it("returns the first row the tx yields", async () => {
    const row = { id: "c2", tenantId: "t", orgId: "o", fullName: "B", emails: ["B@X.Test"] };
    const repo = new ContactRepository();
    expect(
      (await repo.findByEmail(fakeTx({ select: [row] }), "b@x.test"))?.id,
    ).toBe("c2");
  });

  it("returns null when the tx yields no rows", async () => {
    const repo = new ContactRepository();
    expect(await repo.findByEmail(fakeTx({ select: [] }), "missing@x.test")).toBeNull();
  });

  it("short-circuits to null on empty input", async () => {
    const repo = new ContactRepository();
    // Empty input never hits the db.
    expect(await repo.findByEmail(fakeTx({ select: [] }), "   ")).toBeNull();
  });
});

describe("normalizePhone", () => {
  it("strips formatting and keeps the leading plus", async () => {
    const { normalizePhone } = await import("./contact-repository.js");
    expect(normalizePhone("+1 (832) 492-7169")).toBe("+18324927169");
    expect(normalizePhone("832.492.7169")).toBe("8324927169");
  });

  it("rejects strings with fewer than 7 digits", async () => {
    const { normalizePhone } = await import("./contact-repository.js");
    expect(normalizePhone("+1 555")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("abc")).toBeNull();
  });
});

describe("LeadRepository", () => {
  it("findById returns null when the query yields no rows", async () => {
    const repo = new LeadRepository();
    expect(await repo.findById(fakeTx({ select: [] }), "l1")).toBeNull();
  });

  it("updateStatus issues an update without throwing", async () => {
    const repo = new LeadRepository();
    await expect(
      repo.updateStatus(fakeTx({}), "l1", "qualified"),
    ).resolves.toBeUndefined();
  });
});

describe("EmbeddingChunkRepository.hybridSearch", () => {
  it("returns an empty array when neither search produces candidates", async () => {
    const repo = new EmbeddingChunkRepository();
    const embedding = Array.from({ length: 1536 }, () => 0.1);
    const result = await repo.hybridSearch(fakeTx({ select: [] }), "query", embedding, 5);
    expect(result).toEqual([]);
  });
});
