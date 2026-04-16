import { NativeConnection, Worker as TemporalWorker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export interface TemporalRunnerOptions {
  address: string;
  namespace: string;
  taskQueue: string;
}

/**
 * Temporal host for durable orchestrations. Workflows live in
 * `./workflows.ts`; activities will be wired in as features land.
 */
export async function startTemporalWorker(
  options: TemporalRunnerOptions,
): Promise<TemporalWorker> {
  const connection = await NativeConnection.connect({ address: options.address });

  const here = dirname(fileURLToPath(import.meta.url));
  const worker = await TemporalWorker.create({
    connection,
    namespace: options.namespace,
    taskQueue: options.taskQueue,
    workflowsPath: resolve(here, "./workflows.js"),
    activities: {},
  });

  void worker.run();
  return worker;
}
