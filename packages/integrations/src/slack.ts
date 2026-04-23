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

export interface NewChatSlackPayload {
  leadId: string;
  contactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  orgName: string | null;
  pageUrl: string | null;
  referrer: string | null;
}

export interface BackupRequestSlackPayload {
  workflowId: string;
  callSid: string | null;
  calleeName: string | null;
  calleeOrg: string | null;
  reason: string | null;
  /** Seconds elapsed since the call connected, at the moment backup was requested. */
  durationAtRequestSeconds: number;
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
    return this.post(
      buildHotLeadBlocks(payload, this.config.appBaseUrl),
      fallbackText(payload),
      payload.leadId,
    );
  }

  /**
   * Lighter notification fired when a visitor opens the marketing
   * chatbot and identifies themselves (name + email gate). Goes out
   * before any qualification — every chat session is a lead-quality
   * signal worth knowing about, not just the ones that get parsed
   * as hot. Cold or qualified-later chats still produce one of these.
   */
  async notifyNewChat(payload: NewChatSlackPayload): Promise<SlackNotifyResult> {
    return this.post(
      buildNewChatBlocks(payload, this.config.appBaseUrl),
      newChatFallback(payload),
      payload.leadId,
    );
  }

  /**
   * Fires when the AI on an outbound voice call escalates via the
   * escalate_to_human tool — the callee is live on the phone asking
   * for a human. Urgent by design: loud header, a Join-call deep link
   * that drops the operator into the conference immediately.
   */
  async notifyBackupRequest(
    payload: BackupRequestSlackPayload,
  ): Promise<SlackNotifyResult> {
    return this.post(
      buildBackupRequestBlocks(payload, this.config.appBaseUrl),
      backupRequestFallback(payload),
      payload.workflowId,
    );
  }

  private async post(
    blocks: Array<Record<string, unknown>>,
    text: string,
    leadId: string,
  ): Promise<SlackNotifyResult> {
    if (!this.config.webhookUrl) {
      return { ok: false, reason: "disabled" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.config.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blocks, text }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const respText = await response.text().catch(() => "");
        this.log("warn", "slack webhook non-2xx", {
          status: response.status,
          text: respText.slice(0, 200),
          lead_id: leadId,
        });
        return { ok: false, reason: "http_error" };
      }
      return { ok: true };
    } catch (err) {
      const name = (err as Error).name;
      const reason = name === "AbortError" ? "timeout" : "exception";
      this.log("warn", `slack webhook ${reason}`, {
        error: (err as Error).message,
        lead_id: leadId,
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
 * Block Kit blocks for a brand-new visitor chat. Carries the visitor
 * identity + page context — no qualification needed.
 */
export function buildNewChatBlocks(
  p: NewChatSlackPayload,
  appBaseUrl: string | null,
): Array<Record<string, unknown>> {
  const headline = p.contactName
    ? p.orgName
      ? `💬 New website chat — ${p.contactName} · ${p.orgName}`
      : `💬 New website chat — ${p.contactName}`
    : "💬 New website chat";

  const contextBits = [
    p.contactEmail ? `\`${p.contactEmail}\`` : null,
    p.pageUrl ? `<${p.pageUrl}|${shortUrl(p.pageUrl)}>` : null,
    p.referrer ? `_via ${shortUrl(p.referrer)}_` : null,
  ].filter((v): v is string => !!v);

  const deepLinkUrl =
    appBaseUrl && p.contactId
      ? `${appBaseUrl.replace(/\/$/, "")}/app/contacts/${p.contactId}`
      : appBaseUrl
        ? `${appBaseUrl.replace(/\/$/, "")}/app/inbox`
        : null;

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: { type: "plain_text", text: headline.slice(0, 150), emoji: true },
    },
  ];
  if (contextBits.length > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: contextBits.join(" · ") }],
    });
  }
  if (deepLinkUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open contact", emoji: true },
          url: deepLinkUrl,
          style: "primary",
        },
      ],
    });
  }
  return blocks;
}

function newChatFallback(p: NewChatSlackPayload): string {
  const who = p.contactName
    ? p.orgName
      ? `${p.contactName} @ ${p.orgName}`
      : p.contactName
    : (p.contactEmail ?? "unknown visitor");
  return `💬 New website chat: ${who}`;
}

/**
 * Block Kit for an urgent "AI needs you on this call" nudge. Loud
 * header, caller-identity context line, elapsed time, and a single
 * Join-call primary button deep-linking into /app/calls/:workflowId
 * where the existing LiveListenPanel can drop the operator into
 * the conference via Voice SDK.
 */
export function buildBackupRequestBlocks(
  p: BackupRequestSlackPayload,
  appBaseUrl: string | null,
): Array<Record<string, unknown>> {
  const who = p.calleeName
    ? p.calleeOrg
      ? `${p.calleeName} · ${p.calleeOrg}`
      : p.calleeName
    : (p.calleeOrg ?? "caller");
  const headline = `📞 AI needs backup — ${who}`;

  const mm = Math.floor(p.durationAtRequestSeconds / 60);
  const ss = p.durationAtRequestSeconds % 60;
  const elapsed = `${mm}:${ss.toString().padStart(2, "0")}`;

  const contextBits = [
    `live · ${elapsed} in`,
    p.reason ? `_"${p.reason.slice(0, 120)}"_` : null,
  ].filter((v): v is string => !!v);

  const joinUrl = appBaseUrl
    ? `${appBaseUrl.replace(/\/$/, "")}/app/calls/${p.workflowId}`
    : null;

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: { type: "plain_text", text: headline.slice(0, 150), emoji: true },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: contextBits.join(" · ") }],
    },
  ];
  if (joinUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Join call", emoji: true },
          url: joinUrl,
          style: "danger",
        },
      ],
    });
  }
  return blocks;
}

function backupRequestFallback(p: BackupRequestSlackPayload): string {
  const who = p.calleeName ?? p.calleeOrg ?? "caller";
  return `📞 AI needs backup on call with ${who}`;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.host}${path}`.slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
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
