import Twilio from "twilio";

export interface TwilioDeps {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

/**
 * Construct a Twilio client for PSTN voice and SMS. Per-call minute cost
 * accounting lives in the worker that consumes Twilio status webhooks.
 */
export function createTwilioClient(deps: TwilioDeps) {
  const client = Twilio(deps.accountSid, deps.authToken);

  return {
    client,
    async sendSms(to: string, body: string) {
      return client.messages.create({
        from: deps.fromNumber,
        to,
        body,
      });
    },
  };
}
