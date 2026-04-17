import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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

const MembershipInput = z.object({
  orgId: z.string().min(1),
  role: z.string().max(200).optional(),
  isPrimary: z.boolean().optional(),
});

const CreateContactBody = z
  .object({
    fullName: z.string().min(1).max(200),
    title: z.string().max(200).optional(),
    emails: z.array(z.string().email()).max(10).optional(),
    phones: z.array(z.string().max(40)).max(10).optional(),
    timezone: z.string().max(100).optional(),
    // Sprint 14 m:n — a contact can belong to many orgs. Exactly one
    // must be flagged primary; that membership's org_id is stored as
    // `contacts.org_id` for backwards compatibility with readers that
    // haven't migrated yet.
    orgs: z.array(MembershipInput).min(1).max(20),
  })
  .refine((b) => b.orgs.filter((o) => o.isPrimary).length <= 1, {
    message: "at most one org may be marked primary",
    path: ["orgs"],
  });

const AddMembershipBody = z.object({
  orgId: z.string().min(1),
  role: z.string().max(200).optional(),
  isPrimary: z.boolean().optional(),
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
    // Hydrate memberships so the list view can show every org a
    // contact belongs to — not just the denormalised primary.
    const hydrated = await this.service.hydrateMemberships(
      this.tenant.tenantId,
      contacts,
    );
    return { contacts: hydrated };
  }

  @Post()
  @HttpCode(201)
  async create(@Body() raw: unknown) {
    const parsed = CreateContactBody.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    const { contact, memberships } = await this.service.create({
      tenantId: this.tenant.tenantId,
      actorUserId: this.tenant.userId,
      fullName: parsed.data.fullName,
      ...(parsed.data.title ? { title: parsed.data.title } : {}),
      ...(parsed.data.emails ? { emails: parsed.data.emails } : {}),
      ...(parsed.data.phones ? { phones: parsed.data.phones } : {}),
      ...(parsed.data.timezone ? { timezone: parsed.data.timezone } : {}),
      orgs: parsed.data.orgs.map((o, idx) => ({
        orgId: o.orgId,
        role: o.role ?? null,
        // If the caller didn't set a primary, the first entry wins.
        isPrimary:
          o.isPrimary ??
          (idx === 0 && !parsed.data.orgs.some((x) => x.isPrimary)),
      })),
    });
    return { contact, memberships };
  }

  @Post(":id/memberships")
  @HttpCode(201)
  async addMembership(@Param("id") id: string, @Body() raw: unknown) {
    const parsed = AddMembershipBody.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    const { contact, memberships } = await this.service.addMembership({
      tenantId: this.tenant.tenantId,
      actorUserId: this.tenant.userId,
      contactId: id,
      orgId: parsed.data.orgId,
      role: parsed.data.role ?? null,
      isPrimary: parsed.data.isPrimary ?? false,
    });
    return { contact, memberships };
  }

  @Post(":id/memberships/:orgId/primary")
  async setPrimary(
    @Param("id") id: string,
    @Param("orgId") orgId: string,
  ) {
    const { contact, memberships } = await this.service.setPrimaryMembership({
      tenantId: this.tenant.tenantId,
      actorUserId: this.tenant.userId,
      contactId: id,
      orgId,
    });
    return { contact, memberships };
  }

  @Delete(":id/memberships/:orgId")
  async removeMembership(
    @Param("id") id: string,
    @Param("orgId") orgId: string,
  ) {
    const { contact, memberships } = await this.service.removeMembership({
      tenantId: this.tenant.tenantId,
      actorUserId: this.tenant.userId,
      contactId: id,
      orgId,
    });
    return { contact, memberships };
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
    const [contact, memberships, deals] = await Promise.all([
      this.service.findById(this.tenant.tenantId, id),
      this.service.listMemberships(this.tenant.tenantId, id),
      this.service.listDealsForContact(this.tenant.tenantId, id),
    ]);
    return { contact, memberships, deals };
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
