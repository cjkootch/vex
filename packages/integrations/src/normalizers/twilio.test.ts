import { describe, expect, it, vi } from "vitest";
import { TwilioNormalizer } from "./twilio.js";
import type { NormalizerDeps, RawEventInput } from "./types.js";

interface CapturedTouchpoint {
  channel: string;
  contactId: string | null;
  orgId: string | null;
  metadata: Record<string, unknown>;
}

interface CapturedEvent {
  verb: string;
  subjectType: string;
  subjectId: string;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
}

interface CapturedActivity {
  type: string;
  durationSeconds?: number;
  metadata: Record<string, unknown>;
}

function makeDeps(opts: {
  contact?: { id: string; orgId: string | null } | null;
} = {}): {
  deps: NormalizerDeps;
  events: CapturedEvent[];
  touchpoints: CapturedTouchpoint[];
  activities: CapturedActivity[];
  findByPhoneCalls: string[];
} {
  const events: CapturedEvent[] = [];
  const touchpoints: CapturedTouchpoint[] = [];
  const activities: CapturedActivity[] = [];
  const findByPhoneCalls: string[] = [];
  const deps = {
    tx: {} as never,
    contacts: {
      findByPhone: vi.fn(async (_tx: unknown, phone: string) => {
        findByPhoneCalls.push(phone);
        return opts.contact ?? null;
      }),
    },
    touchpoints: {
      insert: vi.fn(async (_tx: unknown, _tenant: string, data: CapturedTouchpoint) => {
        touchpoints.push(data);
        return { id: `tp_${touchpoints.length}` };
      }),
    },
    activities: {
      insert: vi.fn(async (_tx: unknown, _tenant: string, data: CapturedActivity) => {
        activities.push(data);
        return { id: `act_${activities.length}` };
      }),
    },
    events: {
      insertIfNotExists: vi.fn(
        async (_tx: unknown, _tenant: string, data: CapturedEvent) => {
          events.push(data);
          return { event: { id: `evt_${events.length}` }, isNew: true };
        },
      ),
    },
  } as unknown as NormalizerDeps;
  return { deps, events, touchpoints, activities, findByPhoneCalls };
}

function makeRaw(payload: Record<string, string>): RawEventInput {
  return {
    id: "raw_1",
    tenantId: "t_test",
    provider: "twilio",
    providerEventId: payload["MessageSid"] ?? payload["CallSid"] ?? "x",
    receivedAt: new Date("2026-05-01T20:00:00Z"),
    headers: {},
    payload,
  };
}

describe("TwilioNormalizer", () => {
  describe("voice", () => {
    it("emits call.completed with a voice_call activity", async () => {
      const { deps, events, activities } = makeDeps();
      const out = await new TwilioNormalizer(deps).normalize(
        makeRaw({
          CallSid: "CA123",
          CallStatus: "completed",
          CallDuration: "42",
          From: "+14155550100",
          To: "+18324927169",
          Direction: "inbound",
        }),
      );
      expect(out).toMatchObject({ status: "ok", isNewEvent: true });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        verb: "call.completed",
        subjectType: "call",
        subjectId: "CA123",
      });
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        type: "voice_call",
        durationSeconds: 42,
      });
    });

    it("skips on unknown CallStatus", async () => {
      const { deps } = makeDeps();
      const out = await new TwilioNormalizer(deps).normalize(
        makeRaw({ CallSid: "CA1", CallStatus: "weird-status" }),
      );
      expect(out.status).toBe("skipped");
    });
  });

  describe("inbound SMS", () => {
    it("writes an sms.received touchpoint linked to the matched contact", async () => {
      const { deps, events, touchpoints, findByPhoneCalls } = makeDeps({
        contact: { id: "c_cole", orgId: "o_vtc" },
      });
      const out = await new TwilioNormalizer(deps).normalize(
        makeRaw({
          MessageSid: "SM123",
          From: "+18324927169",
          To: "+18775494685",
          Body: "got it, thanks",
          NumMedia: "0",
        }),
      );
      expect(out).toMatchObject({ status: "ok", touchpointId: "tp_1" });
      expect(findByPhoneCalls).toEqual(["+18324927169"]);
      expect(touchpoints).toHaveLength(1);
      expect(touchpoints[0]).toMatchObject({
        channel: "sms.received",
        contactId: "c_cole",
        orgId: "o_vtc",
        metadata: {
          direction: "inbound",
          provider_message_id: "SM123",
          from: "+18324927169",
          to: "+18775494685",
          text: "got it, thanks",
          preview: "got it, thanks",
        },
      });
      expect(events[0]).toMatchObject({
        verb: "sms.received",
        subjectType: "contact",
        subjectId: "c_cole",
        idempotencyKey: "sms.received:SM123",
      });
    });

    it("leaves contactId null when phone doesn't match anyone", async () => {
      const { deps, touchpoints, events } = makeDeps({ contact: null });
      const out = await new TwilioNormalizer(deps).normalize(
        makeRaw({
          MessageSid: "SM999",
          From: "+15550009999",
          To: "+18775494685",
          Body: "wrong number",
        }),
      );
      expect(out.status).toBe("ok");
      expect(touchpoints[0]?.contactId).toBeNull();
      expect(touchpoints[0]?.orgId).toBeNull();
      // Falls back to the raw phone as subject id so the event row
      // is still uniquely keyed.
      expect(events[0]).toMatchObject({
        subjectId: "+15550009999",
      });
    });

    it("detects WhatsApp by the From prefix and strips it for contact lookup", async () => {
      const { deps, touchpoints, findByPhoneCalls } = makeDeps({
        contact: { id: "c_cole", orgId: "o_vtc" },
      });
      await new TwilioNormalizer(deps).normalize(
        makeRaw({
          MessageSid: "WA1",
          From: "whatsapp:+18324927169",
          To: "whatsapp:+18775494685",
          Body: "wa reply",
        }),
      );
      expect(findByPhoneCalls).toEqual(["+18324927169"]);
      const tp = touchpoints[0];
      expect(tp).toBeDefined();
      expect(tp?.channel).toBe("whatsapp.received");
      expect(tp?.metadata).toMatchObject({
        from: "whatsapp:+18324927169",
        to: "whatsapp:+18775494685",
      });
    });
  });

  describe("outbound status callbacks", () => {
    it("emits sms.delivered without writing a touchpoint", async () => {
      const { deps, events, touchpoints } = makeDeps();
      const out = await new TwilioNormalizer(deps).normalize(
        makeRaw({
          MessageSid: "SM123",
          MessageStatus: "delivered",
          From: "+18775494685",
          To: "+18324927169",
        }),
      );
      expect(out).toMatchObject({ status: "ok" });
      expect(touchpoints).toHaveLength(0);
      expect(events[0]).toMatchObject({
        verb: "sms.delivered",
        subjectType: "message",
        subjectId: "SM123",
        idempotencyKey: "sms:SM123:delivered",
      });
    });

    it("captures error_code on a failed status callback", async () => {
      const { deps, events } = makeDeps();
      await new TwilioNormalizer(deps).normalize(
        makeRaw({
          MessageSid: "SM456",
          MessageStatus: "failed",
          From: "+18775494685",
          To: "+18324927169",
          ErrorCode: "30034",
          ErrorMessage: "US A2P 10DLC - Unregistered Number",
        }),
      );
      expect(events[0]).toMatchObject({
        verb: "sms.failed",
        idempotencyKey: "sms:SM456:failed",
        metadata: expect.objectContaining({
          error_code: "30034",
          error_message: "US A2P 10DLC - Unregistered Number",
        }),
      });
    });
  });

  it("skips webhooks with neither CallSid nor MessageSid", async () => {
    const { deps } = makeDeps();
    const out = await new TwilioNormalizer(deps).normalize(
      makeRaw({ AccountSid: "AC123" }),
    );
    expect(out.status).toBe("skipped");
  });
});
