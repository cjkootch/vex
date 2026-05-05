import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
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

const BulkArchiveBody = z.object({
  contactIds: z.array(z.string().min(1).max(40)).min(1).max(500),
  reason: z.string().max(500).optional(),
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
 * Editable fields on a contact. Memberships (orgs / roles / primary)
 * have their own mutation endpoints below — this patch only touches
 * the hand-maintained identity columns.
 */
const UpdateContactBody = z
  .object({
    fullName: z.string().min(1).max(200),
    title: z.string().max(120).nullable(),
    emails: z.array(z.string().email()).max(10).nullable(),
    phones: z.array(z.string().max(40)).max(10).nullable(),
    timezone: z.string().max(100).nullable(),
  })
  .partial();

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
    @Query("org_id") orgIdRaw?: string,
  ) {
    const limit = clampLimit(limitRaw);
    const status = statusRaw === "suppressed" ? "suppressed" : "active";
    const orgId = orgIdRaw && orgIdRaw.length > 0 ? orgIdRaw : null;
    const contacts = orgId
      ? await this.service.listByOrgId(this.tenant.tenantId, orgId)
      : status === "suppressed"
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

  /**
   * CSV-import path. Each row attaches to a single target org
   * (orgId is required on the wrapper, not per-row). Dedupe by
   * primary email — a row matching an existing contact's email in
   * the same tenant skips insert but records "duplicate" so the UI
   * can surface how many rows collapsed onto existing records.
   */
  @Post("bulk")
  @HttpCode(200)
  async bulkCreate(@Body() raw: unknown): Promise<{
    imported: number;
    duplicates: number;
    failed: number;
    rows: Array<{
      index: number;
      status: "created" | "duplicate" | "failed";
      id?: string;
      error?: string;
    }>;
  }> {
    const BulkRow = z.object({
      fullName: z.string().min(1).max(200),
      title: z.string().max(200).optional(),
      emails: z.array(z.string().email()).max(10).optional(),
      phones: z.array(z.string().max(40)).max(10).optional(),
    });
    const parsed = z
      .object({
        orgId: z.string().min(1),
        rows: z.array(BulkRow).min(1).max(500),
      })
      .safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }

    const results: Array<{
      index: number;
      status: "created" | "duplicate" | "failed";
      id?: string;
      error?: string;
    }> = [];

    for (let i = 0; i < parsed.data.rows.length; i += 1) {
      const row = parsed.data.rows[i]!;
      try {
        const outcome = await this.service.create({
          tenantId: this.tenant.tenantId,
          actorUserId: this.tenant.userId,
          fullName: row.fullName,
          ...(row.title ? { title: row.title } : {}),
          ...(row.emails ? { emails: row.emails } : {}),
          ...(row.phones ? { phones: row.phones } : {}),
          orgs: [
            {
              orgId: parsed.data.orgId,
              role: null,
              isPrimary: true,
            },
          ],
        });
        results.push({
          index: i,
          status: "created",
          id: outcome.contact.id,
        });
      } catch (err) {
        const message = (err as Error).message;
        // `ContactsService.create` throws a 409-shaped error when the
        // primary email already matches an existing contact. Surface
        // that as "duplicate" rather than "failed" so the UI reports
        // the distinction usefully.
        const isDup = /exists|duplicate/i.test(message);
        results.push({
          index: i,
          status: isDup ? "duplicate" : "failed",
          error: message,
        });
      }
    }

    const imported = results.filter((r) => r.status === "created").length;
    const duplicates = results.filter((r) => r.status === "duplicate").length;
    const failed = results.filter((r) => r.status === "failed").length;
    return { imported, duplicates, failed, rows: results };
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

  /**
   * GET /contacts/hot?limit=20
   *
   * Engagement-velocity ranking — contacts whose recent touchpoint
   * activity makes them worth working today. See
   * `ContactsService.listHot` for the score formula. The list is
   * computed on demand; cache TTL is operator-tolerable since the
   * underlying counts only shift on new inbound + open / click
   * events, all of which already invalidate the touchpoint table.
   */
  @Get("hot")
  async listHot(@Query("limit") limitRaw: string | undefined) {
    const parsed = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
    const limit =
      Number.isFinite(parsed) && parsed >= 1 && parsed <= 50
        ? parsed
        : 20;
    const hot = await this.service.listHot(this.tenant.tenantId, limit);
    return { hot };
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

  /**
   * Campaigns the contact is enrolled in (or has been through). Drives
   * the Sequences panel on the contact profile. Returns up to 50 rows
   * so an over-enrolled contact doesn't blow up the UI; older rows
   * beyond that are accessible via the campaign detail page.
   */
  @Get(":id/enrollments")
  async listEnrollments(@Param("id") id: string) {
    const enrollments = await this.service.listEnrollmentsForContact(
      this.tenant.tenantId,
      id,
    );
    return { enrollments };
  }

  /**
   * Operational pulse for a contact. Aggregates the signals the
   * contact detail page's hero band needs at a glance:
   *   · primary org + every other org this contact represents
   *   · open-deal count where contact is the buyer_contact
   *   · last touchpoint timestamp + channel
   *   · recent activity count (7d) across this contact
   */
  @Get(":id/pulse")
  async pulse(@Param("id") id: string) {
    const pulse = await this.service.contactPulse(this.tenant.tenantId, id);
    return pulse;
  }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() raw: unknown) {
    const parsed = UpdateContactBody.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    const contact = await this.service.update({
      tenantId: this.tenant.tenantId,
      actorUserId: this.tenant.userId,
      contactId: id,
      patch: parsed.data,
    });
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

  /**
   * Bulk soft-delete (archive). Called from the /app/contacts list
   * when the operator checks N rows + confirms in the typed-
   * confirmation modal. Flips status='archived' on each id + emits
   * one `contacts.bulk_archived` audit event for the batch. Max 500
   * per request so the UI can't accidentally archive a whole
   * workspace in a single click.
   */
  @Post("bulk-archive")
  async bulkArchive(@Body() raw: unknown) {
    const parsed = BulkArchiveBody.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    const result = await this.service.bulkArchive({
      tenantId: this.tenant.tenantId,
      contactIds: parsed.data.contactIds,
      actorUserId: this.tenant.userId,
      ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
    });
    return result;
  }
}

function clampLimit(raw: string | undefined): number {
  const parsed = raw ? Number.parseInt(raw, 10) : 200;
  if (!Number.isFinite(parsed) || parsed <= 0) return 200;
  return Math.min(parsed, 500);
}
