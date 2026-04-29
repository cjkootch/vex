import { beforeEach, describe, expect, it, vi } from "vitest";
import { IngestService } from "./ingest.service.js";
import type { ProcurLeadIngestPayload } from "./dto.js";

const TENANT = "01HSEEDWRK0000000000000001";

vi.mock("@vex/db", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@vex/db");
  return {
    ...actual,
    withTenant: async (
      _db: unknown,
      _tenantId: string,
      fn: (tx: unknown) => Promise<unknown>,
    ) => fn({ __fake_tx: true }),
  };
});

vi.mock("@vex/domain", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@vex/domain");
  let n = 0;
  return {
    ...actual,
    createId: () => `gen_${++n}`,
  };
});

function basePayload(
  overrides: Partial<ProcurLeadIngestPayload> = {},
): ProcurLeadIngestPayload {
  return {
    procurOpportunityId: "ch-armasuisse-2026-q2-007",
    sourceUrl: "https://procur.app/opportunities/ch-armasuisse-2026-q2-007",
    title: "Swiss Federal diesel tender Q2 2026",
    category: "diesel",
    buyer: {
      legalName: "Armasuisse",
      country: "CH",
      entitySlug: "armasuisse",
    },
    contact: {
      name: "M. Dupont",
      title: "Procurement Officer",
      email: "m.dupont@armasuisse.ch",
    },
    estimatedValueUsd: 6_800_000,
    deadline: "2026-05-30",
    quantity: { amount: 8000, unit: "MT" },
    ...overrides,
  };
}

function buildService(overrides: {
  existingLead?: { id: string; orgId: string; contactId: string | null } | null;
} = {}) {
  const orgUpsert = vi.fn().mockResolvedValue({ id: "org_1", legalName: "Armasuisse" });
  const orgCreateWithDedupe = vi.fn().mockResolvedValue({
    kind: "created",
    organization: { id: "org_1", legalName: "Armasuisse" },
  });
  const contactCreateWithDedupe = vi.fn().mockResolvedValue({
    kind: "created",
    contact: { id: "contact_1" },
  });
  const leadFindByExternalKey = vi
    .fn()
    .mockResolvedValue(overrides.existingLead ?? null);
  const leadCreate = vi.fn().mockResolvedValue({
    id: "lead_1",
    orgId: "org_1",
    contactId: "contact_1",
  });
  const eventInsertIfNotExists = vi.fn().mockResolvedValue({ isNew: true });
  const queueAdd = vi.fn().mockResolvedValue(undefined);

  const service = new IngestService(
    {} as never, // db
    {
      upsertByExternalKey: orgUpsert,
      createWithDedupeCheck: orgCreateWithDedupe,
    } as never,
    { createWithDedupeCheck: contactCreateWithDedupe } as never,
    { findByExternalKey: leadFindByExternalKey, create: leadCreate } as never,
    { insertIfNotExists: eventInsertIfNotExists } as never,
    { add: queueAdd } as never,
    TENANT,
    "https://www.vexhq.ai",
  );

  return {
    service,
    mocks: {
      orgUpsert,
      orgCreateWithDedupe,
      contactCreateWithDedupe,
      leadFindByExternalKey,
      leadCreate,
      eventInsertIfNotExists,
      queueAdd,
    },
  };
}

describe("IngestService.ingestProcurLead", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates org via external-key upsert, contact via dedupe-check, and lead with procur idempotency key", async () => {
    const { service, mocks } = buildService();

    const result = await service.ingestProcurLead(basePayload());

    expect(mocks.orgUpsert).toHaveBeenCalledWith(
      { __fake_tx: true },
      TENANT,
      "procur",
      "armasuisse",
      expect.objectContaining({
        legalName: "Armasuisse",
        sourceOfTruth: "procur",
      }),
      expect.objectContaining({ incomingConfidence: 0.85 }),
    );
    expect(mocks.contactCreateWithDedupe).toHaveBeenCalledWith(
      { __fake_tx: true },
      TENANT,
      expect.objectContaining({
        orgId: "org_1",
        fullName: "M. Dupont",
        emails: ["m.dupont@armasuisse.ch"],
      }),
    );
    expect(mocks.leadCreate).toHaveBeenCalledWith(
      { __fake_tx: true },
      TENANT,
      expect.objectContaining({
        orgId: "org_1",
        contactId: "contact_1",
        stage: "procur_inbound",
        externalKeys: { procur: "ch-armasuisse-2026-q2-007" },
      }),
    );
    expect(mocks.eventInsertIfNotExists).toHaveBeenCalledWith(
      { __fake_tx: true },
      TENANT,
      expect.objectContaining({
        verb: "lead.created.from_procur",
        subjectType: "lead",
        subjectId: "lead_1",
        idempotencyKey: "procur:ch-armasuisse-2026-q2-007:lead.created",
      }),
    );
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "procur_enrichment",
      expect.objectContaining({
        kind: "procur_enrichment",
        workspace_id: TENANT,
        input: { organization_id: "org_1" },
      }),
      expect.objectContaining({
        jobId: `procur_enrichment:${TENANT}:procur_lead:ch-armasuisse-2026-q2-007`,
      }),
    );
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "research",
      expect.objectContaining({
        kind: "research",
        workspace_id: TENANT,
        input: { organization_id: "org_1" },
      }),
      expect.objectContaining({
        jobId: `research:${TENANT}:procur_lead:ch-armasuisse-2026-q2-007`,
      }),
    );
    expect(result).toEqual({
      leadId: "lead_1",
      orgId: "org_1",
      contactId: "contact_1",
      vexUrl: "https://www.vexhq.ai/app/leads/lead_1",
      wasExisting: false,
    });
  });

  it("re-clicking returns the existing lead and does not enqueue", async () => {
    const { service, mocks } = buildService({
      existingLead: {
        id: "lead_existing",
        orgId: "org_existing",
        contactId: null,
      },
    });

    const result = await service.ingestProcurLead(basePayload());

    expect(result).toEqual({
      leadId: "lead_existing",
      orgId: "org_existing",
      contactId: null,
      vexUrl: "https://www.vexhq.ai/app/leads/lead_existing",
      wasExisting: true,
    });
    expect(mocks.orgUpsert).not.toHaveBeenCalled();
    expect(mocks.contactCreateWithDedupe).not.toHaveBeenCalled();
    expect(mocks.leadCreate).not.toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("falls back to createWithDedupeCheck when buyer.entitySlug is missing", async () => {
    const { service, mocks } = buildService();
    const payload = basePayload();
    delete payload.buyer.entitySlug;

    await service.ingestProcurLead(payload);

    expect(mocks.orgUpsert).not.toHaveBeenCalled();
    expect(mocks.orgCreateWithDedupe).toHaveBeenCalledWith(
      { __fake_tx: true },
      TENANT,
      expect.objectContaining({
        legalName: "Armasuisse",
      }),
    );
  });

  it("skips contact creation when contact is omitted", async () => {
    const { service, mocks } = buildService();
    const payload = basePayload();
    delete payload.contact;

    const result = await service.ingestProcurLead(payload);

    expect(mocks.contactCreateWithDedupe).not.toHaveBeenCalled();
    expect(mocks.leadCreate).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      expect.objectContaining({ contactId: null }),
    );
    expect(result.contactId).toBeNull();
  });

  it("returns vexUrl=null when webAppBaseUrl is unset", async () => {
    const orgUpsert = vi
      .fn()
      .mockResolvedValue({ id: "org_1", legalName: "Armasuisse" });
    const contactCreate = vi
      .fn()
      .mockResolvedValue({ kind: "created", contact: { id: "contact_1" } });
    const leadCreate = vi
      .fn()
      .mockResolvedValue({ id: "lead_1", orgId: "org_1", contactId: "contact_1" });
    const service = new IngestService(
      {} as never,
      { upsertByExternalKey: orgUpsert, createWithDedupeCheck: vi.fn() } as never,
      { createWithDedupeCheck: contactCreate } as never,
      { findByExternalKey: vi.fn().mockResolvedValue(null), create: leadCreate } as never,
      { insertIfNotExists: vi.fn().mockResolvedValue({ isNew: true }) } as never,
      { add: vi.fn() } as never,
      TENANT,
      null,
    );

    const result = await service.ingestProcurLead(basePayload());
    expect(result.vexUrl).toBeNull();
  });

  it("does not throw when the agent enqueue fails — ingest succeeds", async () => {
    const { service, mocks } = buildService();
    mocks.queueAdd.mockRejectedValueOnce(new Error("redis down"));

    const result = await service.ingestProcurLead(basePayload());
    expect(result.wasExisting).toBe(false);
    expect(result.leadId).toBe("lead_1");
  });
});
