import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { loadEnv } from "@vex/config";
import { createDb, RawEventRepository } from "@vex/db";
import { createQueues, createRedisConnection } from "@vex/agents";
import { initOtel, shutdownOtel } from "@vex/telemetry";
import { AppModule } from "./app.module.js";
import { WebhooksModule } from "./webhooks/webhooks.module.js";

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

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      nextAuthSecret: env.NEXTAUTH_SECRET,
      webhooks: WebhooksModule.register({
        db,
        rawEventRepository,
        normalizationQueue: queues.normalization,
        resendSecret: env.RESEND_WEBHOOK_SECRET,
        twilioAuthToken: env.TWILIO_AUTH_TOKEN,
        // Sprint 2 ships a single demo tenant; Sprint 3 will derive this from
        // a per-provider routing config keyed by webhook account/secret.
        resolveTenant: () => "01HSEEDWRK0000000000000001",
      }),
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
