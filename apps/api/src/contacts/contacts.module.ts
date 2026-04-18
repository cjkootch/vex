import { Module, type DynamicModule } from "@nestjs/common";
import type {
  ContactOrgMembershipRepository,
  ContactRepository,
  Db,
  EventRepository,
} from "@vex/db";
import { ContactsController } from "./contacts.controller.js";
import { ContactsService } from "./contacts.service.js";
import {
  CONTACTS_DB_CLIENT,
  CONTACTS_EVENTS_REPO,
  CONTACTS_MEMBERSHIPS_REPO,
  CONTACTS_REPO,
} from "./tokens.js";

export interface ContactsModuleConfig {
  db: Db;
  contacts: ContactRepository;
  memberships: ContactOrgMembershipRepository;
  events: EventRepository;
}

@Module({})
export class ContactsModule {
  static register(config: ContactsModuleConfig): DynamicModule {
    return {
      module: ContactsModule,
      controllers: [ContactsController],
      providers: [
        { provide: CONTACTS_DB_CLIENT, useFactory: () => config.db },
        { provide: CONTACTS_REPO, useFactory: () => config.contacts },
        { provide: CONTACTS_MEMBERSHIPS_REPO, useFactory: () => config.memberships },
        { provide: CONTACTS_EVENTS_REPO, useFactory: () => config.events },
        ContactsService,
      ],
    };
  }
}
