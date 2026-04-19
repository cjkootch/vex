import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";
import { DocumentsService } from "./documents.service.js";

/**
 * Document upload / list / download / delete. Polymorphic: every
 * document is attached to exactly one subject (organization /
 * contact / fuel_deal) via (subject_type, subject_id).
 *
 * Upload accepts a single file via `multipart/form-data`. Metadata
 * travels as form fields alongside the file part (subject_type,
 * subject_id, document_type, title). The server writes the bytes to
 * S3, parses text if possible (PDF / text mime-types), and inserts
 * the `documents` row. Max size enforced at the service layer.
 */
@Controller("documents")
@UseGuards(JwtAuthGuard)
export class DocumentsController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(DocumentsService) private readonly service: DocumentsService,
  ) {}

  @Post()
  @HttpCode(201)
  async upload(@Req() req: FastifyRequest): Promise<{
    id: string;
    title: string;
    filename: string;
    documentType: string;
    sizeBytes: number;
    extracted: boolean;
  }> {
    if (!req.isMultipart()) {
      throw new BadRequestException("expected multipart/form-data");
    }
    let body: Buffer | null = null;
    let filename = "";
    let mimeType = "application/octet-stream";
    let subjectType = "";
    let subjectId = "";
    let documentType = "other";
    let title: string | undefined;

    for await (const part of req.parts()) {
      if (part.type === "file" && part.fieldname === "file") {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) chunks.push(chunk as Buffer);
        body = Buffer.concat(chunks);
        filename = part.filename ?? "";
        mimeType = part.mimetype ?? "application/octet-stream";
      } else if (part.type === "field") {
        const value = typeof part.value === "string" ? part.value : "";
        if (part.fieldname === "subject_type") subjectType = value;
        else if (part.fieldname === "subject_id") subjectId = value;
        else if (part.fieldname === "document_type") documentType = value;
        else if (part.fieldname === "title" && value) title = value;
      }
    }

    if (!body) throw new BadRequestException("missing file part");
    if (!subjectType || !subjectId) {
      throw new BadRequestException("subject_type and subject_id required");
    }

    return this.service.upload({
      tenantId: this.tenant.tenantId,
      uploadedBy: this.tenant.userId,
      subjectType,
      subjectId,
      filename,
      mimeType,
      documentType,
      ...(title !== undefined ? { title } : {}),
      body,
    });
  }

  @Get()
  async list(
    @Query("subject_type") subjectType?: string,
    @Query("subject_id") subjectId?: string,
  ): Promise<{
    documents: Awaited<ReturnType<DocumentsService["listBySubject"]>>;
  }> {
    if (!subjectType || !subjectId) {
      throw new BadRequestException("subject_type and subject_id required");
    }
    const documents = await this.service.listBySubject(
      this.tenant.tenantId,
      subjectType,
      subjectId,
    );
    return { documents };
  }

  @Get(":id/download")
  @Header("cache-control", "private, max-age=300")
  async download(
    @Param("id") id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const file = await this.service.download(this.tenant.tenantId, id);
    reply.header("content-type", file.mimeType);
    reply.header(
      "content-disposition",
      `inline; filename="${safeHeader(file.filename)}"`,
    );
    return file.body;
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id") id: string): Promise<void> {
    await this.service.delete(this.tenant.tenantId, id);
  }
}

function safeHeader(raw: string): string {
  return raw.replace(/["\r\n]/g, "");
}
