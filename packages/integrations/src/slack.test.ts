import { describe, expect, it, vi } from "vitest";
import {
  SlackNotifier,
  buildHotLeadBlocks,
  buildNewChatBlocks,
  buildBackupRequestBlocks,
} from "./slack.js";

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

const CHAT_PAYLOAD = {
  leadId: "01HLEADCHAT0000000000000001",
  contactId: "01HCONTACTCHAT0000000000001",
  contactName: "Priya Narine",
  contactEmail: "priya@massy.tt",
  orgName: "massy.tt",
  pageUrl: "https://vectortradecapital.com/fuel/ulsd?utm_source=li",
  referrer: "https://linkedin.com/feed/",
};

describe("notifyNewChat", () => {
  it("POSTs a chat-started Block Kit payload", async () => {
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
    const result = await notifier.notifyNewChat(CHAT_PAYLOAD);
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]![1];
    const body = JSON.parse(init.body as string) as {
      blocks: unknown[];
      text: string;
    };
    expect(body.text).toContain("New website chat");
    expect(body.text).toContain("Priya");
  });

  it("is a no-op when slack webhook is disabled", async () => {
    const notifier = new SlackNotifier({
      webhookUrl: null,
      appBaseUrl: null,
      log: silentLog(),
    });
    expect(await notifier.notifyNewChat(CHAT_PAYLOAD)).toEqual({
      ok: false,
      reason: "disabled",
    });
  });
});

describe("buildNewChatBlocks", () => {
  it("renders header + context + Open-contact deep link", () => {
    const blocks = buildNewChatBlocks(CHAT_PAYLOAD, "https://vex.example.com");
    const types = blocks.map((b) => b["type"]);
    expect(types).toEqual(["header", "context", "actions"]);
    const header = blocks[0] as { text: { text: string } };
    expect(header.text.text).toContain("Priya Narine");
    expect(header.text.text).toContain("massy.tt");
    const actions = blocks[2] as {
      elements: Array<{ url: string; text: { text: string } }>;
    };
    expect(actions.elements[0]!.url).toBe(
      "https://vex.example.com/app/contacts/01HCONTACTCHAT0000000000001",
    );
    expect(actions.elements[0]!.text.text).toBe("Open contact");
  });

  it("falls back to /app/inbox when contactId is missing", () => {
    const blocks = buildNewChatBlocks(
      { ...CHAT_PAYLOAD, contactId: null },
      "https://vex.example.com",
    );
    const actions = blocks.find((b) => b["type"] === "actions") as {
      elements: Array<{ url: string }>;
    };
    expect(actions.elements[0]!.url).toBe(
      "https://vex.example.com/app/inbox",
    );
  });

  it("omits context when no email/page/referrer present", () => {
    const blocks = buildNewChatBlocks(
      {
        ...CHAT_PAYLOAD,
        contactEmail: null,
        pageUrl: null,
        referrer: null,
      },
      null,
    );
    expect(blocks.find((b) => b["type"] === "context")).toBeUndefined();
  });
});

const BACKUP_PAYLOAD = {
  workflowId: "outbound_call_abc123",
  callSid: "CA_DEMO",
  calleeName: "Priya Narine",
  calleeOrg: "Massy Energy",
  reason: "callee asked for a live person to talk pricing",
  durationAtRequestSeconds: 137,
};

describe("notifyBackupRequest", () => {
  it("POSTs a backup-request Block Kit payload", async () => {
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
    const result = await notifier.notifyBackupRequest(BACKUP_PAYLOAD);
    expect(result).toEqual({ ok: true });
    const init = fetchImpl.mock.calls[0]![1];
    const body = JSON.parse(init.body as string) as {
      blocks: unknown[];
      text: string;
    };
    expect(body.text).toContain("AI needs backup");
    expect(body.text).toContain("Priya");
  });

  it("is a no-op when slack webhook is disabled", async () => {
    const notifier = new SlackNotifier({
      webhookUrl: null,
      appBaseUrl: null,
      log: silentLog(),
    });
    expect(await notifier.notifyBackupRequest(BACKUP_PAYLOAD)).toEqual({
      ok: false,
      reason: "disabled",
    });
  });
});

describe("buildBackupRequestBlocks", () => {
  it("renders header + context + Join-call deep link", () => {
    const blocks = buildBackupRequestBlocks(
      BACKUP_PAYLOAD,
      "https://vex.example.com",
    );
    const types = blocks.map((b) => b["type"]);
    expect(types).toEqual(["header", "context", "actions"]);
    const header = blocks[0] as { text: { text: string } };
    expect(header.text.text).toContain("Priya Narine");
    expect(header.text.text).toContain("Massy Energy");
    const ctx = blocks[1] as {
      elements: Array<{ text: string }>;
    };
    expect(ctx.elements[0]!.text).toContain("2:17");
    const actions = blocks[2] as {
      elements: Array<{ url: string; text: { text: string }; style?: string }>;
    };
    expect(actions.elements[0]!.url).toBe(
      "https://vex.example.com/app/calls/outbound_call_abc123",
    );
    expect(actions.elements[0]!.text.text).toBe("Join call");
    expect(actions.elements[0]!.style).toBe("danger");
  });

  it("omits the Join-call button when appBaseUrl is null", () => {
    const blocks = buildBackupRequestBlocks(BACKUP_PAYLOAD, null);
    expect(blocks.find((b) => b["type"] === "actions")).toBeUndefined();
  });

  it("degrades gracefully without callee name/org", () => {
    const blocks = buildBackupRequestBlocks(
      { ...BACKUP_PAYLOAD, calleeName: null, calleeOrg: null, reason: null },
      "https://vex.example.com",
    );
    const header = blocks[0] as { text: { text: string } };
    expect(header.text.text).toMatch(/AI needs backup/);
  });
});
