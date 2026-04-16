import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { loadEnv } from "@vex/config";
import { initOtel, shutdownOtel } from "@vex/telemetry";
import { AppModule } from "./app.module.js";

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  initOtel({
    serviceName: "vex-api",
    serviceNamespace: env.OTEL_SERVICE_NAMESPACE,
    ...(env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? { otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT }
      : {}),
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: { level: env.LOG_LEVEL } }),
  );

  const shutdown = async (): Promise<void> => {
    await app.close();
    await shutdownOtel();
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen(env.PORT, "0.0.0.0");
}

void bootstrap();
