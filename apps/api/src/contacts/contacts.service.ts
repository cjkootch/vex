import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  withTenant,
  type Contact,
  type ContactRepository,
  type Db,
  type EventRepository,
} from "@vex/db";
import { createId } from "@vex/domain";
import {
  CONTACTS_DB_CLIENT,
  CONTACTS_EVENTS_REPO,
  CONTACTS_REPO,
} from "./tokens.js";

export interface OptOutArgs {
  tenantId: string;
  contactId: string;
  actorUserId: string;
  reason: string;
}

export interface CreateContactArgs {
  tenantId: string;
  actorUserId: string;
  orgId: string;
  fullName: string;
  title?: string;
  emails?: string[];
  phones?: string[];
  timezone?: string;
}

/**
 * Service for contact suppression. Sprint 12 surfaces this because the
 * outbound-call workflow's checkSuppression activity reads the same
 * flag the admin UI writes via POST /contacts/:id/optout. All writes
 * go through withTenant so RLS scopes them; every opt-out lands an
 * audit event so the timeline captures who suppressed whom and why.
 */
@Injectable()
export class ContactsService {
  private readonly log = new Logger(ContactsService.name);

  constructor(
    @Inject(CONTACTS_DB_CLIENT) private readonly db: Db,
    @Inject(CONTACTS_REPO) private readonly contacts: ContactRepository,
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

  async create(args: CreateContactArgs): Promise<Contact> {
    const id = createId();
    const contact = await withTenant(this.db, args.tenantId, async (tx) => {
      const row = await this.contacts.create(tx, args.tenantId, {
        id,
        orgId: args.orgId,
        fullName: args.fullName,
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.emails !== undefined ? { emails: args.emails } : {}),
        ...(args.phones !== undefined ? { phones: args.phones } : {}),
        ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
      });
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
          org_id: args.orgId,
          created_by: args.actorUserId,
        },
      });
      return row;
    });
    this.log.log(`contact ${args.fullName} (${id}) created by ${args.actorUserId}`);
    return contact;
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
}
