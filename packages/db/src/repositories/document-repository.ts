import { and, desc, eq } from "drizzle-orm";
import { createId } from "@vex/domain";
import type { Tx } from "../client.js";
import { documents, type Document } from "../schema/documents.js";

export interface DocumentInsert {
  subjectType: string;
  subjectId: string;
  title: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  documentType: string;
  storageKey: string;
  extractedText: string | null;
  uploadedBy: string | null;
  orgId?: string | null;
}

export class DocumentRepository {
  async insert(
    tx: Tx,
    tenantId: string,
    data: DocumentInsert,
  ): Promise<Document> {
    const [row] = await tx
      .insert(documents)
      .values({
        id: createId(),
        tenantId,
        orgId:
          data.orgId ??
          (data.subjectType === "organization" ? data.subjectId : null),
        subjectType: data.subjectType,
        subjectId: data.subjectId,
        title: data.title,
        filename: data.filename,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        documentType: data.documentType,
        storageKey: data.storageKey,
        extractedText: data.extractedText,
        uploadedBy: data.uploadedBy,
      })
      .returning();
    if (!row) throw new Error("document insert returned no row");
    return row;
  }

  async findById(tx: Tx, id: string): Promise<Document | null> {
    const rows = await tx
      .select()
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async listBySubject(
    tx: Tx,
    subjectType: string,
    subjectId: string,
    limit = 100,
  ): Promise<Document[]> {
    return tx
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.subjectType, subjectType),
          eq(documents.subjectId, subjectId),
        ),
      )
      .orderBy(desc(documents.createdAt))
      .limit(limit);
  }

  async deleteById(tx: Tx, id: string): Promise<Document | null> {
    const [row] = await tx
      .delete(documents)
      .where(eq(documents.id, id))
      .returning();
    return row ?? null;
  }
}
