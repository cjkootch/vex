import { and, desc, eq, or, sql } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import {
  organizationRelationships,
  type OrganizationRelationship,
} from "../schema/organization-relationships.js";

export interface OrganizationRelationshipInsert {
  fromOrgId: string;
  toOrgId: string;
  relationshipType: string;
  product?: string | null;
  notes?: string | null;
  addedBy?: string | null;
}

export class OrganizationRelationshipRepository {
  async upsert(
    tx: Tx,
    tenantId: string,
    data: OrganizationRelationshipInsert,
  ): Promise<OrganizationRelationship> {
    const existing = await tx
      .select()
      .from(organizationRelationships)
      .where(
        and(
          eq(organizationRelationships.fromOrgId, data.fromOrgId),
          eq(organizationRelationships.toOrgId, data.toOrgId),
          eq(organizationRelationships.relationshipType, data.relationshipType),
          sql`coalesce(${organizationRelationships.product}, '') = ${data.product ?? ""}`,
        ),
      )
      .limit(1);
    if (existing[0]) return existing[0];
    const [row] = await tx
      .insert(organizationRelationships)
      .values({
        id: createId(),
        tenantId,
        fromOrgId: data.fromOrgId,
        toOrgId: data.toOrgId,
        relationshipType: data.relationshipType,
        product: data.product ?? null,
        notes: data.notes ?? null,
        addedBy: data.addedBy ?? null,
      })
      .returning();
    if (!row) throw new Error("organization_relationships insert returned no row");
    return row;
  }

  /**
   * Both directions — the org appears as either "from" (e.g. a
   * broker brokering for someone) or "to" (e.g. a supplier being
   * brokered by someone). Caller differentiates by comparing the
   * `fromOrgId` / `toOrgId` to the org they're rendering.
   */
  async listForOrg(
    tx: Tx,
    orgId: string,
  ): Promise<OrganizationRelationship[]> {
    return tx
      .select()
      .from(organizationRelationships)
      .where(
        or(
          eq(organizationRelationships.fromOrgId, orgId),
          eq(organizationRelationships.toOrgId, orgId),
        ),
      )
      .orderBy(desc(organizationRelationships.addedAt));
  }

  async deleteById(
    tx: Tx,
    id: string,
  ): Promise<OrganizationRelationship | null> {
    const [row] = await tx
      .delete(organizationRelationships)
      .where(eq(organizationRelationships.id, id))
      .returning();
    return row ?? null;
  }
}
