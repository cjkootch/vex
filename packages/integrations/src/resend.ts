import { Resend } from "resend";

export interface ResendDeps {
  apiKey: string;
  defaultFrom: string;
}

export interface SendEmailRequest {
  to: string | readonly string[];
  subject: string;
  /** Plain-text body. HTML is rendered from typed ViewManifests elsewhere. */
  text: string;
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
        replyTo: req.replyTo,
      });
    },
  };
}
