# ADR-006: OpenFGA adoption criteria

- **Status:** Proposed (deferred — stub shipped in Sprint 13)
- **Date:** 2026-10-01
- **Sprint:** 13
- **Affected packages:** `@vex/integrations`, `@vex/api`, `@vex/db`
- **Supersedes / superseded by:** —

## Context

Vex's authorisation today is two things stacked:

1. **Role-based JWT gates at the HTTP boundary.**
   `JwtAuthGuard` + `RolesGuard` + `@RequireRole(...)` on every mutating
   endpoint. Roles are `owner | admin | member | viewer`.
2. **Postgres row-level security keyed by `app.tenant_id`.**
   `withTenant(db, tenantId, fn)` wraps every DB interaction; every
   business table has `USING (tenant_id = current_setting('app.tenant_id', true))`
   + `ENABLE ROW LEVEL SECURITY`. A nightly CI job (Sprint 13, see
   `scripts/audit-rls.ts`) verifies every table is still enforced.

That covers tenant isolation and coarse role authorisation. It does
**not** cover:

- Object-level sharing *across* tenants — "External auditor X needs
  read access to deal VTC-2026-001 but nothing else in our workspace."
- User-specific permissions *within* a tenant that diverge from role —
  "SDR Sarah can edit her own leads but only read other reps'."
- Attribute / relationship based access control (ABAC / ReBAC) —
  "Any user who is a `member` of the deal team can read the deal."

OpenFGA (née Auth0 FGA) is the canonical ReBAC implementation and
fits that gap cleanly: you declare an authorisation model (types,
relations) and issue `check` calls at the policy-enforcement layer.

## Decision

**Ship a typed interface + always-allow stub now. Defer the real
binding until a product requirement forces object-level sharing.**

Concretely:

- `packages/integrations/src/openfga.ts` exposes `OpenFGAClient`,
  `OpenFGATuple`, `StubOpenFGAClient`, `createOpenFGAClient`.
- The stub `check` returns `true`. Correct **only** under the tenant +
  role invariants we already enforce, which remain the authoritative
  gates until adoption.
- `createOpenFGAClient({ sharingEnabled: true })` deliberately throws
  today — flipping the flag before the real binding ships is a bug,
  not a feature.
- A workspace-settings flag `sharing_enabled` (boolean, default
  `false`) drives the decision per workspace when the real binding
  lands.

## Criteria for enabling the real binding

Any **one** of the following makes the stub insufficient:

1. **Cross-tenant sharing requirement** — a real customer use case
   (e.g. external auditor, broker, counterparty) asks to see a single
   object inside the workspace without broader tenant access.
2. **Within-tenant diverging permissions** — a role's blanket
   permissions produce over- or under-access for a concrete workflow
   and operators need per-object overrides.
3. **Audit / compliance mandate** — a regulatory requirement demands
   per-object access logs (who can see what, when checked).
4. **Third-party integration requirement** — a connected tool (e.g.
   Slack, a data room) requires a sharable ACL surface Vex needs to
   expose.

## Implementation plan when adoption triggers

1. **Model.** Author `docs/authorisation/model.fga` — types, relations,
   and conditions. Draft `deal`, `organization`, `contact` first.
2. **Deployment.** Pick one of: self-hosted OpenFGA (cheaper,
   operational burden), auth0-fga hosted (paid, fewer operations).
   Default to self-hosted + Fly.io because Vex already runs there.
3. **Wire the real client.** Replace `createOpenFGAClient` body with
   `@openfga/sdk` `OpenFgaClient`. The interface does not change.
4. **Write tuples at the right edges.** Every create-side-effect
   activity that produces a shareable object (deal approved, contact
   added to a team) issues a `write` of the default tuples. Read-side
   controllers add a `check` before returning the row.
5. **Migrate existing rows.** One-off backfill writes tuples for every
   existing row based on the current tenant + role model. Audit the
   backfill via a diff tool before flipping `sharing_enabled`.
6. **Flip `sharing_enabled` per workspace.** Staged rollout via the
   Sprint-13 feature-flag helper: `isFeatureEnabled('sharing_v1',
   tenantId, rolloutPct)` on a workspace-settings field.
7. **Update ADR-006** with the outcome, decision owner, and rollback
   plan.

## Consequences

- **Positive.** Code that eventually needs `check` compiles today;
  the interface won't churn when the real binding lands.
- **Negative.** A permanently stubbed `check` silently returns `true`
  — any future caller that *relies* on the check inside the stubbed
  window is wrong. The stub's doc comment explicitly flags this.
- **Risk.** If someone starts writing tuples through the stub `write`
  they're a no-op; those writes disappear. Mitigation: the stub
  throws when `sharingEnabled: true` is passed, and the flag is the
  only way to ship real writes.

## References

- OpenFGA: https://openfga.dev
- Zanzibar paper (Google): https://research.google/pubs/pub48190/
- Vex RLS invariant: `withTenant` + `ENABLE ROW LEVEL SECURITY` (Sprint 3)
- Vex role guard: `RolesGuard` (Sprint 3)
- Nightly RLS audit: `scripts/audit-rls.ts` (Sprint 13)
