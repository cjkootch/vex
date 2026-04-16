import type { IntegrationProvider } from "./enums.js";

/**
 * Stable identifier for a record in an external system.
 *
 * Per invariant "No raw provider payloads in domain types", integration
 * adapters must reduce external records to an `ExternalKey` + a typed
 * domain projection before the data crosses into `@vex/domain`.
 */
export interface ExternalKey {
  readonly provider: IntegrationProvider;
  /** Tenant-scoped provider instance (e.g., which Salesforce org). */
  readonly tenantAccountId: string;
  /** The remote record id. */
  readonly remoteId: string;
  /** Remote object kind, e.g. "contact", "message". */
  readonly kind: string;
}

export function externalKey(
  provider: IntegrationProvider,
  tenantAccountId: string,
  kind: string,
  remoteId: string,
): ExternalKey {
  return { provider, tenantAccountId, kind, remoteId };
}

export function externalKeyToString(k: ExternalKey): string {
  return `${k.provider}:${k.tenantAccountId}:${k.kind}:${k.remoteId}`;
}

export function parseExternalKey(raw: string): ExternalKey {
  const parts = raw.split(":");
  if (parts.length !== 4) {
    throw new TypeError(`Invalid ExternalKey: ${JSON.stringify(raw)}`);
  }
  const [provider, tenantAccountId, kind, remoteId] = parts as [string, string, string, string];
  return {
    provider: provider as IntegrationProvider,
    tenantAccountId,
    kind,
    remoteId,
  };
}
