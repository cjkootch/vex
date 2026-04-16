import { trace } from "@opentelemetry/api";

/** Shared tracer for Vex services. */
export const tracer = trace.getTracer("vex", "0.0.0");
