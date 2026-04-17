import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
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

const CreateContactBody = z.object({
  orgId: z.string().min(1),
  fullName: z.string().min(1).max(200),
  title: z.string().max(200).optional(),
  emails: z.array(z.string().email()).max(10).optional(),
  phones: z.array(z.string().max(40)).max(10).optional(),
  timezone: z.string().max(100).optional(),
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

  @Get()
  async list(
    @Query("limit") limitRaw?: string,
    @Query("status") statusRaw?: string,
  ) {
    const limit = clampLimit(limitRaw);
    const status = statusRaw === "suppressed" ? "suppressed" : "active";
    const contacts =
      status === "suppressed"
        ? await this.service.listSuppressed(this.tenant.tenantId, limit)
        : await this.service.listActive(this.tenant.tenantId, limit);
    return { contacts };
  }

  @Post()
  @HttpCode(201)
  async create(@Body() raw: unknown) {
    const parsed = CreateContactBody.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    const contact = await this.service.create({
      tenantId: this.tenant.tenantId,
      actorUserId: this.tenant.userId,
      orgId: parsed.data.orgId,
      fullName: parsed.data.fullName,
      ...(parsed.data.title ? { title: parsed.data.title } : {}),
      ...(parsed.data.emails ? { emails: parsed.data.emails } : {}),
      ...(parsed.data.phones ? { phones: parsed.data.phones } : {}),
      ...(parsed.data.timezone ? { timezone: parsed.data.timezone } : {}),
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
}

function clampLimit(raw: string | undefined): number {
  const parsed = raw ? Number.parseInt(raw, 10) : 200;
  if (!Number.isFinite(parsed) || parsed <= 0) return 200;
  return Math.min(parsed, 500);
}
