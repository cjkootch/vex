import { describe, expect, it, vi } from "vitest";
import {
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
