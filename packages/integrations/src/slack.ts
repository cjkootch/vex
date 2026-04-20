/**
 * Thin Slack incoming-webhook client. Only supports the one payload
 * shape Vex uses today — a hot-lead nudge. Future notification types
 * can add siblings like `notifyApprovalPosted`, `notifyDealWon`.
 *
 * Design:
 *   - Null webhook URL → every notify is a no-op. Lets Vex ship
 *     without a Slack app configured; operators add the URL when
 *     they're ready.
 *   - All network failures swallow + log. A Slack outage must never
 *     block an agent run; the `lead.hot` event in the DB is the
 *     source of truth, Slack is a convenience surface.
 *   - 5s fetch timeout so a hung Slack doesn't stall the worker.
 */

export interface SlackNotifierConfig {
  webhookUrl: string | null;
  /** Absolute base URL for the Vex app, used in deep-links. */
  appBaseUrl: string | null;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  /** Override for tests. */
  log?: (level: "info" | "warn" | "error", msg: string, meta?: unknown) => void;
  /** Milliseconds before the webhook POST aborts. Default 5_000. */
  timeoutMs?: number;
}

export interface HotLeadSlackPayload {
  leadId: string;
  contactId: string | null;
  contactName: string | null;
  orgName: string | null;
  buyingIntent: string | null;
  urgency: string | null;
  product: string | null;
  volume: string | null;
  destination: string | null;
  timeline: string | null;
  summary: string | null;
  source: string | null;
}

export type SlackNotifyResult =
  | { ok: true }
  | { ok: false; reason: "disabled" | "timeout" | "http_error" | "exception" };

export class SlackNotifier {
  private readonly fetchImpl: typeof fetch;
  private readonly log: (
    level: "info" | "warn" | "error",
    msg: string,
    meta?: unknown,
  ) => void;
  private readonly timeoutMs: number;

  constructor(private readonly config: SlackNotifierConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.log =
      config.log ??
      ((level, msg, meta) => {
        // eslint-disable-next-line no-console
        const out = level === "error" ? console.error : console.warn;
        out(JSON.stringify({ level, msg, meta, service: "slack" }));
      });
    this.timeoutMs = config.timeoutMs ?? 5_000;
  }

  async notifyHotLead(payload: HotLeadSlackPayload): Promise<SlackNotifyResult> {
    if (!this.config.webhookUrl) {
      return { ok: false, reason: "disabled" };
    }

    const body = {
      blocks: buildHotLeadBlocks(payload, this.config.appBaseUrl),
      text: fallbackText(payload),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.config.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        this.log("warn", "slack webhook non-2xx", {
          status: response.status,
          text: text.slice(0, 200),
          lead_id: payload.leadId,
        });
        return { ok: false, reason: "http_error" };
      }
      return { ok: true };
    } catch (err) {
      const name = (err as Error).name;
      const reason = name === "AbortError" ? "timeout" : "exception";
      this.log("warn", `slack webhook ${reason}`, {
        error: (err as Error).message,
        lead_id: payload.leadId,
      });
      return { ok: false, reason };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Build Slack Block Kit blocks for a hot lead. Exported for tests
 * and for any future surface that wants to render the same message.
 */
export function buildHotLeadBlocks(
  p: HotLeadSlackPayload,
  appBaseUrl: string | null,
): Array<Record<string, unknown>> {
  const headline = p.contactName
    ? p.orgName
      ? `🔥 Hot lead — ${p.contactName} · ${p.orgName}`
      : `🔥 Hot lead — ${p.contactName}`
    : "🔥 Hot lead";

  const factLine = [
    p.product,
    p.volume,
    p.destination,
    p.timeline,
  ]
    .filter((v): v is string => !!v && v.length > 0)
    .join(" · ");

  const pills = [
    p.buyingIntent ? `*${p.buyingIntent.replace(/_/g, " ")}*` : null,
    p.urgency === "immediate" ? "⚡ immediate" : p.urgency,
    p.source ? `_via ${p.source.replace(/_/g, " ")}_` : null,
  ]
    .filter((v): v is string => !!v)
    .join(" · ");

  const deepLinkUrl =
    appBaseUrl && p.contactId
      ? `${appBaseUrl.replace(/\/$/, "")}/app/contacts/${p.contactId}`
      : appBaseUrl
        ? `${appBaseUrl.replace(/\/$/, "")}/app`
        : null;

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: { type: "plain_text", text: headline.slice(0, 150), emoji: true },
    },
  ];

  if (pills) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: pills }],
    });
  }

  if (p.summary) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: p.summary.slice(0, 2000) },
    });
  }

  if (factLine) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: factLine }],
    });
  }

  if (deepLinkUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open in Vex", emoji: true },
          url: deepLinkUrl,
          style: "primary",
        },
      ],
    });
  }

  return blocks;
}

/**
 * Plain-text fallback Slack renders in notifications / old clients.
 * Keep it short — this is the push-notification teaser line.
 */
function fallbackText(p: HotLeadSlackPayload): string {
  const who = p.contactName
    ? p.orgName
      ? `${p.contactName} @ ${p.orgName}`
      : p.contactName
    : "unknown contact";
  const what = p.product
    ? p.volume
      ? `${p.product} ${p.volume}`
      : p.product
    : "trade signal";
  return `🔥 Hot lead: ${who} — ${what}`;
}
