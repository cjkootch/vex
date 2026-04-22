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

  // PSTN / email
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  /**
   * Twilio WhatsApp sender. Format: `whatsapp:+E164`. Defaults to
   * Twilio's shared sandbox number (`+14155238886`) — works only
   * after the recipient has sent `join <word>` to that number once.
   * For production, set this to your own approved WhatsApp-enabled
   * number with the `whatsapp:` prefix preserved.
   */
  TWILIO_WHATSAPP_FROM: z.string().default("whatsapp:+14155238886"),
  /**
   * Sprint J — browser live-listen + operator-join use Twilio's Voice
   * SDK. The SDK authenticates with a short-lived Access Token signed
   * by an API Key + Secret (distinct from the Account Auth Token).
   * All three must be set together; when any is missing the
   * /calls/:id/join endpoint 503s and the UI shows a configuration
   * error instead of silently failing mid-call.
   *
   * Create the API Key + Secret in the Twilio Console (Settings →
   * API Keys). The TwiML App SID routes browser-originated dials —
   * in Vex the app's Voice URL should POST to /calls/twilio/join-twiml
   * so outbound-from-browser lands on the correct Conference.
   */
  TWILIO_API_KEY: z.string().optional(),
  TWILIO_API_SECRET: z.string().optional(),
  TWILIO_TWIML_APP_SID: z.string().optional(),
  /**
   * Sprint K — enable the real-time AI escalation listener. When `true`,
   * the outbound TwiML forks callee audio via `<Start><Stream>` to
   * /calls/twilio/stream, which runs an OpenAI Realtime session with
   * an `escalate_to_human` tool. The AI listens (not talks) and
   * auto-invokes requestHumanBackup when it hears escalation signals.
   *
   * Requires OPENAI_API_KEY + APP_BASE_URL (for the wss:// URL Twilio
   * POSTs into) to already be set. When `false` the bridge is inert
   * and the TwiML matches Sprint J's conference-only shape.
   */
  VEX_AI_VOICE_ENABLED: z.coerce.boolean().default(false),
  /**
   * OpenAI Realtime model for the escalation listener session. Distinct
   * from VOICE_REALTIME_MODEL (which powers the browser operator voice)
   * so we can dial the call-side model independently of the browser
   * one — they have different latency/cost trade-offs.
   */
  OPENAI_REALTIME_CALL_MODEL: z
    .string()
    .default("gpt-4o-realtime-preview-2024-12-17"),
  /**
   * Voice preset for the AI talkback session. OpenAI Realtime options:
   * alloy, ash, ballad, coral, echo, sage, shimmer, verse. `verse` is
   * the most animated/expressive; `ballad` and `coral` are next. Tune
   * via `fly secrets set OPENAI_REALTIME_CALL_VOICE=...` without a
   * redeploy to A/B different tones.
   */
  OPENAI_REALTIME_CALL_VOICE: z
    .enum([
      "alloy",
      "ash",
      "ballad",
      "coral",
      "echo",
      "sage",
      "shimmer",
      "verse",
    ])
    .default("verse"),
  /**
   * Server-VAD threshold for the call-side Realtime session. Range
   * 0.0–1.0; higher = less sensitive (fewer false triggers on coughs,
   * background noise, line static). OpenAI default is 0.5; we bump
   * to 0.7 for phone-quality audio.
   */
  OPENAI_REALTIME_CALL_VAD_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  /**
   * How much silence (ms) must follow speech before the AI considers
   * the callee's turn finished and starts responding. Longer values
   * tolerate coughs, pauses, and "let me think" breaths; shorter
   * values feel snappier but cut people off. OpenAI default 500ms.
   */
  OPENAI_REALTIME_CALL_VAD_SILENCE_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(5000)
    .default(1400),
  /**
   * Audio prefix included before the detected speech start — gives
   * the model a bit of lead-in so it doesn't clip the first syllable.
   */
  OPENAI_REALTIME_CALL_VAD_PREFIX_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(2000)
    .default(300),
  /**
   * Public base URL Twilio hits for TwiML + status + recording webhooks.
   * Required whenever the Twilio credentials above are set — the
   * OutboundCallWorkflow cannot complete without reachable callback URLs.
   * Local dev: ngrok tunnel. Prod: the deployed apps/api domain.
   */
  APP_BASE_URL: z.string().url().optional(),
  /**
   * Public URL of the VEX WEB app (Next.js on Vercel). Used by the
   * Slack notifier's "Open in Vex" deep-link so operators click
   * through to the app UI, not the API. `APP_BASE_URL` (above) is
   * the API hostname Twilio POSTs into — kept as a separate env so
   * neither can break the other. Worker falls back to APP_BASE_URL
   * if WEB_BASE_URL is unset; when both are unset the deep-link
   * button is omitted.
   */
  WEB_BASE_URL: z.string().url().optional(),
  /**
   * Tavily Search API key for the chat agent's `research_contact`
   * tool. Optional — when unset, the tool is not registered and the
   * agent tells the user research is unavailable instead of
   * fabricating details.
   */
  TAVILY_API_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  /**
   * Resend "from" address for outbound email. Must match a verified
   * sender on the domain configured in Resend. Format:
   * `"Display Name <user@verified-domain.tld>"` or a bare email.
   */
  /**
   * From-address Resend uses for every outbound email. Must be a
   * VERIFIED domain in your Resend dashboard, otherwise every send
   * gets a "domain not verified" rejection. Accepted shapes:
   *   "email@example.com"
   *   "Display Name <email@example.com>"
   * Angle-bracket form gets cleaner inbox display. The regex
   * validates at boot so a typo fails the worker immediately
   * instead of every queued email.send falling over at dispatch
   * with a generic Resend validation error.
   */
  RESEND_DEFAULT_FROM: z
    .string()
    .regex(
      /^(?:[^<]+<\s*[^\s@<>]+@[^\s@<>]+\s*>|[^\s@<>]+@[^\s@<>]+)$/,
      "RESEND_DEFAULT_FROM must be 'email@domain' or 'Display Name <email@domain>'",
    )
    .default("Vex <vector@vexhq.ai>"),
  /**
   * Resend (Svix) webhook signing secret. Format: `whsec_<base64>`. Required
   * by the Resend webhook handler — the verifier strips the `whsec_` prefix
   * and base64-decodes the remainder for HMAC-SHA256.
   */
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),

  /**
   * Svix secret for the Resend Inbound webhook (replies + fresh
   * inbound email parsed out of the MX-backed domain). Each Resend
   * endpoint gets its own secret in the dashboard — distinct from
   * RESEND_WEBHOOK_SECRET which signs outbound delivery events.
   * Falls back to RESEND_WEBHOOK_SECRET at the module boundary when
   * unset, so operators can reuse one secret across endpoints
   * temporarily while they configure the Resend side.
   */
  RESEND_INBOUND_WEBHOOK_SECRET: z.string().min(1).optional(),

  /**
   * HMAC-SHA256 shared secret for the VTC marketing-site chat webhook.
   * The website signs `${timestamp}.${rawBody}` with this secret and
   * delivers the hex digest in `X-VTC-Signature` + unix seconds in
   * `X-VTC-Timestamp`.
   */
  WEBSITE_CHAT_WEBHOOK_SECRET: z.string().min(1).optional(),
  /**
   * Slack Incoming Webhook URL — when set, the worker posts a hot-
   * lead nudge to the configured channel every time the
   * LeadQualificationAgent fires a `lead.hot` signal. When unset,
   * every notify is a no-op. Create one at api.slack.com/apps →
   * Create New App → Incoming Webhooks → Add New Webhook to
   * Workspace. Keep the URL secret; anyone with it can post.
   */
  SLACK_WEBHOOK_URL: z.string().url().optional(),

  // Temporal
  TEMPORAL_ADDRESS: z.string().default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().default("default"),
  TEMPORAL_TASK_QUEUE: z.string().default("vex-workers"),
  /**
   * Temporal Cloud API key. Unset for local dev (temporalite, no TLS);
   * set on Fly to `tmprl_*` to authenticate against Temporal Cloud.
   * When present, both the Temporal Client (apps/api) and Worker
   * (apps/worker) flip to TLS + Bearer-token auth automatically.
   */
  TEMPORAL_API_KEY: z.string().optional(),

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

  /**
   * The workspace (tenant) every un-authenticated webhook delivery
   * lands in. Set this per-environment — the seed value is a
   * placeholder for local dev only. When multi-tenant delivery
   * routing is added, this becomes the *fallback* when a payload
   * doesn't carry enough metadata to pick a workspace.
   */
  DEFAULT_WORKSPACE_ID: z
    .string()
    .min(1)
    .default("01HSEEDWRK0000000000000001"),
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
