import { currentTraceContext } from "./spans.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  /** Always populated when an HTTP request or agent run is in scope. */
  tenant_id?: string;
  agent_run_id?: string;
  workflow_id?: string;
  approval_id?: string;
  /** Free-form additional fields. */
  [key: string]: unknown;
}

/**
 * Structured logger. Every emitted line is a single JSON object so a log
 * pipeline (Loki, Datadog, etc.) can parse without a regex. Trace context
 * is filled in automatically from the active span — no manual plumbing.
 */
export interface Logger {
  child(extra: LogFields): Logger;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

class JsonLogger implements Logger {
  constructor(private readonly base: LogFields = {}) {}

  child(extra: LogFields): Logger {
    return new JsonLogger({ ...this.base, ...extra });
  }

  debug(msg: string, fields: LogFields = {}): void {
    this.emit("debug", msg, fields);
  }
  info(msg: string, fields: LogFields = {}): void {
    this.emit("info", msg, fields);
  }
  warn(msg: string, fields: LogFields = {}): void {
    this.emit("warn", msg, fields);
  }
  error(msg: string, fields: LogFields = {}): void {
    this.emit("error", msg, fields);
  }

  private emit(level: LogLevel, msg: string, fields: LogFields): void {
    const trace = currentTraceContext();
    const line = {
      level,
      msg,
      ts: new Date().toISOString(),
      ...this.base,
      ...fields,
      ...(trace.trace_id ? { trace_id: trace.trace_id, span_id: trace.span_id } : {}),
    };
    const out = JSON.stringify(line);
    // Route warn/error to stderr so log shippers can split streams cheaply.
    if (level === "error" || level === "warn") {
      // eslint-disable-next-line no-console
      console.error(out);
    } else {
      // eslint-disable-next-line no-console
      console.log(out);
    }
  }
}

/**
 * Build a root logger. Pass `service` so every line carries the originating
 * service for free.
 */
export function createLogger(service: string, base: LogFields = {}): Logger {
  return new JsonLogger({ service, ...base });
}
