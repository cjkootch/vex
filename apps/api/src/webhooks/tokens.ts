/**
 * NestJS DI tokens. Symbols ensure no string drift between module providers
 * and constructor injections.
 */
export const DB_CLIENT = Symbol("DB_CLIENT");
export const RAW_EVENT_REPO = Symbol("RAW_EVENT_REPO");
export const NORMALIZATION_QUEUE = Symbol("NORMALIZATION_QUEUE");
export const RESEND_VERIFIER = Symbol("RESEND_VERIFIER");
export const TWILIO_VERIFIER = Symbol("TWILIO_VERIFIER");
export const WEBHOOK_TENANT_RESOLVER = Symbol("WEBHOOK_TENANT_RESOLVER");

/**
 * Sprint 2 ships a single demo tenant. The resolver returns its tenantId so
 * the webhook handler isn't tied to a specific value. Sprint 3 will derive
 * tenantId from a per-provider routing config.
 */
export type WebhookTenantResolver = (
  provider: "resend" | "twilio",
  payload: unknown,
) => string;
