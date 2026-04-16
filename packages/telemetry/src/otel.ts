import { NodeSDK, type NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_NAMESPACE,
  SEMRESATTRS_SERVICE_VERSION,
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

  const config: Partial<NodeSDKConfiguration> = {
    resource: new Resource({
      [SEMRESATTRS_SERVICE_NAME]: options.serviceName,
      [SEMRESATTRS_SERVICE_NAMESPACE]: options.serviceNamespace ?? "vex",
      [SEMRESATTRS_SERVICE_VERSION]: options.serviceVersion ?? "0.0.0",
    }),
  };

  if (options.otlpEndpoint) {
    config.traceExporter = new OTLPTraceExporter({
      url: `${options.otlpEndpoint}/v1/traces`,
    });
  }

  sdk = new NodeSDK(config);
  sdk.start();
}

/** Flush and shut down the OTel SDK. Call from process shutdown hooks. */
export async function shutdownOtel(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = undefined;
}
