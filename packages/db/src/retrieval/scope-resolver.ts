import { and, eq, ilike, isNull, or } from "drizzle-orm";
import type { Tx } from "../client.js";
import { organizations } from "../schema/organizations.js";
import { contacts } from "../schema/contacts.js";
import { campaigns } from "../schema/campaigns.js";

/**
 * Heuristic mapping from a free-form question to a tenant-scoped set of
 * candidate object IDs. Sprint 4 ships a deliberately simple matcher (case-
 * insensitive substring search across legal_name/full_name/account_ref);
 * Sprint 6 will swap this for an LLM-driven NER pass.
 */
export interface ResolvedScope {
  org_ids?: string[];
  contact_ids?: string[];
  campaign_ids?: string[];
  date_range?: { start: Date; end: Date };
}

export class ScopeResolver {
  /**
   * Run inside a `withTenant` transaction — the queries below trust RLS for
   * isolation and only filter on the user-provided text.
   */
  async resolve(tx: Tx, query: string): Promise<ResolvedScope> {
    const tokens = extractCandidateTokens(query);
    const scope: ResolvedScope = {};

    if (tokens.length > 0) {
      // Orgs — active only. Archived / inactive orgs that happen to
      // match the tokens shouldn't surface in chat scope; operators
      // archive for a reason.
      const orgRows = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(
          and(
            eq(organizations.status, "active"),
            or(
              ...tokens.map((t) =>
                ilike(organizations.legalName, `%${t}%`),
              ),
            ),
          ),
        )
        .limit(20);
      if (orgRows.length > 0) scope.org_ids = orgRows.map((r) => r.id);

      // Contacts — active AND not merged. Tombstoned rows (status =
      // archived, mergedIntoContactId set) from the contact.merge
      // action must not leak back into the chat disambiguation list.
      const contactRows = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.status, "active"),
            isNull(contacts.mergedIntoContactId),
            or(
              ...tokens.map((t) => ilike(contacts.fullName, `%${t}%`)),
            ),
          ),
        )
        .limit(20);
      if (contactRows.length > 0) scope.contact_ids = contactRows.map((r) => r.id);

      const campaignRows = await tx
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(
          or(
            ...tokens.map((t) =>
              or(ilike(campaigns.channel, `%${t}%`), ilike(campaigns.medium, `%${t}%`)),
            ),
          ),
        )
        .limit(20);
      if (campaignRows.length > 0) scope.campaign_ids = campaignRows.map((r) => r.id);
    }

    const range = extractDateRange(query);
    if (range) scope.date_range = range;

    return scope;
  }
}

/**
 * Pull capitalized words and quoted strings out of the query as candidate
 * entity names. Skips common stop-words to keep noisy hits low.
 */
function extractCandidateTokens(query: string): string[] {
  const tokens = new Set<string>();
  const quoted = query.match(/"([^"]+)"/g);
  if (quoted) for (const q of quoted) tokens.add(q.replace(/"/g, ""));

  const capitalized = query.match(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)?\b/g);
  if (capitalized) {
    for (const t of capitalized) {
      if (!STOP_TOKENS.has(t.toLowerCase())) tokens.add(t);
    }
  }
  return [...tokens];
}

const STOP_TOKENS = new Set([
  "find",
  "show",
  "what",
  "which",
  "where",
  "when",
  "how",
  "why",
  "who",
  "the",
  "and",
  "or",
  "for",
  "with",
  "from",
  "in",
  "on",
  "to",
  "from",
]);

function extractDateRange(query: string): { start: Date; end: Date } | null {
  const lastNDaysMatch = /last\s+(\d+)\s+days?/i.exec(query);
  if (lastNDaysMatch) {
    const days = Number(lastNDaysMatch[1]);
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    return { start, end };
  }
  const lastWeek = /\blast\s+week\b/i.test(query);
  if (lastWeek) {
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { start, end };
  }
  return null;
}

