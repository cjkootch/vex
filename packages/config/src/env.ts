import { z } from "zod";

/**
 * Vex environment schema.
 *
 * The Postgres connection is split into two separate URLs per the invariants:
 *   - APPLICATION_DATABASE_URL — pooled connection used for all runtime app queries.
 *   - MIGRATION_DATABASE_URL  — direct connection used exclusively for Drizzle migrations.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Postgres (Neon)
  APPLICATION_DATABASE_URL: z
    .string()
    .url()
    .describe("Pooled Neon endpoint used by all application queries."),
  MIGRATION_DATABASE_URL: z
    .string()
    .url()
    .describe("Direct Neon endpoint used only by the migration runner."),

  // Redis (BullMQ queues, caching)
  REDIS_URL: z.string().url(),

  // S3 / Localstack
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string(),
  S3_ACCESS_KEY_ID: z.string(),
  S3_SECRET_ACCESS_KEY: z.string(),

  // LLM providers
  ANTHROPIC_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),

  // Model pinning (invariants demand explicit model versions)
  ANTHROPIC_REASONING_MODEL: z.string().default("claude-sonnet-4-20250514"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  /**
   * OpenAI Realtime model used for browser voice sessions (Sprint 9).
   * Ephemeral session tokens are minted against this model.
   */
  VOICE_REALTIME_MODEL: z.string().default("gpt-4o-realtime-preview-2024-12-17"),
  /** Voice context token budget — hard ceiling enforced by VoiceContextBuilder. */
  VOICE_CONTEXT_TOKEN_BUDGET: z.coerce.number().int().positive().default(10_000),

  // PSTN / email / messaging
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  /**
   * WhatsApp sender, format `whatsapp:+E164`. Optional — when absent
   * the whatsapp.send approval branch fails closed with
   * `whatsapp_not_configured`. Requires the Twilio WhatsApp sender to
   * be approved on the account.
   */
  TWILIO_WHATSAPP_FROM: z.string().optional(),
  /**
   * Public base URL Twilio hits for TwiML + status + recording webhooks.
   * Required whenever the Twilio credentials above are set — the
   * OutboundCallWorkflow cannot complete without reachable callback URLs.
   * Local dev: ngrok tunnel. Prod: the deployed apps/api domain.
   */
  APP_BASE_URL: z.string().url().optional(),
  RESEND_API_KEY: z.string().optional(),
  /**
   * Resend (Svix) webhook signing secret. Format: `whsec_<base64>`. Required
   * by the Resend webhook handler — the verifier strips the `whsec_` prefix
   * and base64-decodes the remainder for HMAC-SHA256.
   */
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),

  // Temporal
  TEMPORAL_ADDRESS: z.string().default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().default("default"),
  TEMPORAL_TASK_QUEUE: z.string().default("vex-workers"),

  // Observability
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default("vex"),
  OTEL_SERVICE_NAMESPACE: z.string().default("vex"),

  // App
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  PORT: z.coerce.number().int().positive().default(3000),

  // Auth (NextAuth.js v5)
  /**
   * Shared secret for NextAuth JWE encryption. Both apps/web (issuer) and
   * apps/api (verifier) MUST use the same value or tokens won't decode.
   * Generate with `openssl rand -base64 32`.
   */
  NEXTAUTH_SECRET: z.string().min(32).optional(),
  NEXTAUTH_URL: z.string().url().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parse and validate an env-like record. Throws a ZodError with the combined
 * issue list if any required variable is missing or malformed. The caller is
 * expected to wrap with a human-friendly error banner at boot.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

/**
 * Lazy-loaded, cached env. Access this from app entrypoints only; library
 * packages should accept config by argument to stay testable.
 */
let _env: Env | undefined;
export const env = new Proxy({} as Env, {
  get(_target, prop: keyof Env) {
    if (!_env) _env = loadEnv();
    return _env[prop];
  },
});
