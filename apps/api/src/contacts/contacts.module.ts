import { Module, type DynamicModule } from "@nestjs/common";
import type {
  ContactRepository,
  Db,
  EventRepository,
} from "@vex/db";
import { ContactsController } from "./contacts.controller.js";
import { ContactsService } from "./contacts.service.js";
import {
  CONTACTS_DB_CLIENT,
  CONTACTS_EVENTS_REPO,
  CONTACTS_REPO,
} from "./tokens.js";

export interface ContactsModuleConfig {
  db: Db;
  contacts: ContactRepository;
  events: EventRepository;
}

@Module({})
export class ContactsModule {
  static register(config: ContactsModuleConfig): DynamicModule {
    return {
      module: ContactsModule,
      controllers: [ContactsController],
      providers: [
        { provide: CONTACTS_DB_CLIENT, useValue: config.db },
        { provide: CONTACTS_REPO, useValue: config.contacts },
        { provide: CONTACTS_EVENTS_REPO, useValue: config.events },
        ContactsService,
      ],
    };
  }
}
