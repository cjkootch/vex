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
