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

export interface SendEmailResult {
  /** Provider-assigned message id — persisted as the idempotency key. */
  id: string | null;
  error: string | null;
}

export interface ResendClient {
  send(req: SendEmailRequest): Promise<SendEmailResult>;
}

export function createResendClient(deps: ResendDeps): ResendClient {
  const client = new Resend(deps.apiKey);

  return {
    async send(req: SendEmailRequest): Promise<SendEmailResult> {
      const response = await client.emails.send({
        from: deps.defaultFrom,
        to: [...req.to],
        subject: req.subject,
        text: req.text,
        ...(req.replyTo !== undefined ? { reply_to: req.replyTo } : {}),
      });
      // Resend SDK returns `{ data: { id } | null, error: ResendError | null }`.
      // Normalise into our own shape so the executor never touches the SDK
      // type surface directly.
      const data = response.data;
      const error = response.error;
      return {
        id: data?.id ?? null,
        error: error ? `${error.name}: ${error.message}` : null,
      };
    },
  };
}
