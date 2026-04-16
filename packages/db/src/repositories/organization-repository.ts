import { and, eq } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Db } from "../client.js";
import { organizations, type Organization } from "../schema/organizations.js";
import type { FieldConfidenceEntry } from "../merge.js";

/**
 * Structured data for upsertByExternalKey. Fields map directly to
 * `organizations` columns; missing fields are left alone on update.
 */
export interface OrganizationUpsertData {
  legalName: string;
  domain?: string | null;
  industry?: string | null;
  sourceOfTruth?: string | null;
}

export class OrganizationRepository {
  constructor(private readonly db: Db) {}

  async findById(tenantId: string, id: string): Promise<Organization | null> {
    const [row] = await this.db
      .select()
      .from(organizations)
      .where(and(eq(organizations.tenantId, tenantId), eq(organizations.id, id)))
      .limit(1);
    return row ?? null;
  }

  async findByExternalKey(
    tenantId: string,
    system: string,
    key: string,
  ): Promise<Organization | null> {
    const rows = await this.db
      .select()
      .from(organizations)
      .where(eq(organizations.tenantId, tenantId));
    return rows.find((row) => row.externalKeys[system] === key) ?? null;
  }

  async upsertByExternalKey(
    tenantId: string,
    system: string,
    key: string,
    data: OrganizationUpsertData,
  ): Promise<Organization> {
    const existing = await this.findByExternalKey(tenantId, system, key);
    if (existing) {
      const [updated] = await this.db
        .update(organizations)
        .set({
          legalName: data.legalName,
          domain: data.domain ?? existing.domain,
          industry: data.industry ?? existing.industry,
          sourceOfTruth: data.sourceOfTruth ?? existing.sourceOfTruth,
          updatedAt: new Date(),
        })
        .where(
          and(eq(organizations.tenantId, tenantId), eq(organizations.id, existing.id)),
        )
        .returning();
      if (!updated) throw new Error(`organization ${existing.id} vanished during update`);
      return updated;
    }

    const [inserted] = await this.db
      .insert(organizations)
      .values({
        id: createId(),
        tenantId,
        legalName: data.legalName,
        domain: data.domain ?? null,
        industry: data.industry ?? null,
        sourceOfTruth: data.sourceOfTruth ?? null,
        externalKeys: { [system]: key },
        fieldConfidence: {},
      })
      .returning();
    if (!inserted) throw new Error("organization insert returned no row");
    return inserted;
  }

  async updateFieldConfidence(
    tenantId: string,
    id: string,
    fieldName: string,
    value: unknown,
    source: string,
    confidence: number,
  ): Promise<void> {
    const existing = await this.findById(tenantId, id);
    if (!existing) throw new Error(`organization ${id} not found`);
    const entry: FieldConfidenceEntry = {
      value,
      source,
      confidence,
      updated_at: new Date().toISOString(),
    };
    await this.db
      .update(organizations)
      .set({
        fieldConfidence: { ...existing.fieldConfidence, [fieldName]: entry },
        updatedAt: new Date(),
      })
      .where(and(eq(organizations.tenantId, tenantId), eq(organizations.id, id)));
  }
}
