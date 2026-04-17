import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";
import { ContactsService } from "./contacts.service.js";

const OptOutBody = z.object({
  reason: z.string().min(1).max(500),
});

/**
 * REST surface for contact suppression. Paired with Sprint 12's
 * outbound-call workflow — POST /contacts/:id/optout writes the flag
 * the workflow's checkSuppression activity reads.
 *
 * Any authenticated caller may opt out a contact; the audit event
 * records who did it. Listing suppressed contacts is idempotent.
 */
@Controller("contacts")
@UseGuards(JwtAuthGuard)
export class ContactsController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(ContactsService) private readonly service: ContactsService,
  ) {}

  @Get(":id")
  async getContact(@Param("id") id: string) {
    const contact = await this.service.findById(this.tenant.tenantId, id);
    return { contact };
  }

  @Post(":id/optout")
  async optOut(@Param("id") id: string, @Body() raw: unknown) {
    const parsed = OptOutBody.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    const contact = await this.service.optOut({
      tenantId: this.tenant.tenantId,
      contactId: id,
      actorUserId: this.tenant.userId,
      reason: parsed.data.reason,
    });
    return { contact };
  }

  @Get("suppressed")
  async listSuppressed(@Query("limit") limitRaw: string | undefined) {
    const limit = clampLimit(limitRaw);
    const contacts = await this.service.listSuppressed(
      this.tenant.tenantId,
      limit,
    );
    return { contacts };
  }
}

function clampLimit(raw: string | undefined): number {
  const parsed = raw ? Number.parseInt(raw, 10) : 200;
  if (!Number.isFinite(parsed) || parsed <= 0) return 200;
  return Math.min(parsed, 500);
}
