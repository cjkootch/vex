/**
 * NestJS DI tokens. Symbols ensure no string drift between module providers
 * and constructor injections.
 */
export const DB_CLIENT = Symbol("DB_CLIENT");
export const RAW_EVENT_REPO = Symbol("RAW_EVENT_REPO");
export const NORMALIZATION_QUEUE = Symbol("NORMALIZATION_QUEUE");
export const RESEND_VERIFIER = Symbol("RESEND_VERIFIER");
export const RESEND_INBOUND_VERIFIER = Symbol("RESEND_INBOUND_VERIFIER");
/**
 * Resend REST API key (not the webhook signing secret). Used by the
 * inbound webhook handler to fetch the parsed email body — Resend's
 * webhook payload is metadata-only, the body lives behind GET /emails/:id.
 * Null when RESEND_API_KEY isn't set; inbound then stores metadata only.
 */
export const RESEND_API_KEY = Symbol("RESEND_API_KEY");
export const TWILIO_VERIFIER = Symbol("TWILIO_VERIFIER");
export const WEBSITE_CHAT_VERIFIER = Symbol("WEBSITE_CHAT_VERIFIER");
export const WEBHOOK_TENANT_RESOLVER = Symbol("WEBHOOK_TENANT_RESOLVER");

/**
 * Sprint 2 ships a single demo tenant. The resolver returns its tenantId so
 * the webhook handler isn't tied to a specific value. Sprint 3 will derive
 * tenantId from a per-provider routing config.
 */
export type WebhookTenantResolver = (
  provider:
    | "resend"
    | "resend_inbound"
    | "twilio"
    | "website_chat"
    | "website_form"
    | "email_inbound",
  payload: unknown,
) => string;
