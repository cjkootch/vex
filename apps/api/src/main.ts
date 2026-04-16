import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { loadEnv } from "@vex/config";
import { createDb, RawEventRepository, RetrievalService } from "@vex/db";
import { createQueues, createRedisConnection } from "@vex/agents";
import { AnthropicAdapter, OpenAIAdapter } from "@vex/integrations";
import { initOtel, InMemoryCostLedger, shutdownOtel } from "@vex/telemetry";
import { AppModule } from "./app.module.js";
import { WebhooksModule } from "./webhooks/webhooks.module.js";
import { QueryModule } from "./query/query.module.js";

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  initOtel({
    serviceName: "vex-api",
    serviceNamespace: env.OTEL_SERVICE_NAMESPACE,
    ...(env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? { otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT }
      : {}),
  });

  if (!env.RESEND_WEBHOOK_SECRET) {
    throw new Error("RESEND_WEBHOOK_SECRET is required to start the API");
  }
  if (!env.TWILIO_AUTH_TOKEN) {
    throw new Error("TWILIO_AUTH_TOKEN is required to start the API");
  }
  if (!env.NEXTAUTH_SECRET) {
    throw new Error("NEXTAUTH_SECRET is required to start the API");
  }

  const db = createDb(env.APPLICATION_DATABASE_URL);
  const rawEventRepository = new RawEventRepository();
  const redis = createRedisConnection(env.REDIS_URL);
  const queues = createQueues(redis);

  // Sprint 4 wires an in-memory cost ledger; Sprint 5 will swap for the
  // Postgres-backed PerTenantCostLedger that writes to agent_runs.cost_usd.
  const costLedger = new InMemoryCostLedger();
  const openai = new OpenAIAdapter({ apiKey: env.OPENAI_API_KEY, costLedger });
  const anthropic = new AnthropicAdapter({ apiKey: env.ANTHROPIC_API_KEY, costLedger });
  const retrieval = new RetrievalService();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      nextAuthSecret: env.NEXTAUTH_SECRET,
      webhooks: WebhooksModule.register({
        db,
        rawEventRepository,
        normalizationQueue: queues.normalization,
        resendSecret: env.RESEND_WEBHOOK_SECRET,
        twilioAuthToken: env.TWILIO_AUTH_TOKEN,
        resolveTenant: () => "01HSEEDWRK0000000000000001",
      }),
      query: QueryModule.register({ db, retrieval, openai, anthropic }),
    }),
    new FastifyAdapter({ logger: { level: env.LOG_LEVEL } }),
    { rawBody: true },
  );

  const shutdown = async (): Promise<void> => {
    await app.close();
    await queues.close();
    redis.disconnect();
    await shutdownOtel();
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen(env.PORT, "0.0.0.0");
}

void bootstrap();
