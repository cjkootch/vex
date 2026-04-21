import { Resend } from "resend";

export interface ResendDeps {
  apiKey: string;
  defaultFrom: string;
}

export interface SendEmailRequest {
  to: string | readonly string[];
  subject: string;
  /** Plain-text body. Required (email clients + accessibility). */
  text: string;
  /** Optional HTML body. When present Resend delivers a multipart. */
  html?: string;
  replyTo?: string;
}

/**
 * Resend's inbound webhook delivers metadata only (from/to/subject/
 * email_id/attachments). The parsed body lives behind
 * GET /emails/receiving/{id} — distinct from the outbound GET
 * /emails/{id} which 404s for inbound ids. Returns null on non-200
 * or fetch error so the caller can treat it as best-effort and
 * still store the metadata-only row.
 */
export interface InboundEmailBody {
  text: string | null;
  html: string | null;
}

/**
 * Cap the returned text + html so the downstream EmailInboundPayload
 * zod schema (`text.max(200_000)`, `html.max(500_000)`) never rejects
 * a real email. Threaded Outlook replies with embedded base64 image
 * signatures blow past 500KB easily — 6 thread turns × ~60KB inline
 * PNG = 400KB+ before the zod cap cares about the html's own length.
 */
const TEXT_CAP = 190_000;
const HTML_CAP = 480_000;

export async function fetchResendInboundBody(
  apiKey: string,
  emailId: string,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<InboundEmailBody | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(
      `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey}` },
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      text?: string | null;
      html?: string | null;
    };
    const text = typeof body.text === "string" ? body.text : null;
    const html = typeof body.html === "string" ? body.html : null;
    return {
      text: text !== null ? text.slice(0, TEXT_CAP) : null,
      html: html !== null ? html.slice(0, HTML_CAP) : null,
    };
  } catch {
    return null;
  }
}

export function createResendClient(deps: ResendDeps) {
  const client = new Resend(deps.apiKey);

  return {
    async send(req: SendEmailRequest) {
      return client.emails.send({
        from: deps.defaultFrom,
        to: [...req.to],
        subject: req.subject,
        text: req.text,
        ...(req.html !== undefined ? { html: req.html } : {}),
        ...(req.replyTo !== undefined ? { reply_to: req.replyTo } : {}),
      });
    },
  };
}
