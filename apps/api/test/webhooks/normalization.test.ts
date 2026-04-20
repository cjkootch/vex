import { describe, expect, it, vi } from "vitest";
import {
  FormFillNormalizer,
  ResendNormalizer,
  TwilioNormalizer,
  loadWebhookFixture,
  type RawEventInput,
} from "@vex/integrations";
import { buildNormalizationProcessor } from "@vex/agents";
import { createId } from "@vex/domain";
import type { Db, Tx } from "@vex/db";

interface RecordedInsert {
  table: string;
  args: unknown;
}

function makeFakeTx(): Tx {
  return {
    execute: vi.fn(async () => undefined),
  } as unknown as Tx;
}

function makeFakeDeps() {
  const inserts: RecordedInsert[] = [];

  const events = {
    insertIfNotExists: vi.fn(async (_tx: Tx, _tenantId: string, data: unknown) => {
      inserts.push({ table: "events", args: data });
      return {
        event: {
          id: createId(),
          tenantId: "t",
          verb: (data as { verb: string }).verb,
          subjectType: "x",
          subjectId: "y",
          actorType: null,
          actorId: null,
          objectType: null,
          objectId: null,
          occurredAt: new Date(),
          idempotencyKey: (data as { idempotencyKey: string }).idempotencyKey,
          metadata: {},
        },
        isNew: true,
      };
    }),
  };

  const touchpoints = {
    insert: vi.fn(async (_tx: Tx, _t: string, data: unknown) => {
      inserts.push({ table: "touchpoints", args: data });
      return { id: createId(), tenantId: "t", channel: "x" } as never;
    }),
  };
  const activities = {
    insert: vi.fn(async (_tx: Tx, _t: string, data: unknown) => {
      inserts.push({ table: "activities", args: data });
      return { id: createId(), tenantId: "t", type: "x" } as never;
    }),
  };
  const contacts = {
    findByEmail: vi.fn(async () => null),
    findById: vi.fn(),
    findByOrgId: vi.fn(),
  };

  return { inserts, events, touchpoints, activities, contacts } as const;
}

describe("ResendNormalizer.normalize", () => {
  it("creates a touchpoint and a canonical event for email.clicked", async () => {
    const deps = makeFakeDeps();
    const tx = makeFakeTx();
    const normalizer = new ResendNormalizer({ tx, ...deps } as never);
    const fixture = loadWebhookFixture("resend_email_clicked");

    const input: RawEventInput = {
      id: createId(),
      tenantId: "01HSEEDWRK0000000000000001",
      provider: "resend",
      providerEventId: fixture.headers["svix-id"]!,
      receivedAt: new Date(),
      headers: fixture.headers,
      payload: fixture.payload,
    };

    const outcome = await normalizer.normalize(input);

    expect(outcome.status).toBe("ok");
    const tables = deps.inserts.map((i) => i.table);
    expect(tables).toContain("touchpoints");
    expect(tables).toContain("events");
    const event = deps.inserts.find((i) => i.table === "events")!.args as {
      verb: string;
      idempotencyKey: string;
      metadata: Record<string, unknown>;
    };
    expect(event.verb).toBe("email.clicked");
    expect(event.idempotencyKey).toBe(`resend:${fixture.headers["svix-id"]}`);
    expect(event.metadata["confidence"]).toBe("strong");
    expect(event.metadata["url"]).toContain("vexhq.ai");
  });
});

describe("TwilioNormalizer.normalize", () => {
  it("creates an activity and a canonical event for completed calls", async () => {
    const deps = makeFakeDeps();
    const tx = makeFakeTx();
    const normalizer = new TwilioNormalizer({ tx, ...deps } as never);
    const fixture = loadWebhookFixture("twilio_call_completed");

    const input: RawEventInput = {
      id: createId(),
      tenantId: "01HSEEDWRK0000000000000001",
      provider: "twilio",
      providerEventId: fixture.payload["CallSid"] as string,
      receivedAt: new Date(),
      headers: fixture.headers,
      payload: fixture.payload,
    };

    const outcome = await normalizer.normalize(input);
    expect(outcome.status).toBe("ok");
    const tables = deps.inserts.map((i) => i.table);
    expect(tables).toContain("activities");
    expect(tables).toContain("events");
    const activity = deps.inserts.find((i) => i.table === "activities")!.args as {
      durationSeconds: number;
      type: string;
    };
    expect(activity.type).toBe("voice_call");
    expect(activity.durationSeconds).toBe(187);
  });
});

describe("FormFillNormalizer.normalize", () => {
  function buildFormDeps() {
    const deps = makeFakeDeps();
    const leads = {
      findByExternalKey: vi.fn(async () => null),
      create: vi.fn(async (_tx: Tx, _t: string, _input: unknown) => ({
        id: "lead-new",
        tenantId: "t",
      })),
    };
    const organizations = {
      findByNormalizedIdentity: vi.fn(async () => null),
      create: vi.fn(async (_tx: Tx, _t: string, _input: unknown) => ({
        id: "org-new",
        tenantId: "t",
      })),
    };
    const memberships = {
      create: vi.fn(async (_tx: Tx, _t: string, _input: unknown) => ({
        contactId: "c",
        orgId: "o",
      })),
    };
    const contactsExt = {
      ...deps.contacts,
      create: vi.fn(async (_tx: Tx, _t: string, _input: unknown) => ({
        id: "contact-new",
        tenantId: "t",
        orgId: "org-new",
        fullName: "Jean-Marie Baptiste",
      })),
    };
    return { ...deps, contacts: contactsExt, leads, organizations, memberships };
  }

  const basePayload = {
    event: "form.submitted" as const,
    form_id: "lead-form",
    form_name: "Request a Quote",
    website_version: "c31e5ce",
    timestamp: "2026-04-20T18:00:00.000Z",
    lead: {
      name: "Jean-Marie Baptiste",
      email: "jm@acmeimports.ht",
      phone: "+509-3444-5555",
      sms_consent: true,
    },
    fields: {
      country: "Haiti",
      product_interest: "food",
      message: "Need 500 MT parboiled rice CIF Port-au-Prince, Q3 2026",
    },
    page: {
      url: "https://vectortradecapital.com/#contact",
      referrer: "https://google.com/",
      utm: { source: "google", medium: "cpc", campaign: "q2-haiti" },
    },
  };

  it("creates org + contact + lead + touchpoint + event on a clean submission", async () => {
    const deps = buildFormDeps();
    const tx = makeFakeTx();
    const normalizer = new FormFillNormalizer({ tx, ...deps } as never);

    const input: RawEventInput = {
      id: createId(),
      tenantId: "01HSEEDWRK0000000000000001",
      provider: "website_form",
      providerEventId: "lead-form:jm@acmeimports.ht:2026-04-20T18:00:00.000Z",
      receivedAt: new Date("2026-04-20T18:00:00.000Z"),
      headers: {},
      payload: basePayload,
    };

    const outcome = await normalizer.normalize(input);
    expect(outcome.status).toBe("ok");

    expect(deps.organizations.create).toHaveBeenCalled();
    expect(deps.contacts.create).toHaveBeenCalled();
    expect(deps.memberships.create).toHaveBeenCalled();
    expect(deps.leads.create).toHaveBeenCalled();

    const tables = deps.inserts.map((i) => i.table);
    expect(tables).toContain("touchpoints");
    expect(tables).toContain("events");

    const touch = deps.inserts.find((i) => i.table === "touchpoints")!.args as {
      channel: string;
      metadata: Record<string, unknown>;
    };
    expect(touch.channel).toBe("web_form");
    expect(touch.metadata["form_id"]).toBe("lead-form");
    expect(touch.metadata["country"]).toBe("Haiti");
    expect(touch.metadata["product_interest"]).toBe("food");
    expect(touch.metadata["sms_consent"]).toBe(true);

    const event = deps.inserts.find((i) => i.table === "events")!.args as {
      verb: string;
      idempotencyKey: string;
      metadata: Record<string, unknown>;
    };
    expect(event.verb).toBe("lead.captured");
    const fiveMin = 5 * 60 * 1000;
    const bucket =
      Math.floor(new Date("2026-04-20T18:00:00.000Z").getTime() / fiveMin) *
      fiveMin;
    expect(event.idempotencyKey).toBe(
      `website_form.captured:lead-form:jm@acmeimports.ht:${bucket}`,
    );
    expect(event.metadata["source"]).toBe("website_form");

    // Outcome carries the lead id so the processor can fan out a
    // lead_qualification job without re-querying.
    expect(outcome).toMatchObject({ status: "ok", leadId: "lead-new" });
  });

  it("short-circuits to a bot.form_rejected audit when _gotcha is non-empty", async () => {
    const deps = buildFormDeps();
    const tx = makeFakeTx();
    const normalizer = new FormFillNormalizer({ tx, ...deps } as never);

    const input: RawEventInput = {
      id: "raw-bot-1",
      tenantId: "01HSEEDWRK0000000000000001",
      provider: "website_form",
      providerEventId: "lead-form:bot@spam.example:2026-04-20T18:00:00.000Z",
      receivedAt: new Date("2026-04-20T18:00:00.000Z"),
      headers: {},
      payload: {
        ...basePayload,
        lead: { ...basePayload.lead, email: "bot@spam.example" },
        fields: { ...basePayload.fields, _gotcha: "http://evil.example/" },
      },
    };

    const outcome = await normalizer.normalize(input);
    expect(outcome.status).toBe("skipped");

    expect(deps.organizations.create).not.toHaveBeenCalled();
    expect(deps.contacts.create).not.toHaveBeenCalled();
    expect(deps.leads.create).not.toHaveBeenCalled();

    const tables = deps.inserts.map((i) => i.table);
    expect(tables).toContain("events");
    expect(tables).not.toContain("touchpoints");

    const event = deps.inserts.find((i) => i.table === "events")!.args as {
      verb: string;
      idempotencyKey: string;
      metadata: Record<string, unknown>;
    };
    expect(event.verb).toBe("bot.form_rejected");
    expect(event.idempotencyKey).toBe("website_form.honeypot:raw-bot-1");
  });

  it("throws on a payload with a missing required lead field (Zod)", async () => {
    const deps = buildFormDeps();
    const tx = makeFakeTx();
    const normalizer = new FormFillNormalizer({ tx, ...deps } as never);

    const input: RawEventInput = {
      id: createId(),
      tenantId: "t",
      provider: "website_form",
      providerEventId: "bad",
      receivedAt: new Date(),
      headers: {},
      payload: {
        ...basePayload,
        lead: { name: "No Email" } as unknown as typeof basePayload.lead,
      },
    };

    await expect(normalizer.normalize(input)).rejects.toThrow(
      /website_form payload failed validation/,
    );
  });
});

describe("buildNormalizationProcessor — DLQ path", () => {
  it("throws on a malformed payload so BullMQ retries and eventually DLQs", async () => {
    const deps = makeFakeDeps();
    const tx = makeFakeTx();
    const fakeDb = {
      transaction: async <T>(cb: (t: Tx) => Promise<T>) => cb(tx),
    } as unknown as Db;
    const processor = buildNormalizationProcessor({
      db: fakeDb,
      contacts: deps.contacts as never,
      touchpoints: deps.touchpoints as never,
      activities: deps.activities as never,
      events: deps.events as never,
      rawEvents: {
        findById: vi.fn(async () => ({
          id: "raw1",
          tenantId: "t",
          provider: "resend",
          providerEventId: "evt1",
          headers: {},
          payload: { type: "email.clicked", data: { /* missing required fields */ } },
          receivedAt: new Date(),
          checksum: null,
          status: "pending" as const,
        })),
        updateStatus: vi.fn(async () => undefined),
        insertIfNotExists: vi.fn(),
        listFailed: vi.fn(),
      } as never,
    });

    const job = { data: { raw_event_id: "raw1", tenant_id: "t" } } as never;
    await expect(processor(job)).rejects.toThrow(/Resend webhook missing svix-id/);
  });

  it("rejects a job with no tenant_id immediately", async () => {
    const tx = makeFakeTx();
    const fakeDb = {
      transaction: async <T>(cb: (t: Tx) => Promise<T>) => cb(tx),
    } as unknown as Db;
    const processor = buildNormalizationProcessor({
      db: fakeDb,
      contacts: {} as never,
      touchpoints: {} as never,
      activities: {} as never,
      events: {} as never,
      rawEvents: {} as never,
    });
    const job = { id: "job-1", data: { raw_event_id: "raw1", tenant_id: "" } } as never;
    await expect(processor(job)).rejects.toThrow(/missing tenant_id/);
  });
});

describe("buildNormalizationProcessor — lead_qualification fan-out", () => {
  function buildLeadCaptureDeps() {
    const inserts: RecordedInsert[] = [];
    const events = {
      insertIfNotExists: vi.fn(async (_tx: Tx, _t: string, data: unknown) => {
        inserts.push({ table: "events", args: data });
        return {
          event: { id: createId(), verb: (data as { verb: string }).verb },
          isNew: true,
        };
      }),
    };
    const touchpoints = {
      insert: vi.fn(async () => ({ id: createId() })),
    };
    const activities = { insert: vi.fn() };
    const contacts = {
      findByEmail: vi.fn(async () => ({ id: "contact-existing", orgId: "org-existing" })),
      findById: vi.fn(),
    };
    const organizations = {
      findByNormalizedIdentity: vi.fn(async () => ({ id: "org-existing" })),
      create: vi.fn(),
    };
    const memberships = { create: vi.fn() };
    const leads = {
      findByExternalKey: vi.fn(async () => null),
      create: vi.fn(async (_tx: Tx, _t: string, _input: unknown) => ({
        id: "lead-fresh",
        contactId: "contact-existing",
        orgId: "org-existing",
      })),
    };
    const documents = {
      insert: vi.fn(async () => ({ id: createId() })),
    };
    return { inserts, events, touchpoints, activities, contacts, organizations, memberships, leads, documents };
  }

  function buildFakeAgentsQueue() {
    const calls: Array<{ name: string; data: unknown; opts: unknown }> = [];
    return {
      queue: {
        async add(name: string, data: unknown, opts: unknown) {
          calls.push({ name, data, opts });
          return { id: "agent-job" } as never;
        },
      } as never,
      calls,
    };
  }

  it("fires lead_qualification with source=website_form and the lead id on a form.submitted raw_event", async () => {
    const deps = buildLeadCaptureDeps();
    const tx = makeFakeTx();
    const fakeDb = {
      transaction: async <T>(cb: (t: Tx) => Promise<T>) => cb(tx),
    } as unknown as Db;
    const agents = buildFakeAgentsQueue();

    const processor = buildNormalizationProcessor({
      db: fakeDb,
      contacts: deps.contacts as never,
      touchpoints: deps.touchpoints as never,
      activities: deps.activities as never,
      events: deps.events as never,
      organizations: deps.organizations as never,
      memberships: deps.memberships as never,
      leads: deps.leads as never,
      documents: deps.documents as never,
      agentsQueue: agents.queue,
      rawEvents: {
        findById: vi.fn(async () => ({
          id: "raw-form-1",
          tenantId: "01HSEEDWRK0000000000000001",
          provider: "website_form",
          providerEventId:
            "lead-form:cole@vectortradecapital.com:2026-04-20T04:06:39.694Z",
          headers: {},
          payload: {
            event: "form.submitted",
            form_id: "lead-form",
            form_name: "Request a Quote",
            timestamp: "2026-04-20T04:06:39.694Z",
            lead: {
              name: "Cole K",
              email: "cole@vectortradecapital.com",
              phone: "+1-555-0100",
              sms_consent: true,
            },
            fields: {
              country: "Haiti",
              product_interest: "food",
              message: "500 MT parboiled rice",
            },
            page: { url: "https://vectortradecapital.com/", referrer: null, utm: null },
          },
          receivedAt: new Date("2026-04-20T04:06:39.694Z"),
          checksum: null,
          status: "pending" as const,
        })),
        updateStatus: vi.fn(async () => undefined),
        insertIfNotExists: vi.fn(),
        listFailed: vi.fn(),
      } as never,
    });

    const job = {
      data: {
        raw_event_id: "raw-form-1",
        tenant_id: "01HSEEDWRK0000000000000001",
      },
    } as never;
    const outcome = await processor(job);
    expect(outcome).toMatchObject({ status: "ok", leadId: "lead-fresh" });

    expect(agents.calls).toHaveLength(1);
    const call = agents.calls[0]!;
    expect(call.data).toMatchObject({
      kind: "lead_qualification",
      workspace_id: "01HSEEDWRK0000000000000001",
      input: { source: "website_form", lead_id: "lead-fresh" },
    });
  });

  it("does not fire lead_qualification on a honeypot-skipped form submission", async () => {
    const deps = buildLeadCaptureDeps();
    const tx = makeFakeTx();
    const fakeDb = {
      transaction: async <T>(cb: (t: Tx) => Promise<T>) => cb(tx),
    } as unknown as Db;
    const agents = buildFakeAgentsQueue();

    const processor = buildNormalizationProcessor({
      db: fakeDb,
      contacts: deps.contacts as never,
      touchpoints: deps.touchpoints as never,
      activities: deps.activities as never,
      events: deps.events as never,
      organizations: deps.organizations as never,
      memberships: deps.memberships as never,
      leads: deps.leads as never,
      documents: deps.documents as never,
      agentsQueue: agents.queue,
      rawEvents: {
        findById: vi.fn(async () => ({
          id: "raw-bot-1",
          tenantId: "01HSEEDWRK0000000000000001",
          provider: "website_form",
          providerEventId:
            "lead-form:bot@spam.example:2026-04-20T04:06:39.694Z",
          headers: {},
          payload: {
            event: "form.submitted",
            form_id: "lead-form",
            timestamp: "2026-04-20T04:06:39.694Z",
            lead: { name: "Bot", email: "bot@spam.example" },
            fields: { _gotcha: "http://evil.example/" },
            page: { url: "https://vectortradecapital.com/" },
          },
          receivedAt: new Date("2026-04-20T04:06:39.694Z"),
          checksum: null,
          status: "pending" as const,
        })),
        updateStatus: vi.fn(async () => undefined),
        insertIfNotExists: vi.fn(),
        listFailed: vi.fn(),
      } as never,
    });

    const job = {
      data: {
        raw_event_id: "raw-bot-1",
        tenant_id: "01HSEEDWRK0000000000000001",
      },
    } as never;
    const outcome = await processor(job);
    expect(outcome.status).toBe("skipped");
    expect(agents.calls).toHaveLength(0);
  });

  it("fires lead_qualification with source=website_chat on a conversation.ended raw_event", async () => {
    const deps = buildLeadCaptureDeps();
    const tx = makeFakeTx();
    const fakeDb = {
      transaction: async <T>(cb: (t: Tx) => Promise<T>) => cb(tx),
    } as unknown as Db;
    const agents = buildFakeAgentsQueue();

    const processor = buildNormalizationProcessor({
      db: fakeDb,
      contacts: deps.contacts as never,
      touchpoints: deps.touchpoints as never,
      activities: deps.activities as never,
      events: deps.events as never,
      organizations: deps.organizations as never,
      memberships: deps.memberships as never,
      leads: deps.leads as never,
      documents: deps.documents as never,
      agentsQueue: agents.queue,
      rawEvents: {
        findById: vi.fn(async () => ({
          id: "raw-chat-1",
          tenantId: "01HSEEDWRK0000000000000001",
          provider: "website_chat",
          providerEventId: "vtc-123:conversation.ended",
          headers: {},
          payload: {
            event: "conversation.ended",
            conversation_id: "vtc-123",
            timestamp: "2026-04-20T04:06:39.694Z",
            lead: { name: "Jane", email: "jane@acme.example" },
            page: { url: "https://vectortradecapital.com/" },
            messages: [
              { role: "user", text: "need rice" },
              { role: "assistant", text: "what volume" },
            ],
          },
          receivedAt: new Date(),
          checksum: null,
          status: "pending" as const,
        })),
        updateStatus: vi.fn(async () => undefined),
        insertIfNotExists: vi.fn(),
        listFailed: vi.fn(),
      } as never,
    });

    const job = {
      data: {
        raw_event_id: "raw-chat-1",
        tenant_id: "01HSEEDWRK0000000000000001",
      },
    } as never;
    await processor(job);

    expect(agents.calls).toHaveLength(1);
    const call = agents.calls[0]!;
    expect(call.data).toMatchObject({
      kind: "lead_qualification",
      workspace_id: "01HSEEDWRK0000000000000001",
      input: { source: "website_chat", conversation_id: "vtc-123" },
    });
  });
});
