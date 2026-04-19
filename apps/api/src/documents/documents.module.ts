import { Module, type DynamicModule } from "@nestjs/common";
import type { Db, DocumentRepository } from "@vex/db";
import type { S3Uploader } from "@vex/integrations";
import { DocumentsController } from "./documents.controller.js";
import { DocumentsService } from "./documents.service.js";
import {
  DOCUMENTS_DB_CLIENT,
  DOCUMENTS_REPO,
  DOCUMENTS_S3,
} from "./tokens.js";

export interface DocumentsModuleConfig {
  db: Db;
  documents: DocumentRepository;
  s3: S3Uploader;
}

@Module({})
export class DocumentsModule {
  static register(config: DocumentsModuleConfig): DynamicModule {
    return {
      module: DocumentsModule,
      controllers: [DocumentsController],
      providers: [
        { provide: DOCUMENTS_DB_CLIENT, useFactory: () => config.db },
        { provide: DOCUMENTS_REPO, useFactory: () => config.documents },
        { provide: DOCUMENTS_S3, useFactory: () => config.s3 },
        DocumentsService,
      ],
    };
  }
}
