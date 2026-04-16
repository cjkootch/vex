import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

export interface OtelInitOptions {
  serviceName: string;
  serviceNamespace?: string;
  serviceVersion?: string;
  otlpEndpoint?: string;
}

let sdk: NodeSDK | undefined;

/**
 * Initialize the OTel Node SDK. Safe to call at most once per process; a second
 * call is a no-op (avoids double-init from hot reloading).
 */
export function initOtel(options: OtelInitOptions): void {
  if (sdk) return;

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_NAMESPACE]: options.serviceNamespace ?? "vex",
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? "0.0.0",
    }),
    traceExporter: options.otlpEndpoint
      ? new OTLPTraceExporter({ url: `${options.otlpEndpoint}/v1/traces` })
      : undefined,
  });

  sdk.start();
}

/** Flush and shut down the OTel SDK. Call from process shutdown hooks. */
export async function shutdownOtel(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = undefined;
}
