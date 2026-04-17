import { Client, Connection } from "@temporalio/client";

export const TEMPORAL_TASK_QUEUE = "vex-main";

export interface TemporalConfig {
  address: string;
  namespace: string;
  /** Optional Temporal Cloud API key — when set the client uses TLS. */
  apiKey?: string;
}

/**
 * Build a Temporal `Client`. Local dev hits the `temporalite` container at
 * `localhost:7233`; production reads `TEMPORAL_ADDRESS` (e.g.
 * `<namespace>.tmprl.cloud:7233`) and `TEMPORAL_NAMESPACE` from env.
 *
 * Caller owns the underlying Connection lifecycle — call `closeTemporalClient`
 * on shutdown to release the gRPC channel cleanly.
 */
export async function createTemporalClient(
  config: TemporalConfig,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const connection = await Connection.connect({
    address: config.address,
    ...(config.apiKey ? { tls: true, apiKey: config.apiKey } : {}),
  });
  const client = new Client({
    connection,
    namespace: config.namespace,
  });
  return {
    client,
    async close() {
      await connection.close();
    },
  };
}

/**
 * Workflow ID conventions. Centralised so the API and worker agree on
 * which workflow to signal.
 */
export const WorkflowId = {
  approval: (approvalId: string): string => `approval-${approvalId}`,
  research: (orgId: string): string => `research-${orgId}`,
  followUp: (agentRunId: string): string => `follow-up-${agentRunId}`,
  /** Sprint 12 — one workflow per outbound PSTN call attempt. */
  outboundCall: (agentRunId: string): string => `outbound-call-${agentRunId}`,
} as const;
