import { eq } from "drizzle-orm";
import type { Tx } from "../client.js";
import { contacts, type Contact } from "../schema/contacts.js";

/** Stateless. Caller must wrap in `withTenant` so RLS scopes the queries. */
export class ContactRepository {
  async findById(tx: Tx, id: string): Promise<Contact | null> {
    const [row] = await tx.select().from(contacts).where(eq(contacts.id, id)).limit(1);
    return row ?? null;
  }

  async findByEmail(tx: Tx, email: string): Promise<Contact | null> {
    const rows = await tx.select().from(contacts);
    const lower = email.toLowerCase();
    return (
      rows.find((row) =>
        row.emails.some((e) => typeof e === "string" && e.toLowerCase() === lower),
      ) ?? null
    );
  }

  async findByOrgId(tx: Tx, orgId: string): Promise<Contact[]> {
    return tx.select().from(contacts).where(eq(contacts.orgId, orgId));
  }
}
