import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let logSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let errSpy: any;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("emits structured JSON with service + level + msg + ts", () => {
    const log = createLogger("vex-api");
    log.info("hello", { tenant_id: "t-1" });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(line.service).toBe("vex-api");
    expect(line.level).toBe("info");
    expect(line.msg).toBe("hello");
    expect(line.tenant_id).toBe("t-1");
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("child loggers inherit base fields", () => {
    const root = createLogger("vex-worker", { agent_name: "follow_up" });
    const child = root.child({ agent_run_id: "run-1" });
    child.warn("stalled");
    const line = JSON.parse(errSpy.mock.calls[0]![0] as string);
    expect(line.service).toBe("vex-worker");
    expect(line.agent_name).toBe("follow_up");
    expect(line.agent_run_id).toBe("run-1");
  });

  it("routes warn/error to stderr and info/debug to stdout", () => {
    const log = createLogger("svc");
    log.info("a");
    log.warn("b");
    log.error("c");
    log.debug("d");
    expect(logSpy).toHaveBeenCalledTimes(2); // info + debug
    expect(errSpy).toHaveBeenCalledTimes(2); // warn + error
  });
});
