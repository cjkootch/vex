import { describe, expect, it, vi } from "vitest";
import {
  ResendNormalizer,
  TwilioNormalizer,
  loadWebhookFixture,
  type RawEventInput,
} from "@vex/integrations";
import { buildNormalizationProcessor } from "@vex/agents";
import { createId } from "@vex/domain";

interface RecordedInsert {
  table: string;
  args: unknown;
}

function makeFakeDeps() {
  const inserts: RecordedInsert[] = [];

  const events: Parameters<typeof buildNormalizationProcessor>[0]["events"] = {
    insertIfNotExists: vi.fn(async (_tenantId: string, data: unknown) => {
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
  } as never;

  const touchpoints = {
    insert: vi.fn(async (_t: string, data: unknown) => {
      inserts.push({ table: "touchpoints", args: data });
      return { id: createId(), tenantId: "t", channel: "x" } as never;
    }),
  };
  const activities = {
    insert: vi.fn(async (_t: string, data: unknown) => {
      inserts.push({ table: "activities", args: data });
      return { id: createId(), tenantId: "t", type: "x" } as never;
    }),
  };
  const contacts = {
    findByEmail: vi.fn(async () => null),
    findById: vi.fn(),
    findByOrgId: vi.fn(),
  } as never;

  return { inserts, events, touchpoints, activities, contacts } as const;
}

describe("ResendNormalizer.normalize", () => {
  it("creates a touchpoint and a canonical event for email.clicked", async () => {
    const deps = makeFakeDeps();
    const normalizer = new ResendNormalizer(deps as never);
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
    const normalizer = new TwilioNormalizer(deps as never);
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
    const processor = buildNormalizationProcessor({
      ...deps,
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
});
