import { and, desc, eq } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import {
  organizationProducts,
  type OrganizationProduct,
} from "../schema/organization-products.js";

export interface OrganizationProductInsert {
  orgId: string;
  product: string;
  notes?: string | null;
  addedBy?: string | null;
}

export class OrganizationProductRepository {
  async upsert(
    tx: Tx,
    tenantId: string,
    data: OrganizationProductInsert,
  ): Promise<OrganizationProduct> {
    const existing = await tx
      .select()
      .from(organizationProducts)
      .where(
        and(
          eq(organizationProducts.orgId, data.orgId),
          eq(organizationProducts.product, data.product),
        ),
      )
      .limit(1);
    if (existing[0]) return existing[0];
    const [row] = await tx
      .insert(organizationProducts)
      .values({
        id: createId(),
        tenantId,
        orgId: data.orgId,
        product: data.product,
        notes: data.notes ?? null,
        addedBy: data.addedBy ?? null,
      })
      .returning();
    if (!row) throw new Error("organization_products insert returned no row");
    return row;
  }

  async listForOrg(
    tx: Tx,
    orgId: string,
  ): Promise<OrganizationProduct[]> {
    return tx
      .select()
      .from(organizationProducts)
      .where(eq(organizationProducts.orgId, orgId))
      .orderBy(desc(organizationProducts.addedAt));
  }

  async listForProduct(
    tx: Tx,
    product: string,
    limit = 50,
  ): Promise<OrganizationProduct[]> {
    return tx
      .select()
      .from(organizationProducts)
      .where(eq(organizationProducts.product, product))
      .orderBy(desc(organizationProducts.addedAt))
      .limit(limit);
  }

  async deleteById(
    tx: Tx,
    id: string,
  ): Promise<OrganizationProduct | null> {
    const [row] = await tx
      .delete(organizationProducts)
      .where(eq(organizationProducts.id, id))
      .returning();
    return row ?? null;
  }
}
