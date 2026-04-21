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
 * email_id/attachments). The parsed body lives behind their REST API:
 * GET /emails/{id} — reachable with the same API key we use to send.
 * Returns null on non-200 or fetch error so the caller can treat it
 * as best-effort and still store the metadata-only row.
 */
export interface InboundEmailBody {
  text: string | null;
  html: string | null;
}

export async function fetchResendInboundBody(
  apiKey: string,
  emailId: string,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<InboundEmailBody | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(
      `https://api.resend.com/emails/${encodeURIComponent(emailId)}`,
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
    return {
      text: typeof body.text === "string" ? body.text : null,
      html: typeof body.html === "string" ? body.html : null,
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
