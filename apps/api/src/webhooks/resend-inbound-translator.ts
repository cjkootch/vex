/**
 * Translate Resend Inbound's webhook payload to the canonical
 * `email.received` shape `EmailInboundNormalizer` already consumes.
 * Keeping Resend-specific parsing here means the normalizer stays
 * provider-agnostic — every new inbound provider (SendGrid, Postmark,
 * Mailgun, SES) gets its own translator file and reuses the same
 * downstream pipeline.
 *
 * Resend wraps the event in the standard Svix envelope:
 *   { type: "email.received", created_at: ISO, data: { ... } }
 *
 * The `data` fields are defensive-parsed because Resend has rotated
 * shapes historically (from/to as string vs {email,name}; headers as
 * {k:v} object vs [{name,value}] array). The translator accepts both
 * and normalises to our canonical flat shape.
 */

export interface ResendInboundCanonical {
  event: "email.received";
  from: string;
  to: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  message_id: string;
  in_reply_to: string | null;
  received_at: string | null;
}

export function translateResendInbound(
  payload: Record<string, unknown>,
): ResendInboundCanonical | { error: string } {
  const type = typeof payload["type"] === "string" ? (payload["type"] as string) : "";
  // Accept either "email.received" or "inbound.received" — Resend
  // hasn't been fully consistent across docs.
  if (type !== "email.received" && type !== "inbound.received") {
    return { error: `unsupported_type: ${type || "<missing>"}` };
  }

  const data =
    typeof payload["data"] === "object" && payload["data"] !== null
      ? (payload["data"] as Record<string, unknown>)
      : payload; // some providers emit the data flat at the top level

  const from = extractAddress(data["from"]);
  if (!from) return { error: "missing_from" };

  const to = extractAddressList(data["to"]);
  if (to.length === 0) return { error: "missing_to" };

  const headers = extractHeaders(data["headers"]);

  // RFC-5322 Message-ID in the headers wins when present — it's the
  // id clients use for threading (In-Reply-To / References), so
  // keeping it as the canonical id is what lets replies-of-replies
  // stitch cleanly onto the same contact timeline. Fall back to
  // Resend's own identifiers only when headers don't include one.
  const messageId =
    headers["message-id"] ??
    stringOrNull(data["message_id"]) ??
    stringOrNull(data["email_id"]) ??
    null;
  if (!messageId) return { error: "missing_message_id" };

  const inReplyTo =
    stringOrNull(data["in_reply_to"]) ?? headers["in-reply-to"] ?? null;

  return {
    event: "email.received",
    from,
    to,
    subject: stringOrNull(data["subject"]),
    text: stringOrNull(data["text"]),
    html: stringOrNull(data["html"]),
    message_id: messageId,
    in_reply_to: inReplyTo,
    received_at:
      stringOrNull(data["received_at"]) ??
      stringOrNull(payload["created_at"]) ??
      null,
  };
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function extractAddress(v: unknown): string | null {
  if (typeof v === "string" && v.includes("@")) return v.toLowerCase().trim();
  if (typeof v === "object" && v !== null) {
    const obj = v as Record<string, unknown>;
    const email = obj["email"];
    if (typeof email === "string" && email.includes("@")) {
      return email.toLowerCase().trim();
    }
  }
  return null;
}

function extractAddressList(v: unknown): string[] {
  if (!Array.isArray(v)) {
    const single = extractAddress(v);
    return single ? [single] : [];
  }
  const out: string[] = [];
  for (const item of v) {
    const addr = extractAddress(item);
    if (addr) out.push(addr);
  }
  return out;
}

/**
 * Normalise Resend's headers shape into a lowercased {k: v} map so
 * we can look up `message-id`, `in-reply-to` without worrying about
 * which shape the current Resend version emits.
 */
function extractHeaders(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v) return out;
  if (Array.isArray(v)) {
    for (const entry of v) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const name = typeof e["name"] === "string" ? e["name"].toLowerCase() : null;
      const value = typeof e["value"] === "string" ? e["value"] : null;
      if (name && value) out[name] = value;
    }
    return out;
  }
  if (typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") out[k.toLowerCase()] = val;
    }
  }
  return out;
}
