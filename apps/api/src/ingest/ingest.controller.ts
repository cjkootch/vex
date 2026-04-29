import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiTokenGuard } from "../auth/api-token.guard.js";
import { ProcurLeadIngestSchema } from "./dto.js";
import { IngestService } from "./ingest.service.js";

/**
 * Service-to-service ingest endpoints. Auth is bearer-token
 * ({@link ApiTokenGuard}, validating `VEX_API_TOKEN`), NOT a NextAuth
 * session — these calls come from upstream services, not browsers.
 */
@Controller("ingest/procur")
@UseGuards(ApiTokenGuard)
export class IngestController {
  constructor(
    @Inject(IngestService) private readonly service: IngestService,
  ) {}

  /**
   * POST /ingest/procur/leads
   *
   * Operator-triggered push from procur. Idempotent on
   * `procurOpportunityId` — re-clicking the "Send to Vex" button
   * returns the existing lead with `wasExisting=true`.
   */
  @Post("leads")
  async ingestLead(@Body() body: unknown) {
    const parsed = ProcurLeadIngestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: "invalid_payload",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    return this.service.ingestProcurLead(parsed.data);
  }
}
