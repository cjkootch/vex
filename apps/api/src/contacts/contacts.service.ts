import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
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
      // `contacts.org_id` points at the primary for backwards-compat
      // with readers that predate the memberships table.
      const contact = await this.contacts.create(tx, args.tenantId, {
        id,
        orgId: primary.orgId,
        fullName: args.fullName,
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.emails !== undefined ? { emails: args.emails } : {}),
        ...(args.phones !== undefined ? { phones: args.phones } : {}),
        ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
      });

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
        idempotencyKey: `contact.primary_changed:${args.contactId}:${args.orgId}:${Date.now()}`,
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
        idempotencyKey: `contact.membership_removed:${args.contactId}:${args.orgId}:${Date.now()}`,
        metadata: { actor_user_id: args.actorUserId },
      });
      const memberships = await this.memberships.listByContact(tx, args.contactId);
      return { contact, memberships };
    });
  }
}

