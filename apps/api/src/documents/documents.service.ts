import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  withTenant,
  type Db,
  type DocumentRepository,
} from "@vex/db";
import type { S3Uploader } from "@vex/integrations";
import { DOCUMENTS_DB_CLIENT, DOCUMENTS_REPO, DOCUMENTS_S3 } from "./tokens.js";

const ALLOWED_SUBJECT_TYPES = new Set([
  "organization",
  "contact",
  "fuel_deal",
]);
const ALLOWED_DOCUMENT_TYPES = new Set([
  "bl",
  "invoice",
  "contract",
  "bis_license",
  "ofac_screening",
  "financials",
  "packing_list",
  "insurance_cert",
  "customs_entry",
  "sddr",
  "other",
]);
const MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
const EXTRACTED_TEXT_CAP = 50_000;

export interface UploadArgs {
  tenantId: string;
  uploadedBy: string;
  subjectType: string;
  subjectId: string;
  filename: string;
  mimeType: string;
  documentType: string;
  title?: string;
  body: Buffer;
}

@Injectable()
export class DocumentsService {
  private readonly log = new Logger(DocumentsService.name);

  constructor(
    @Inject(DOCUMENTS_DB_CLIENT) private readonly db: Db,
    @Inject(DOCUMENTS_REPO) private readonly documents: DocumentRepository,
    @Inject(DOCUMENTS_S3) private readonly s3: S3Uploader,
  ) {}

  async upload(args: UploadArgs): Promise<{
    id: string;
    title: string;
    filename: string;
    documentType: string;
    sizeBytes: number;
    extracted: boolean;
  }> {
    if (!ALLOWED_SUBJECT_TYPES.has(args.subjectType)) {
      throw new BadRequestException(
        `subject_type must be one of ${[...ALLOWED_SUBJECT_TYPES].join(", ")}`,
      );
    }
    if (!ALLOWED_DOCUMENT_TYPES.has(args.documentType)) {
      throw new BadRequestException(
        `document_type must be one of ${[...ALLOWED_DOCUMENT_TYPES].join(", ")}`,
      );
    }
    if (args.body.length === 0) {
      throw new BadRequestException("empty body");
    }
    if (args.body.length > MAX_SIZE_BYTES) {
      throw new BadRequestException(
        `file exceeds ${MAX_SIZE_BYTES} bytes (was ${args.body.length})`,
      );
    }
    if (!args.filename) throw new BadRequestException("filename required");

    const storageKey = `documents/${args.tenantId}/${Date.now()}-${safeFilename(args.filename)}`;
    await this.s3.putBuffer(storageKey, args.body, args.mimeType);

    const extractedText = await extractTextIfPossible(
      args.body,
      args.mimeType,
    ).catch((err) => {
      this.log.warn(
        `text extraction failed for ${args.filename}: ${(err as Error).message}`,
      );
      return null;
    });

    const row = await withTenant(this.db, args.tenantId, async (tx) =>
      this.documents.insert(tx, args.tenantId, {
        subjectType: args.subjectType,
        subjectId: args.subjectId,
        title: args.title ?? args.filename,
        filename: args.filename,
        mimeType: args.mimeType,
        sizeBytes: args.body.length,
        documentType: args.documentType,
        storageKey,
        extractedText: extractedText
          ? extractedText.slice(0, EXTRACTED_TEXT_CAP)
          : null,
        uploadedBy: args.uploadedBy,
      }),
    );
    return {
      id: row.id,
      title: row.title,
      filename: row.filename,
      documentType: row.documentType,
      sizeBytes: row.sizeBytes,
      extracted: extractedText !== null,
    };
  }

  async listBySubject(
    tenantId: string,
    subjectType: string,
    subjectId: string,
  ): Promise<
    Array<{
      id: string;
      title: string;
      filename: string;
      mimeType: string;
      documentType: string;
      sizeBytes: number;
      hasExtractedText: boolean;
      extractedPreview: string | null;
      uploadedBy: string | null;
      createdAt: string;
    }>
  > {
    const rows = await withTenant(this.db, tenantId, async (tx) =>
      this.documents.listBySubject(tx, subjectType, subjectId, 100),
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      filename: r.filename,
      mimeType: r.mimeType,
      documentType: r.documentType,
      sizeBytes: r.sizeBytes,
      hasExtractedText: r.extractedText !== null && r.extractedText.length > 0,
      extractedPreview: r.extractedText ? r.extractedText.slice(0, 400) : null,
      uploadedBy: r.uploadedBy,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async download(
    tenantId: string,
    id: string,
  ): Promise<{ body: Buffer; mimeType: string; filename: string }> {
    const row = await withTenant(this.db, tenantId, async (tx) =>
      this.documents.findById(tx, id),
    );
    if (!row) throw new NotFoundException();
    const obj = await this.s3.getBuffer(row.storageKey);
    return {
      body: obj.body,
      mimeType: obj.contentType ?? row.mimeType,
      filename: row.filename || row.title,
    };
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const row = await withTenant(this.db, tenantId, async (tx) =>
      this.documents.findById(tx, id),
    );
    if (!row) throw new NotFoundException();
    await withTenant(this.db, tenantId, async (tx) =>
      this.documents.deleteById(tx, id),
    );
    // Best-effort S3 cleanup: leave the object if it fails to delete —
    // the row is already gone so it won't surface to the UI.
  }
}

function safeFilename(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

async function extractTextIfPossible(
  body: Buffer,
  mimeType: string,
): Promise<string | null> {
  if (mimeType === "application/pdf") {
    const mod = (await import("pdf-parse")) as unknown as {
      default: (buf: Buffer) => Promise<{ text: string }>;
    };
    const result = await mod.default(body);
    return result.text ?? null;
  }
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml"
  ) {
    return body.toString("utf8");
  }
  return null;
}
