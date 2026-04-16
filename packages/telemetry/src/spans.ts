import { SpanStatusCode, trace, type Span, type Tracer } from "@opentelemetry/api";

const tracer: Tracer = trace.getTracer("vex", "0.0.0");

/**
 * Run an async function inside an OTel span. Records exceptions and sets
 * the span status before rethrowing so callers see the original error.
 *
 * Span name convention: `<surface>.<step>` (e.g. `api.query.hybrid_search`).
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Get the current trace context as `{ trace_id, span_id }` for inclusion in
 * structured log lines. Returns empty strings when there is no active span.
 */
export function currentTraceContext(): { trace_id: string; span_id: string } {
  const span = trace.getActiveSpan();
  if (!span) return { trace_id: "", span_id: "" };
  const ctx = span.spanContext();
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

/**
 * Render the active span context as a W3C `traceparent` header. Used to
 * propagate trace context across BullMQ jobs by stuffing it into the
 * job payload.
 *
 * Returns `null` when no span is active so callers can skip the field.
 */
export function currentTraceparent(): string | null {
  const span = trace.getActiveSpan();
  if (!span) return null;
  const ctx = span.spanContext();
  if (!ctx.traceId || !ctx.spanId) return null;
  return `00-${ctx.traceId}-${ctx.spanId}-0${ctx.traceFlags.toString(16)}`;
}
