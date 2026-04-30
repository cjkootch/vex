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
    contacts: [
      {
        name: "M. Dupont",
        title: "Procurement Officer",
        email: "m.dupont@armasuisse.ch",
      },
    ],
    estimatedValueUsd: 6_800_000,
    deadline: "2026-05-30",
    quantity: { amount: 8000, unit: "MT" },
    ...overrides,
  };
}

function buildService(overrides: {
  existingLead?: { id: string; orgId: string; contactId: string | null } | null;
  contactDedupeResults?: Array<
    | { kind: "created"; contact: { id: string } }
    | {
        kind: "duplicate";
        contact: { id: string };
        reason: "email" | "phone" | "name_and_org";
        matchedValue: string;
      }
  >;
} = {}) {
  const orgUpsert = vi.fn().mockResolvedValue({ id: "org_1", legalName: "Armasuisse" });
  const orgCreateWithDedupe = vi.fn().mockResolvedValue({
    kind: "created",
    organization: { id: "org_1", legalName: "Armasuisse" },
  });
  const contactCreateWithDedupe = vi.fn();
  const dedupeResults = overrides.contactDedupeResults ?? [
    { kind: "created", contact: { id: "contact_1" } },
  ];
  for (const r of dedupeResults) {
    contactCreateWithDedupe.mockResolvedValueOnce(r);
  }
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
  const ensureMembership = vi
    .fn()
    .mockImplementation(async (_tx: unknown, _t: string, input: { contactId: string; orgId: string; isPrimary?: boolean }) => ({
      tenantId: _t,
      contactId: input.contactId,
      orgId: input.orgId,
      role: null,
      isPrimary: input.isPrimary ?? false,
      since: new Date(),
      until: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

  const service = new IngestService(
    {} as never, // db
    {
      upsertByExternalKey: orgUpsert,
      createWithDedupeCheck: orgCreateWithDedupe,
    } as never,
    { createWithDedupeCheck: contactCreateWithDedupe } as never,
    { ensureMembership } as never,
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
      ensureMembership,
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

  it("creates org via external-key upsert, single contact via dedupe-check, and lead with procur idempotency key", async () => {
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
      contacts: [{ contactId: "contact_1", outcome: "created" }],
      vexUrl: "https://www.vexhq.ai/app/companies/org_1",
      wasExisting: false,
    });
  });

  it("ingests N contacts in payload, first becomes lead primary, returns outcome per contact", async () => {
    const { service, mocks } = buildService({
      contactDedupeResults: [
        { kind: "created", contact: { id: "contact_1" } },
        {
          kind: "duplicate",
          contact: { id: "contact_existing" },
          reason: "email",
          matchedValue: "j.smith@armasuisse.ch",
        },
        { kind: "created", contact: { id: "contact_3" } },
      ],
    });

    const payload = basePayload({
      contacts: [
        { name: "M. Dupont", email: "m.dupont@armasuisse.ch" },
        { name: "J. Smith", email: "j.smith@armasuisse.ch" },
        { name: "P. Müller", email: "p.muller@armasuisse.ch" },
      ],
    });

    const result = await service.ingestProcurLead(payload);

    expect(mocks.contactCreateWithDedupe).toHaveBeenCalledTimes(3);
    expect(mocks.leadCreate).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      expect.objectContaining({ contactId: "contact_1" }),
    );
    expect(result.contacts).toEqual([
      { contactId: "contact_1", outcome: "created" },
      { contactId: "contact_existing", outcome: "duplicate", matchedOn: "email" },
      { contactId: "contact_3", outcome: "created" },
    ]);
    // Event metadata carries the per-contact outcome list — operator UI
    // and downstream batch-summary surfaces read this.
    expect(mocks.eventInsertIfNotExists).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      expect.objectContaining({
        metadata: expect.objectContaining({
          ingested_contacts: [
            { contactId: "contact_1", outcome: "created" },
            {
              contactId: "contact_existing",
              outcome: "duplicate",
              matchedOn: "email",
            },
            { contactId: "contact_3", outcome: "created" },
          ],
        }),
      }),
    );
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
      contacts: [],
      vexUrl: "https://www.vexhq.ai/app/companies/org_existing",
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

  it("skips contact creation when contacts is omitted", async () => {
    const { service, mocks } = buildService();
    const payload = basePayload();
    delete payload.contacts;

    const result = await service.ingestProcurLead(payload);

    expect(mocks.contactCreateWithDedupe).not.toHaveBeenCalled();
    expect(mocks.leadCreate).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      expect.objectContaining({ contactId: null }),
    );
    expect(result.contacts).toEqual([]);
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
      { ensureMembership: vi.fn().mockResolvedValue({}) } as never,
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

  it("persists procur PR #316 metadata onto the lead row (verbatim)", async () => {
    const { service, mocks } = buildService();
    const procurMetadata = {
      procurApproval: {
        status: "approved_with_kyc" as const,
        approvedAt: "2026-04-01T10:00:00.000Z",
        expiresAt: "2026-07-14T10:00:00.000Z",
        notes: null,
      },
      productSpecs: [
        {
          property: "Sulphur Content",
          astmMethod: "D5453",
          units: "mg/kg (ppm)",
          min: null,
          max: "10",
          typical: "8.5",
        },
      ],
      sourceDocuments: [
        {
          url: "https://abc.public.blob.vercel-storage.com/proforma.pdf",
          contentType: "application/pdf",
          filename: "proforma.pdf",
        },
      ],
      marketContext: {
        benchmarkAsOf: "2026-04-29",
        brentSpotUsdPerBbl: 103.42,
        nyhDieselSpotUsdPerGal: 2.43,
        nyhGasolineSpotUsdPerGal: 2.31,
      },
      procurTradingDefaults: {
        defaultSourcingRegion: "med",
        targetGrossMarginPct: 0.05,
        targetNetMarginPerUsg: 0.012,
        monthlyFixedOverheadUsdDefault: 50_000,
      },
      // Free-form keys we don't model — should be ignored by
      // pickProcurMetadata, NOT persisted on the lead row.
      source: "procur",
      pushedAt: "2026-04-30T14:00:00.000Z",
    };
    await service.ingestProcurLead(
      basePayload({ metadata: procurMetadata as never }),
    );
    const leadCall = mocks.leadCreate.mock.calls[0];
    expect(leadCall).toBeDefined();
    const passedProcur = leadCall![2].procurMetadata;
    expect(passedProcur.procurApproval.status).toBe("approved_with_kyc");
    expect(passedProcur.productSpecs).toHaveLength(1);
    expect(passedProcur.productSpecs[0].max).toBe("10");
    expect(passedProcur.sourceDocuments[0].url).toContain("vercel-storage.com");
    expect(passedProcur.marketContext.brentSpotUsdPerBbl).toBe(103.42);
    expect(passedProcur.procurTradingDefaults.defaultSourcingRegion).toBe(
      "med",
    );
    // Free-form keys should NOT have leaked onto procurMetadata.
    expect("source" in passedProcur).toBe(false);
    expect("pushedAt" in passedProcur).toBe(false);
  });

  it("persists contact.linkedinUrl onto external_keys.linkedin", async () => {
    const { service, mocks } = buildService();
    await service.ingestProcurLead(
      basePayload({
        contacts: [
          {
            name: "M. Dupont",
            title: "Procurement Officer",
            email: "m.dupont@armasuisse.ch",
            linkedinUrl: "https://www.linkedin.com/in/mdupont",
          },
        ],
      }),
    );
    const contactArgs = mocks.contactCreateWithDedupe.mock.calls[0]?.[2];
    expect(contactArgs).toBeDefined();
    expect(contactArgs.externalKeys).toEqual({
      linkedin: "https://www.linkedin.com/in/mdupont",
    });
  });

  it("writes a contact_org_memberships row for every contact (regression: PR #318 bug)", async () => {
    // Two contacts pushed alongside the buyer org. Pre-fix, the
    // contacts row was created but no membership row landed, so the
    // org detail page showed an empty contacts list.
    const { service, mocks } = buildService({
      contactDedupeResults: [
        { kind: "created", contact: { id: "contact_a" } },
        // Second contact dedupe-matches an existing one — this is
        // the path that most clearly exposed the bug, since the
        // existing contact's `org_id` was already pointing somewhere
        // else.
        {
          kind: "duplicate",
          contact: { id: "contact_b" },
          reason: "email",
          matchedValue: "compliance@agrimco.com",
        },
      ],
    });
    await service.ingestProcurLead(
      basePayload({
        buyer: {
          legalName: "Agrimco AG",
          country: "CH",
          entitySlug: "agrimco-ag",
          companyKey: "entity-profile:chat-ch-agrimco-ag",
        } as never,
        contacts: [
          {
            name: "Faris Al-Luqman",
            email: "compliance@agrimco.com",
            companyKey: "entity-profile:chat-ch-agrimco-ag",
          } as never,
          {
            name: "Beatrice Suter",
            email: "ceo@agrimco.com",
            companyKey: "entity-profile:chat-ch-agrimco-ag",
          } as never,
        ],
      }),
    );
    expect(mocks.ensureMembership).toHaveBeenCalledTimes(2);
    const calls = mocks.ensureMembership.mock.calls.map((c) => c[2]);
    expect(calls[0]).toMatchObject({
      contactId: "contact_a",
      orgId: "org_1",
      isPrimary: true,
    });
    expect(calls[1]).toMatchObject({
      contactId: "contact_b",
      orgId: "org_1",
      isPrimary: false,
    });
  });

  it("uses companyKey as the buyer's external_keys.procur (PR #318)", async () => {
    const { service, mocks } = buildService();
    await service.ingestProcurLead(
      basePayload({
        buyer: {
          legalName: "Agrimco AG",
          country: "CH",
          entitySlug: "agrimco-old-slug",
          // companyKey wins when both are present.
          companyKey: "entity-profile:chat-ch-agrimco-ag",
        } as never,
      }),
    );
    expect(mocks.orgUpsert).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      "procur",
      "entity-profile:chat-ch-agrimco-ag",
      expect.anything(),
      expect.anything(),
    );
  });

  it("persists contact.companyKey on external_keys.procur for re-push dedupe", async () => {
    const { service, mocks } = buildService();
    await service.ingestProcurLead(
      basePayload({
        contacts: [
          {
            name: "Faris Al-Luqman",
            email: "compliance@agrimco.com",
            companyKey: "entity-profile:chat-ch-agrimco-ag",
            linkedinUrl: "https://www.linkedin.com/in/faris",
          } as never,
        ],
      }),
    );
    const args = mocks.contactCreateWithDedupe.mock.calls[0]?.[2];
    expect(args.externalKeys).toEqual({
      linkedin: "https://www.linkedin.com/in/faris",
      procur: "entity-profile:chat-ch-agrimco-ag",
    });
  });

  it("omits procurMetadata when the payload has no metadata", async () => {
    const { service, mocks } = buildService();
    await service.ingestProcurLead(basePayload());
    const leadCall = mocks.leadCreate.mock.calls[0];
    expect(leadCall).toBeDefined();
    expect(leadCall![2].procurMetadata).toEqual({});
  });
});
