import type { TenantId, AgentRunId } from "@vex/domain";

export type CostOperation =
  | "llm.completion"
  | "llm.embedding"
  | "llm.voice"
  | "tts"
  | "stt"
  | "pstn.minute"
  | "email.send"
  | "sms.send";

export interface CostEntry {
  /** Stable idempotency key — two records with the same key are the same event. */
  readonly idempotencyKey: string;
  readonly tenantId: TenantId;
  readonly agentRunId?: AgentRunId;
  readonly operation: CostOperation;
  /** e.g. "anthropic", "openai", "twilio". */
  readonly provider: string;
  /** e.g. "claude-sonnet-4-20250514", "text-embedding-3-small". */
  readonly model?: string;
  /** Units billed (tokens, seconds, messages). */
  readonly units: number;
  /** Unit type, e.g. "input_tokens", "output_tokens", "seconds". */
  readonly unitKind: string;
  /** Cost in USD micros (1 USD = 1_000_000). Integer to avoid float drift. */
  readonly costUsdMicros: number;
  readonly occurredAt: Date;
}

/**
 * Append-only ledger of every chargeable operation.
 *
 * Per invariant "All LLM calls record to CostLedger" — adapters in
 * @vex/integrations MUST call `record()` on every completion, embedding, voice
 * turn, and provider-metered action.
 */
export interface CostLedger {
  record(entry: CostEntry): Promise<void>;
}

/**
 * Test / fallback implementation that keeps entries in memory. Production apps
 * should use the Postgres-backed ledger from @vex/db.
 */
export class InMemoryCostLedger implements CostLedger {
  private readonly entries = new Map<string, CostEntry>();

  async record(entry: CostEntry): Promise<void> {
    if (!this.entries.has(entry.idempotencyKey)) {
      this.entries.set(entry.idempotencyKey, entry);
    }
  }

  snapshot(): readonly CostEntry[] {
    return [...this.entries.values()];
  }

  totalMicros(): number {
    let total = 0;
    for (const e of this.entries.values()) total += e.costUsdMicros;
    return total;
  }
}
