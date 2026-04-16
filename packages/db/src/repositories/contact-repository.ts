import { and, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { contacts, type Contact } from "../schema/contacts.js";

export class ContactRepository {
  constructor(private readonly db: Db) {}

  async findById(tenantId: string, id: string): Promise<Contact | null> {
    const [row] = await this.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, id)))
      .limit(1);
    return row ?? null;
  }

  async findByEmail(tenantId: string, email: string): Promise<Contact | null> {
    const rows = await this.db
      .select()
      .from(contacts)
      .where(eq(contacts.tenantId, tenantId));
    const lower = email.toLowerCase();
    return (
      rows.find((row) =>
        row.emails.some((e) => typeof e === "string" && e.toLowerCase() === lower),
      ) ?? null
    );
  }

  async findByOrgId(tenantId: string, orgId: string): Promise<Contact[]> {
    return this.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.orgId, orgId)));
  }
}
