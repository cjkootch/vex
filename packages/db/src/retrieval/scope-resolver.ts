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
 * Pull candidate entity-name tokens out of the query. Two sources:
 *
 *   1. Quoted strings — the operator's explicit "this is a name" signal.
 *   2. Word runs — single words ≥ 3 chars and adjacent two-word pairs.
 *      Case-insensitive: chat operators routinely type lowercase
 *      ("send cole a text", "pull up amber hamby"), and missing
 *      lowercase tokens means the scope-resolver returns zero contacts
 *      and the chat agent falls through to ad-hoc web research even
 *      when the contact is sitting in the workspace.
 *
 * Stop-words pruned to keep noisy hits low.
 */
export function extractCandidateTokens(query: string): string[] {
  const tokens = new Set<string>();
  const quoted = query.match(/"([^"]+)"/g);
  if (quoted) for (const q of quoted) tokens.add(q.replace(/"/g, ""));

  // Pull every word (≥ 3 chars) once — don't let an adjacent regex
  // alternative greedy-grab a multi-word run that would skip the
  // single-word case. Then layer in adjacent pairs whose BOTH words
  // are non-stop. This way "send cole" yields just `cole` (because
  // `send` is a stop verb), and "amber hamby" yields both `amber`,
  // `hamby`, and the pair `amber hamby`.
  //
  // The downstream `ilike` filter is case-insensitive, so feeding it
  // lowercase tokens works as well as capitalized ones.
  const wordRe = /[A-Za-z][A-Za-z'-]{2,}/g;
  const words: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(query)) !== null) words.push(m[0]);

  for (const w of words) {
    if (!STOP_TOKENS.has(w.toLowerCase())) tokens.add(w);
  }
  // Adjacent pairs: only when neither half is a stop word, so action
  // verbs don't anchor a noisy pair onto a real name.
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i]!;
    const b = words[i + 1]!;
    if (STOP_TOKENS.has(a.toLowerCase()) || STOP_TOKENS.has(b.toLowerCase())) {
      continue;
    }
    tokens.add(`${a} ${b}`);
  }
  return [...tokens];
}

// Stop tokens — case-insensitive (matched against `t.toLowerCase()`).
// Two groups: question / preposition fillers that never carry entity
// signal, and action verbs / channel names ("send", "text",
// "whatsapp", …) that DO appear in operator chat but aren't names —
// stripping them cuts spurious org / contact hits on ILIKE matches.
const STOP_TOKENS = new Set([
  // Question / connective words
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
  "into",
  "in",
  "on",
  "to",
  "of",
  "by",
  "as",
  "an",
  // Action verbs the chat agent routinely sees in send / draft commands
  "send",
  "sent",
  "draft",
  "drafts",
  "drafted",
  "call",
  "calls",
  "calling",
  "email",
  "emails",
  "emailed",
  "text",
  "texts",
  "texted",
  "message",
  "messages",
  "messaged",
  "msg",
  "sms",
  "whatsapp",
  "ping",
  "reply",
  "follow",
  "schedule",
  "research",
  "look",
  // Generic test / sample noise
  "test",
  "testing",
  "demo",
  "sample",
  "hello",
  "hey",
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

