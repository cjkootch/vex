import { describe, expect, it, vi } from "vitest";
import type { Queue } from "bullmq";
import type { NormalizationJobData } from "@vex/agents";
import { replayOneJob } from "./replay.js";

type FakeJobState =
  | "failed"
  | "completed"
  | "active"
  | "waiting"
  | "delayed"
  | "waiting-children"
  | "prioritized";

interface FakeJob {
  id: string;
  getState: () => Promise<FakeJobState>;
  retry: () => Promise<void>;
  remove: () => Promise<void>;
}

function buildFakeQueue(existing: FakeJob | null) {
  const calls = {
    add: vi.fn(async () => ({ id: "job-new" }) as never),
    getJob: vi.fn(async (_id: string) => existing),
  };
  return {
    queue: {
      add: calls.add,
      getJob: calls.getJob,
    } as unknown as Queue<NormalizationJobData>,
    calls,
  };
}

function buildFakeJob(id: string, state: FakeJobState): FakeJob {
  return {
    id,
    getState: vi.fn(async () => state),
    retry: vi.fn<[], Promise<void>>(async () => {
      return;
    }),
    remove: vi.fn<[], Promise<void>>(async () => {
      return;
    }),
  };
}

describe("replayOneJob", () => {
  const data = {
    raw_event_id: "01KPMC46ACNR2TH154DFWJ21KK",
    tenant_id: "01HSEEDWRK0000000000000001",
  };

  it("adds a fresh job when no prior job exists", async () => {
    const { queue, calls } = buildFakeQueue(null);
    const result = await replayOneJob(queue, data);
    expect(result).toEqual({
      raw_event_id: data.raw_event_id,
      action: "added",
    });
    expect(calls.add).toHaveBeenCalledTimes(1);
  });

  it("retries when the existing job is in failed state", async () => {
    const job = buildFakeJob(data.raw_event_id, "failed");
    const { queue, calls } = buildFakeQueue(job);
    const result = await replayOneJob(queue, data);
    expect(result).toEqual({
      raw_event_id: data.raw_event_id,
      action: "retried",
      prior_state: "failed",
    });
    expect(job.retry).toHaveBeenCalledTimes(1);
    expect(job.remove).not.toHaveBeenCalled();
    expect(calls.add).not.toHaveBeenCalled();
  });

  it("removes and re-adds when the existing job is completed", async () => {
    const job = buildFakeJob(data.raw_event_id, "completed");
    const { queue, calls } = buildFakeQueue(job);
    const result = await replayOneJob(queue, data);
    expect(result).toEqual({
      raw_event_id: data.raw_event_id,
      action: "replaced",
      prior_state: "completed",
    });
    expect(job.remove).toHaveBeenCalledTimes(1);
    expect(calls.add).toHaveBeenCalledTimes(1);
    expect(job.retry).not.toHaveBeenCalled();
  });

  it.each<FakeJobState>([
    "active",
    "waiting",
    "delayed",
    "waiting-children",
    "prioritized",
  ])("skips when the existing job is in %s state", async (state) => {
    const job = buildFakeJob(data.raw_event_id, state);
    const { queue, calls } = buildFakeQueue(job);
    const result = await replayOneJob(queue, data);
    expect(result).toEqual({
      raw_event_id: data.raw_event_id,
      action: "skipped",
      prior_state: state,
    });
    expect(job.retry).not.toHaveBeenCalled();
    expect(job.remove).not.toHaveBeenCalled();
    expect(calls.add).not.toHaveBeenCalled();
  });
});
