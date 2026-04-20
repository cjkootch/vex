import { describe, expect, it, vi } from "vitest";
import { SlackNotifier, buildHotLeadBlocks } from "./slack.js";

const BASE_PAYLOAD = {
  leadId: "01HLEADHOT0000000000000001",
  contactId: "01HCONTACTHOT0000000000001",
  contactName: "Jean-Marie Baptiste",
  orgName: "acmeimports.ht",
  buyingIntent: "intent_to_buy",
  urgency: "immediate",
  product: "rice",
  volume: "500 MT",
  destination: "Port-au-Prince",
  timeline: "Q3 2026",
  summary: "Haitian importer ready to order parboiled rice Q3 2026.",
  source: "website_form",
};

function silentLog(): (
  level: "info" | "warn" | "error",
  msg: string,
  meta?: unknown,
) => void {
  return () => {
    return;
  };
}

describe("SlackNotifier", () => {
  it("no-ops with reason=disabled when webhookUrl is null", async () => {
    const notifier = new SlackNotifier({
      webhookUrl: null,
      appBaseUrl: null,
      log: silentLog(),
    });
    const result = await notifier.notifyHotLead(BASE_PAYLOAD);
    expect(result).toEqual({ ok: false, reason: "disabled" });
  });

  it("POSTs a Block Kit payload and returns ok on 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "ok",
    });
    const notifier = new SlackNotifier({
      webhookUrl: "https://hooks.slack.com/services/T/B/X",
      appBaseUrl: "https://vex.example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: silentLog(),
    });
    const result = await notifier.notifyHotLead(BASE_PAYLOAD);
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://hooks.slack.com/services/T/B/X");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as {
      blocks: unknown[];
      text: string;
    };
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(body.text).toMatch(/Hot lead/i);
    expect(body.text).toContain("Jean-Marie");
  });

  it("returns reason=http_error on a non-2xx Slack response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "invalid_token",
    });
    const notifier = new SlackNotifier({
      webhookUrl: "https://hooks.slack.com/services/bad",
      appBaseUrl: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: silentLog(),
    });
    const result = await notifier.notifyHotLead(BASE_PAYLOAD);
    expect(result).toEqual({ ok: false, reason: "http_error" });
  });

  it("returns reason=exception when fetch throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    const notifier = new SlackNotifier({
      webhookUrl: "https://hooks.slack.com/services/T/B/X",
      appBaseUrl: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: silentLog(),
    });
    const result = await notifier.notifyHotLead(BASE_PAYLOAD);
    expect(result).toEqual({ ok: false, reason: "exception" });
  });
});

describe("buildHotLeadBlocks", () => {
  it("builds a header + context + section + deep-link button", () => {
    const blocks = buildHotLeadBlocks(
      BASE_PAYLOAD,
      "https://vex.example.com",
    );
    const types = blocks.map((b) => b["type"]);
    expect(types).toContain("header");
    expect(types).toContain("section");
    expect(types).toContain("actions");
    const header = blocks.find((b) => b["type"] === "header");
    expect(
      (header as { text: { text: string } }).text.text,
    ).toContain("Jean-Marie Baptiste");

    const actions = blocks.find((b) => b["type"] === "actions") as {
      elements: Array<{ type: string; url?: string; text: { text: string } }>;
    };
    expect(actions.elements[0]!.url).toBe(
      "https://vex.example.com/app/contacts/01HCONTACTHOT0000000000001",
    );
    expect(actions.elements[0]!.text.text).toBe("Open in Vex");
  });

  it("falls back to /app when no contactId is available", () => {
    const blocks = buildHotLeadBlocks(
      { ...BASE_PAYLOAD, contactId: null },
      "https://vex.example.com",
    );
    const actions = blocks.find((b) => b["type"] === "actions") as {
      elements: Array<{ url: string }>;
    };
    expect(actions.elements[0]!.url).toBe("https://vex.example.com/app");
  });

  it("omits the deep-link button when appBaseUrl is null", () => {
    const blocks = buildHotLeadBlocks(BASE_PAYLOAD, null);
    expect(blocks.find((b) => b["type"] === "actions")).toBeUndefined();
  });

  it("omits the summary section when summary is missing", () => {
    const blocks = buildHotLeadBlocks(
      { ...BASE_PAYLOAD, summary: null },
      "https://vex.example.com",
    );
    expect(blocks.find((b) => b["type"] === "section")).toBeUndefined();
  });
});
