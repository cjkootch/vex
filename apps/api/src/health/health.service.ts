import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { Db } from "@vex/db";
import { pingDb } from "@vex/db";
import type { Client as TemporalClient } from "@temporalio/client";
import type { QueueHandles } from "@vex/agents";
import { getQueueDepths } from "@vex/agents";
import {
  HEALTH_DB,
  HEALTH_QUEUES,
  HEALTH_REDIS,
  HEALTH_TEMPORAL,
} from "./tokens.js";

/** Alert if Postgres p50 exceeds this on a single check. */
export const NEON_LATENCY_ALERT_MS = 500;

export interface DependencyStatus {
  status: "ok" | "fail";
  latency_ms?: number;
  error?: string;
}

export interface DetailedHealthReport {
  status: "ok" | "degraded" | "down";
  db: DependencyStatus;
  redis: DependencyStatus;
  temporal: DependencyStatus;
  queue_depths: Record<string, number>;
  timestamp: string;
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(HEALTH_DB) private readonly db: Db,
    @Inject(HEALTH_REDIS) private readonly redis: Redis,
    @Inject(HEALTH_TEMPORAL) private readonly temporal: TemporalClient | null,
    @Inject(HEALTH_QUEUES) private readonly queues: QueueHandles | null,
  ) {}

  async detailed(): Promise<DetailedHealthReport> {
    const [dbStatus, redisStatus, temporalStatus, queueDepths] = await Promise.all([
      this.pingDb(),
      this.pingRedis(),
      this.pingTemporal(),
      this.readQueueDepths(),
    ]);

    const failures = [dbStatus, redisStatus, temporalStatus].filter(
      (s) => s.status === "fail",
    ).length;
    const dbSlow =
      dbStatus.status === "ok" &&
      typeof dbStatus.latency_ms === "number" &&
      dbStatus.latency_ms > NEON_LATENCY_ALERT_MS;

    const overall: DetailedHealthReport["status"] =
      failures === 0 && !dbSlow
        ? "ok"
        : failures >= 2
          ? "down"
          : "degraded";

    return {
      status: overall,
      db: dbStatus,
      redis: redisStatus,
      temporal: temporalStatus,
      queue_depths: queueDepths,
      timestamp: new Date().toISOString(),
    };
  }

  private async pingDb(): Promise<DependencyStatus> {
    const start = Date.now();
    try {
      await pingDb(this.db);
      return { status: "ok", latency_ms: Date.now() - start };
    } catch (err) {
      return {
        status: "fail",
        latency_ms: Date.now() - start,
        error: (err as Error).message.slice(0, 160),
      };
    }
  }

  private async pingRedis(): Promise<DependencyStatus> {
    const start = Date.now();
    try {
      const res = await this.redis.ping();
      if (res !== "PONG") throw new Error(`unexpected PING response: ${res}`);
      return { status: "ok", latency_ms: Date.now() - start };
    } catch (err) {
      return {
        status: "fail",
        latency_ms: Date.now() - start,
        error: (err as Error).message.slice(0, 160),
      };
    }
  }

  private async pingTemporal(): Promise<DependencyStatus> {
    if (!this.temporal) {
      return { status: "fail", error: "temporal client not configured" };
    }
    const start = Date.now();
    try {
      // `getSystemInfo` is the lightest RPC Temporal exposes. Any
      // transport-level failure surfaces here before we hit a workflow.
      await this.temporal.workflowService.getSystemInfo({});
      return { status: "ok", latency_ms: Date.now() - start };
    } catch (err) {
      return {
        status: "fail",
        latency_ms: Date.now() - start,
        error: (err as Error).message.slice(0, 160),
      };
    }
  }

  private async readQueueDepths(): Promise<Record<string, number>> {
    if (!this.queues) return {};
    try {
      return (await getQueueDepths(this.queues)) as Record<string, number>;
    } catch {
      return {};
    }
  }
}
