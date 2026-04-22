import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { desc, eq, sql } from "drizzle-orm";
import {
  schema,
  withTenant,
  type Contact,
  type ContactOrgMembership,
  type ContactOrgMembershipRepository,
  type ContactRepository,
  type Db,
  type EventRepository,
} from "@vex/db";
import { createId } from "@vex/domain";
import {
  CONTACTS_DB_CLIENT,
  CONTACTS_EVENTS_REPO,
  CONTACTS_MEMBERSHIPS_REPO,
  CONTACTS_REPO,
} from "./tokens.js";

export interface OptOutArgs {
  tenantId: string;
  contactId: string;
  actorUserId: string;
  reason: string;
}

export interface CreateContactOrgInput {
  orgId: string;
  role: string | null;
  isPrimary: boolean;
}

export interface CreateContactArgs {
  tenantId: string;
  actorUserId: string;
  fullName: string;
  title?: string;
  emails?: string[];
  phones?: string[];
  timezone?: string;
  orgs: CreateContactOrgInput[];
}

export interface AddMembershipArgs {
  tenantId: string;
  actorUserId: string;
  contactId: string;
  orgId: string;
  role: string | null;
  isPrimary: boolean;
}

export interface MembershipMutationArgs {
  tenantId: string;
  actorUserId: string;
  contactId: string;
  orgId: string;
}

export interface UpdateContactPatch {
  fullName?: string | undefined;
  title?: string | null | undefined;
  emails?: string[] | null | undefined;
  phones?: string[] | null | undefined;
  timezone?: string | null | undefined;
}

export interface UpdateContactArgs {
  tenantId: string;
  actorUserId: string;
  contactId: string;
  patch: UpdateContactPatch;
}

export interface ContactWithMemberships {
  contact: Contact;
  memberships: ContactOrgMembership[];
}

export interface HydratedContact extends Contact {
  orgs: Array<{
    orgId: string;
    role: string | null;
    isPrimary: boolean;
  }>;
}

/**
 * Contact domain service. Suppression (Sprint 12) + creation +
 * many-to-many org memberships (Sprint 14).
 *
 * Every mutation runs inside `withTenant` for RLS scoping and emits
 * an audit event. `contacts.org_id` is kept in sync with the primary
 * membership so legacy readers that still reach for the denormalised
 * column continue to see the correct value.
 */
@Injectable()
export class ContactsService {
  private readonly log = new Logger(ContactsService.name);

  constructor(
    @Inject(CONTACTS_DB_CLIENT) private readonly db: Db,
    @Inject(CONTACTS_REPO) private readonly contacts: ContactRepository,
    @Inject(CONTACTS_MEMBERSHIPS_REPO)
    private readonly memberships: ContactOrgMembershipRepository,
    @Inject(CONTACTS_EVENTS_REPO) private readonly events: EventRepository,
  ) {}

  async optOut(args: OptOutArgs): Promise<Contact> {
    return withTenant(this.db, args.tenantId, async (tx) => {
      const existing = await this.contacts.findById(tx, args.contactId);
      if (!existing) {
        throw new NotFoundException(`contact ${args.contactId} not found`);
      }
      const updated = await this.contacts.setOptOut(tx, args.contactId, args.reason);
      await this.events.insertIfNotExists(tx, args.tenantId, {
        verb: "contact.opted_out",
        subjectType: "contact",
        subjectId: args.contactId,
        actorType: "user",
        actorId: args.actorUserId,
        objectType: "contact",
        objectId: args.contactId,
        occurredAt: new Date(),
        idempotencyKey: `contact.opted_out:${args.contactId}:${updated.optOutAt?.toISOString() ?? "now"}`,
        metadata: {
          reason: args.reason,
          audit_event_id: createId(),
        },
      });
      this.log.log(`contact ${args.contactId} opted out: ${args.reason}`);
      return updated;
    });
  }

  /**
   * Bulk soft-delete. Flips `status` on every supplied contact id to
   * `archived`. Single audit event covers the batch so operators can
   * trace "who archived these N contacts and when" from one row in
   * the events feed.
   */
  async bulkArchive(args: {
    tenantId: string;
    contactIds: readonly string[];
    actorUserId: string;
    reason?: string;
  }): Promise<{ archivedCount: number; archivedIds: string[] }> {
    if (args.contactIds.length === 0) {
      return { archivedCount: 0, archivedIds: [] };
    }
    return withTenant(this.db, args.tenantId, async (tx) => {
      const updated = await this.contacts.updateStatusByIds(
        tx,
        args.contactIds,
        "archived",
      );
      const archivedIds = updated.map((c) => c.id);
      if (archivedIds.length > 0) {
        await this.events.insertIfNotExists(tx, args.tenantId, {
          verb: "contacts.bulk_archived",
          subjectType: "contact",
          // Use the first id as the subject so the contact-detail
          // timeline at /app/contacts/:id surfaces the archive event
          // for at least one of the batch.
          subjectId: archivedIds[0]!,
          actorType: "user",
          actorId: args.actorUserId,
          objectType: "contact",
          objectId: archivedIds[0]!,
          occurredAt: new Date(),
          idempotencyKey: `contacts.bulk_archived:${args.actorUserId}:${Date.now()}:${archivedIds.length}`,
          metadata: {
            archived_count: archivedIds.length,
            requested_count: args.contactIds.length,
            archived_ids: archivedIds,
            reason: args.reason ?? null,
          },
        });
      }
      this.log.log(
        `bulk-archived ${archivedIds.length}/${args.contactIds.length} contacts by ${args.actorUserId}`,
      );
      return { archivedCount: archivedIds.length, archivedIds };
    });
  }

  async listSuppressed(tenantId: string, limit = 200): Promise<Contact[]> {
    return withTenant(this.db, tenantId, async (tx) =>
      this.contacts.listSuppressed(tx, limit),
    );
  }

  async listActive(tenantId: string, limit = 200): Promise<Contact[]> {
    return withTenant(this.db, tenantId, async (tx) =>
      this.contacts.listActive(tx, limit),
    );
  }

  /**
   * List contacts whose primary org matches `orgId`. Used by the chat
   * agent's campaign.enroll_batch proposal flow — the agent needs
   * concrete contact IDs for a given company before it can propose
   * who to enroll.
   */
  async listByOrgId(tenantId: string, orgId: string): Promise<Contact[]> {
    return withTenant(this.db, tenantId, async (tx) =>
      this.contacts.findByOrgId(tx, orgId),
    );
  }

  /**
   * Create a contact with one or more org memberships. The caller is
   * responsible for designating at most one primary; if none is
   * flagged the first entry becomes primary by default. `contacts.org_id`
   * is set to the primary org.
   */
  async create(args: CreateContactArgs): Promise<ContactWithMemberships> {
    if (args.orgs.length === 0) {
      throw new BadRequestException("at least one org membership required");
    }
    const primaryCount = args.orgs.filter((o) => o.isPrimary).length;
    if (primaryCount > 1) {
      throw new BadRequestException("at most one org may be primary");
    }
    const normalisedOrgs: CreateContactOrgInput[] =
      primaryCount === 0
        ? args.orgs.map((o, idx) => ({ ...o, isPrimary: idx === 0 }))
        : args.orgs;
    const primary = normalisedOrgs.find((o) => o.isPrimary);
    if (!primary) {
      throw new BadRequestException("internal: primary org not resolved");
    }

    const id = createId();
    const result = await withTenant(this.db, args.tenantId, async (tx) => {
      // Unified dedupe path — the approval executor calls the same
      // \`createWithDedupeCheck\` helper so both the direct API and the
      // approval routes collapse onto one email-overlap check.
      const created = await this.contacts.createWithDedupeCheck(
        tx,
        args.tenantId,
        {
          id,
          orgId: primary.orgId,
          fullName: args.fullName,
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.emails !== undefined ? { emails: args.emails } : {}),
          ...(args.phones !== undefined ? { phones: args.phones } : {}),
          ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
        },
      );
      if (created.kind === "duplicate") {
        throw new ConflictException({
          message: `contact with email ${created.matchedEmail} already exists`,
          existingContactId: created.contact.id,
        });
      }
      const contact = created.contact;

      const memberships: ContactOrgMembership[] = [];
      for (const org of normalisedOrgs) {
        const row = await this.memberships.create(tx, args.tenantId, {
          contactId: id,
          orgId: org.orgId,
          role: org.role,
          isPrimary: org.isPrimary,
        });
        memberships.push(row);
      }

      await this.events.insertIfNotExists(tx, args.tenantId, {
        verb: "contact.created",
        subjectType: "contact",
        subjectId: id,
        actorType: "user",
        actorId: args.actorUserId,
        objectType: "contact",
        objectId: id,
        occurredAt: new Date(),
        idempotencyKey: `contact.created:${id}`,
        metadata: {
          full_name: args.fullName,
          primary_org_id: primary.orgId,
          org_count: normalisedOrgs.length,
          created_by: args.actorUserId,
        },
      });

      return { contact, memberships };
    });

    this.log.log(
      `contact ${args.fullName} (${id}) created with ${normalisedOrgs.length} orgs by ${args.actorUserId}`,
    );
    return result;
  }

  async findById(tenantId: string, id: string): Promise<Contact> {
    const contact = await withTenant(this.db, tenantId, async (tx) =>
      this.contacts.findById(tx, id),
    );
    if (!contact) {
      throw new NotFoundException(`contact ${id} not found`);
    }
    return contact;
  }

  /**
   * Edit the hand-maintained columns on a contact — name, title,
   * emails, phones, timezone. Org memberships have their own mutation
   * endpoints (addMembership / setPrimaryMembership / removeMembership)
   * so we don't rewrite them here. Emits an audit event with
   * before/after for the compliance timeline.
   */
  async update(args: UpdateContactArgs): Promise<Contact> {
    const { tenantId, actorUserId, contactId, patch } = args;
    return withTenant(this.db, tenantId, async (tx) => {
      const before = await this.contacts.findById(tx, contactId);
      if (!before) {
        throw new NotFoundException(`contact ${contactId} not found`);
      }

      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.fullName !== undefined) set["fullName"] = patch.fullName;
      if (patch.title !== undefined) set["title"] = patch.title;
      if (patch.emails !== undefined) set["emails"] = patch.emails ?? [];
      if (patch.phones !== undefined) set["phones"] = patch.phones ?? [];
      if (patch.timezone !== undefined) set["timezone"] = patch.timezone;

      const [after] = await tx
        .update(schema.contacts)
        .set(set)
        .where(eq(schema.contacts.id, contactId))
        .returning();
      if (!after) throw new Error(`contact ${contactId} vanished during update`);

      await this.events.insertIfNotExists(tx, tenantId, {
        verb: "contact.updated",
        subjectType: "contact",
        subjectId: contactId,
        actorType: "user",
        actorId: actorUserId,
        objectType: "contact",
        objectId: contactId,
        occurredAt: new Date(),
        // Stable key — tied to before.updatedAt so a retry dedupes but
        // a second distinct edit lands a fresh audit row.
        idempotencyKey: `contact.updated:${contactId}:${before.updatedAt.toISOString()}`,
        metadata: {
          patch,
          before,
          after,
          audit_event_id: createId(),
        },
      });

      this.log.log(`contact ${contactId} updated by ${actorUserId}`);
      return after;
    });
  }

  /** List memberships for a contact, primary first. */
  async listMemberships(
    tenantId: string,
    contactId: string,
  ): Promise<ContactOrgMembership[]> {
    return withTenant(this.db, tenantId, async (tx) =>
      this.memberships.listByContact(tx, contactId),
    );
  }

  /**
   * Deals where this contact is the named buyer_contact on the deal
   * record. Used by the Contact detail page's Deals tab. Limited to
   * 100 rows — a contact with more than that in the pipeline is a
   * case for a dedicated filter page rather than an inline list.
   */
  async listDealsForContact(
    tenantId: string,
    contactId: string,
  ): Promise<
    Array<{
      id: string;
      dealRef: string;
      status: string;
      product: string;
      volumeUsg: number;
      buyerOrgId: string;
    }>
  > {
    return withTenant(this.db, tenantId, async (tx) =>
      tx
        .select({
          id: schema.fuelDeals.id,
          dealRef: schema.fuelDeals.dealRef,
          status: schema.fuelDeals.status,
          product: schema.fuelDeals.product,
          volumeUsg: schema.fuelDeals.volumeUsg,
          buyerOrgId: schema.fuelDeals.buyerOrgId,
        })
        .from(schema.fuelDeals)
        .where(eq(schema.fuelDeals.buyerContactId, contactId))
        .orderBy(desc(schema.fuelDeals.createdAt))
        .limit(100),
    );
  }

  /**
   * Campaign enrollments (sequences) this contact is currently in or
   * has been through. Powers the Sequences panel on the contact
   * profile — one row per (contact × campaign) with enough metadata
   * for the UI to render progress (step X of Y), the current state,
   * and a link back to the campaign detail page.
   *
   * Joined in one query:
   *   - campaign_enrollments         → the membership row
   *   - campaigns                    → channel/source/medium for label
   *   - COUNT(campaign_steps)        → total step count for progress
   */
  async listEnrollmentsForContact(
    tenantId: string,
    contactId: string,
  ): Promise<
    Array<{
      id: string;
      campaignId: string;
      campaignChannel: string;
      campaignSource: string | null;
      campaignMedium: string | null;
      campaignObjective: string | null;
      campaignStatus: string;
      state: string;
      currentStep: number;
      stepCount: number;
      lastEventAt: string | null;
      enrolledAt: string;
      updatedAt: string;
      error: string | null;
    }>
  > {
    return withTenant(this.db, tenantId, async (tx) => {
      const stepCountSubq = tx
        .select({
          campaignId: schema.campaignSteps.campaignId,
          count: sql<number>`count(*)::int`.as("step_count"),
        })
        .from(schema.campaignSteps)
        .groupBy(schema.campaignSteps.campaignId)
        .as("step_counts");

      const rows = await tx
        .select({
          id: schema.campaignEnrollments.id,
          campaignId: schema.campaignEnrollments.campaignId,
          campaignChannel: schema.campaigns.channel,
          campaignSource: schema.campaigns.source,
          campaignMedium: schema.campaigns.medium,
          campaignObjective: schema.campaigns.objective,
          campaignStatus: schema.campaigns.status,
          state: schema.campaignEnrollments.state,
          currentStep: schema.campaignEnrollments.currentStep,
          stepCount: stepCountSubq.count,
          lastEventAt: schema.campaignEnrollments.lastEventAt,
          enrolledAt: schema.campaignEnrollments.createdAt,
          updatedAt: schema.campaignEnrollments.updatedAt,
          error: schema.campaignEnrollments.error,
        })
        .from(schema.campaignEnrollments)
        .innerJoin(
          schema.campaigns,
          eq(schema.campaignEnrollments.campaignId, schema.campaigns.id),
        )
        .leftJoin(
          stepCountSubq,
          eq(stepCountSubq.campaignId, schema.campaignEnrollments.campaignId),
        )
        .where(eq(schema.campaignEnrollments.contactId, contactId))
        .orderBy(desc(schema.campaignEnrollments.updatedAt))
        .limit(50);

      return rows.map((r) => ({
        id: r.id,
        campaignId: r.campaignId,
        campaignChannel: r.campaignChannel,
        campaignSource: r.campaignSource,
        campaignMedium: r.campaignMedium,
        campaignObjective: r.campaignObjective,
        campaignStatus: r.campaignStatus,
        state: r.state,
        currentStep: r.currentStep,
        stepCount: Number(r.stepCount ?? 0),
        lastEventAt: r.lastEventAt ? r.lastEventAt.toISOString() : null,
        enrolledAt: r.enrolledAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        error: r.error,
      }));
    });
  }

  /**
   * Bulk-fetch memberships for a set of contacts and stamp each row
   * with its org list. The list view calls this so a contact that
   * belongs to multiple orgs renders a chip per org without a
   * round-trip per row.
   */
  async hydrateMemberships(
    tenantId: string,
    contacts: Contact[],
  ): Promise<HydratedContact[]> {
    if (contacts.length === 0) return [];
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await this.memberships.listByContactIds(
        tx,
        contacts.map((c) => c.id),
      );
      const byContact = new Map<
        string,
        Array<{ orgId: string; role: string | null; isPrimary: boolean }>
      >();
      for (const r of rows) {
        const bucket = byContact.get(r.contactId) ?? [];
        bucket.push({ orgId: r.orgId, role: r.role, isPrimary: r.isPrimary });
        byContact.set(r.contactId, bucket);
      }
      return contacts.map((c) => ({
        ...c,
        orgs:
          byContact.get(c.id) ??
          [{ orgId: c.orgId, role: null, isPrimary: true }],
      }));
    });
  }

  async addMembership(args: AddMembershipArgs): Promise<ContactWithMemberships> {
    return withTenant(this.db, args.tenantId, async (tx) => {
      const contact = await this.contacts.findById(tx, args.contactId);
      if (!contact) {
        throw new NotFoundException(`contact ${args.contactId} not found`);
      }
      const existing = await this.memberships.listByContact(tx, args.contactId);
      if (existing.some((m) => m.orgId === args.orgId)) {
        throw new BadRequestException(
          `contact ${args.contactId} already belongs to org ${args.orgId}`,
        );
      }
      await this.memberships.create(tx, args.tenantId, {
        contactId: args.contactId,
        orgId: args.orgId,
        role: args.role,
        isPrimary: args.isPrimary,
      });
      // When the new row claims primacy, clear the prior primary so the
      // partial unique index stays satisfied and keep contacts.org_id
      // in sync.
      let updatedContact = contact;
      if (args.isPrimary) {
        await this.memberships.setPrimary(tx, args.contactId, args.orgId);
        const [row] = await tx
          .update(schema.contacts)
          .set({ orgId: args.orgId, updatedAt: new Date() })
          .where(eq(schema.contacts.id, args.contactId))
          .returning();
        if (row) updatedContact = row;
      }
      await this.events.insertIfNotExists(tx, args.tenantId, {
        verb: "contact.membership_added",
        subjectType: "contact",
        subjectId: args.contactId,
        actorType: "user",
        actorId: args.actorUserId,
        objectType: "organization",
        objectId: args.orgId,
        occurredAt: new Date(),
        idempotencyKey: `contact.membership_added:${args.contactId}:${args.orgId}`,
        metadata: {
          role: args.role,
          is_primary: args.isPrimary,
          actor_user_id: args.actorUserId,
        },
      });
      const memberships = await this.memberships.listByContact(tx, args.contactId);
      return { contact: updatedContact, memberships };
    });
  }

  async setPrimaryMembership(
    args: MembershipMutationArgs,
  ): Promise<ContactWithMemberships> {
    return withTenant(this.db, args.tenantId, async (tx) => {
      const contact = await this.contacts.findById(tx, args.contactId);
      if (!contact) {
        throw new NotFoundException(`contact ${args.contactId} not found`);
      }
      const existing = await this.memberships.listByContact(tx, args.contactId);
      if (!existing.some((m) => m.orgId === args.orgId)) {
        throw new NotFoundException(
          `membership ${args.contactId}:${args.orgId} not found`,
        );
      }
      await this.memberships.setPrimary(tx, args.contactId, args.orgId);
      const [updatedContact] = await tx
        .update(schema.contacts)
        .set({ orgId: args.orgId, updatedAt: new Date() })
        .where(eq(schema.contacts.id, args.contactId))
        .returning();
      await this.events.insertIfNotExists(tx, args.tenantId, {
        verb: "contact.primary_changed",
        subjectType: "contact",
        subjectId: args.contactId,
        actorType: "user",
        actorId: args.actorUserId,
        objectType: "organization",
        objectId: args.orgId,
        occurredAt: new Date(),
        // Per-request key. A stable \`${contactId}:${orgId}\` suffix
        // silently dropped audit history for legitimate A→B→A→B
        // cycles (insertIfNotExists finds the old key and skips).
        // Real retry dedupe needs a client \`Idempotency-Key\` header;
        // until that lands, mint a fresh \`createId()\` per call so
        // every service invocation audits. Trade-off: an HTTP-level
        // retry of the same mutation creates a second audit row —
        // less bad than dropping the third primary change in a
        // cycle of re-promotions.
        idempotencyKey: `contact.primary_changed:${args.contactId}:${args.orgId}:${createId()}`,
        metadata: {
          from_org_id: contact.orgId,
          to_org_id: args.orgId,
          actor_user_id: args.actorUserId,
        },
      });
      const memberships = await this.memberships.listByContact(tx, args.contactId);
      return { contact: updatedContact ?? contact, memberships };
    });
  }

  async removeMembership(
    args: MembershipMutationArgs,
  ): Promise<ContactWithMemberships> {
    return withTenant(this.db, args.tenantId, async (tx) => {
      const contact = await this.contacts.findById(tx, args.contactId);
      if (!contact) {
        throw new NotFoundException(`contact ${args.contactId} not found`);
      }
      const existing = await this.memberships.listByContact(tx, args.contactId);
      if (existing.length <= 1) {
        throw new BadRequestException(
          "contact must retain at least one org membership",
        );
      }
      const target = existing.find((m) => m.orgId === args.orgId);
      if (!target) {
        throw new NotFoundException(
          `membership ${args.contactId}:${args.orgId} not found`,
        );
      }
      if (target.isPrimary) {
        throw new BadRequestException(
          "cannot remove the primary membership — promote another first",
        );
      }
      await this.memberships.remove(tx, args.contactId, args.orgId);
      await this.events.insertIfNotExists(tx, args.tenantId, {
        verb: "contact.membership_removed",
        subjectType: "contact",
        subjectId: args.contactId,
        actorType: "user",
        actorId: args.actorUserId,
        objectType: "organization",
        objectId: args.orgId,
        occurredAt: new Date(),
        // Per-request key — see primary_changed above. A
        // \`${contactId}:${orgId}\` suffix would dedupe a
        // legitimate remove-after-readd cycle.
        idempotencyKey: `contact.membership_removed:${args.contactId}:${args.orgId}:${createId()}`,
        metadata: { actor_user_id: args.actorUserId },
      });
      const memberships = await this.memberships.listByContact(tx, args.contactId);
      return { contact, memberships };
    });
  }
}

