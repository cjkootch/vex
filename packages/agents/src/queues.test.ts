import { describe, expect, it } from "vitest";
import {
  QueueBackpressureThreshold,
  QueueName,
  QueueRateLimits,
  backpressureEngaged,
} from "./queues.js";

describe("queue backpressure", () => {
  it("returns no queues when all depths are under threshold", () => {
    const depths: Record<string, number> = {
      [QueueName.Normalization]: 100,
      [QueueName.Dlq]: 0,
      [QueueName.Agents]: 5,
      [QueueName.ApprovalExecutor]: 0,
      [QueueName.Transcript]: 0,
    };
    expect(
      backpressureEngaged(depths as Record<QueueName, number>),
    ).toEqual([]);
  });

  it("flags queues at or over their threshold", () => {
    const depths: Record<string, number> = {
      [QueueName.Normalization]: QueueBackpressureThreshold[QueueName.Normalization],
      [QueueName.Dlq]: 0,
      [QueueName.Agents]: QueueBackpressureThreshold[QueueName.Agents] + 1,
      [QueueName.ApprovalExecutor]: 0,
      [QueueName.Transcript]: 0,
    };
    const engaged = backpressureEngaged(depths as Record<QueueName, number>);
    expect(engaged).toContain(QueueName.Normalization);
    expect(engaged).toContain(QueueName.Agents);
    expect(engaged).not.toContain(QueueName.Dlq);
  });
});

describe("QueueRateLimits", () => {
  it("shields Neon by rate-limiting the normalization queue at 50/s", () => {
    expect(QueueRateLimits[QueueName.Normalization]).toEqual({
      max: 50,
      duration: 1_000,
    });
  });

  it("caps Claude burst on the agents queue at 10/s", () => {
    expect(QueueRateLimits[QueueName.Agents]).toEqual({
      max: 10,
      duration: 1_000,
    });
  });

  it("does not rate-limit the DLQ or approval-executor queues", () => {
    expect(QueueRateLimits[QueueName.Dlq]).toBeUndefined();
    expect(QueueRateLimits[QueueName.ApprovalExecutor]).toBeUndefined();
  });
});
