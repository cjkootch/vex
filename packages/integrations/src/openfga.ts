/**
 * OpenFGA scaffold — disabled by default.
 *
 * Vex's current authorisation model is (a) JWT role gates at the
 * controller layer (RolesGuard) plus (b) tenant-scoped Postgres RLS.
 * That covers every access pattern shipped through Sprint 12 —
 * tenants are isolated, per-role permissions are enforced at the API
 * boundary, and everything else is derived state.
 *
 * OpenFGA enters the picture when Vex needs object-level sharing
 * *across* tenants or user-specific permissions within a tenant (e.g.
 * "share deal VTC-2026-001 with external auditor user X"). This file
 * provides a tiny interface + no-op stub so code that eventually
 * reaches for a check() call compiles today and swaps to a real
 * OpenFGA binding later without a type churn.
 *
 * Enablement criteria + the rollout plan live in docs/adr/006.
 */

/** Canonical (user, relation, object) tuple used by every OpenFGA call. */
export interface OpenFGATuple {
  /** `user:alice` or `workspace:acme` — the subject performing the action. */
  user: string;
  /** `reader`, `writer`, `owner`, etc. — defined by the authorisation model. */
  relation: string;
  /** `deal:VTC-2026-001`, `folder:financials`. The object receiving the access check. */
  object: string;
}

/** Filter shape for OpenFGA read queries — every field is optional. */
export type OpenFGATupleFilter = Partial<OpenFGATuple>;

/**
 * Minimal OpenFGA client surface. The real binding (when enabled)
 * wraps `@openfga/sdk` and forwards to a live OpenFGA / auth0-fga
 * server; the stub below always reports access as allowed.
 */
export interface OpenFGAClient {
  /** Resolve a single permission check. */
  check(user: string, relation: string, object: string): Promise<boolean>;
  /** Append one or more permission tuples. Idempotent on the server side. */
  write(tuples: OpenFGATuple[]): Promise<void>;
  /** Read tuples matching a filter; empty filter lists everything. */
  read(filter: OpenFGATupleFilter): Promise<OpenFGATuple[]>;
}

/**
 * Always-allow stub. Correct only in contexts where the invoker has
 * already cleared the tenant + role gates — which is every Vex code
 * path today. When sharing_enabled is flipped on, swap this for a
 * real client in `createOpenFGAClient`.
 */
export class StubOpenFGAClient implements OpenFGAClient {
  async check(
    _user: string,
    _relation: string,
    _object: string,
  ): Promise<boolean> {
    return true;
  }

  async write(_tuples: OpenFGATuple[]): Promise<void> {
    // intentional no-op
  }

  async read(_filter: OpenFGATupleFilter): Promise<OpenFGATuple[]> {
    return [];
  }
}

export interface OpenFGAConfig {
  /** When false (the default) the returned client is the stub. */
  sharingEnabled?: boolean;
  /**
   * Reserved for future wiring — the real OpenFGA server URL.
   * Unused by the stub.
   */
  apiUrl?: string;
  /** Reserved — OpenFGA store id for the tenant. Unused by the stub. */
  storeId?: string;
}

/**
 * Factory. Returns the stub unless sharing is explicitly enabled. The
 * real branch is intentionally left unimplemented — adopting OpenFGA
 * is the decision captured in ADR-006 and that decision includes
 * picking the deployment (self-hosted vs. hosted auth0-fga).
 */
export function createOpenFGAClient(config: OpenFGAConfig = {}): OpenFGAClient {
  if (config.sharingEnabled) {
    throw new Error(
      "OpenFGA sharing is enabled but the real client binding is not yet implemented. See docs/adr/006-openfga-adoption.md before flipping this flag.",
    );
  }
  return new StubOpenFGAClient();
}
