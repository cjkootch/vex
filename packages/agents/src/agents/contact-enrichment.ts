import { TenantId } from "@vex/domain";
import type { Contact, Organization } from "@vex/db";
import type {
  ContactEnrichmentFields,
  TavilySearchResult,
} from "@vex/integrations";
import { CONTACT_ENRICHMENT_SYSTEM_PROMPT } from "../prompts/contact-enrichment.js";
import type { AgentContext, AgentOutput, IAgent } from "./types.js";

export interface ContactEnrichmentAgentInput {
  contactId: string;
  /**
   * When true, skip the "already enriched" idempotency guard so the
   * agent always hits Tavily + Anthropic. Used by the chat-driven
   * `contact.enrich` re-enrichment flow — the operator explicitly
   * asked for a fresh pass so the auto-skip on rows that already
   * have an email + primary language would defeat the request.
   * Default false; ingest-driven runs leave it unset so re-clicks
   * stay free.
   */
  force?: boolean;
}

interface ExtractedField {
  value: string;
  confidence: number;
  sourceUrl: string | null;
}

interface ExtractionResult {
  email: ExtractedField | null;
  title: ExtractedField | null;
  phone: ExtractedField | null;
  linkedinUrl: ExtractedField | null;
  /**
   * ISO 639-1 (e.g. "en", "es"). Inferred from public signals and used
   * by the chat agent to default `lang` on email drafts. Display-only;
   * stored on `contacts.primary_language`.
   */
  primaryLanguage: ExtractedField | null;
  rationale: string;
}

const TAVILY_MAX_RESULTS = 5;
const ANTHROPIC_MAX_TOKENS = 800;
/** Below this we don't trust the extraction enough to write to the contact row. */
const MIN_CONFIDENCE_TO_APPLY = 0.4;
/**
 * Higher bar for pushing back to procur — we only share fields we'd
 * stake our name on. Pattern-guess emails (~0.4) stay vex-side; verified
 * scrapes (~0.6+) close the loop so procur's entity graph stays fresh.
 */
const MIN_CONFIDENCE_TO_SHARE = 0.6;

/**
 * T1 web-research agent. Given a contact id, searches the public web
 * for the person + their organization, asks Anthropic to extract
 * structured contact info from the results (email, title, phone,
 * LinkedIn), and patches the contact row when confidence ≥ 0.4.
 *
 * Idempotent: re-running on a contact that already has emails skips
 * the network calls and returns immediately. The ingest path enqueues
 * one of these per newly-created contact, so duplicates from procur
 * pushes don't burn LLM credit.
 *
 * Fail-soft: when Tavily isn't configured, or returns no results, or
 * Anthropic returns nonsense, we skip and emit a `contact.enriched`
 * event with `outcome=no_signal` so downstream surfaces (operator UI,
 * batch-summary tools) can still count this contact as "processed".
 */
export class ContactEnrichmentAgent implements IAgent {
  readonly name = "contact_enrichment";
  readonly tier = "T1" as const;

  constructor(private readonly input: ContactEnrichmentAgentInput) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const contact = await ctx.contacts.findById(ctx.tx, this.input.contactId);
    if (!contact) {
      return {
        costUsd: 0,
        outputRefs: { skipped: "contact_not_found" },
        proposedActions: [],
        internalWrites: 0,
        rationale: `contact ${this.input.contactId} not in scope`,
      };
    }

    // Re-run guard: skip only when the row is fully enriched. We
    // gained `primary_language` in v1.1; existing rows that have an
    // email but no language should still get a one-shot pass to fill
    // it in. Once both fields are present we're done.
    //
    // `input.force` bypasses the guard for chat-driven re-enrichment
    // (operator explicitly asked for a fresh pass). Ingest-driven
    // runs leave force unset so re-clicks stay free.
    if (
      !this.input.force &&
      (contact.emails ?? []).length > 0 &&
      contact.primaryLanguage
    ) {
      return {
        costUsd: 0,
        outputRefs: { skipped: "already_enriched", contact_id: contact.id },
        proposedActions: [],
        internalWrites: 0,
        rationale: "contact already has emails + primary language",
      };
    }

    if (!ctx.tavily) {
      await this.emitNoSignalEvent(ctx, contact, "tavily_disabled");
      return {
        costUsd: 0,
        outputRefs: { skipped: "tavily_disabled", contact_id: contact.id },
        proposedActions: [],
        internalWrites: 0,
        rationale: "TAVILY_API_KEY unset; web research unavailable",
      };
    }

    const org = contact.orgId
      ? await ctx.organizations.findById(ctx.tx, contact.orgId)
      : null;
    if (!org) {
      await this.emitNoSignalEvent(ctx, contact, "org_not_found");
      return {
        costUsd: 0,
        outputRefs: { skipped: "org_not_found", contact_id: contact.id },
        proposedActions: [],
        internalWrites: 0,
        rationale: "contact has no org; cannot disambiguate web search",
      };
    }

    const query = buildSearchQuery(contact, org);
    let results: TavilySearchResult[] = [];
    let tavilyAnswer: string | null = null;
    try {
      const search = await ctx.tavily.search(query, {
        depth: "basic",
        maxResults: TAVILY_MAX_RESULTS,
        includeAnswer: true,
      });
      results = search.results;
      tavilyAnswer = search.answer;
    } catch (err) {
      await this.emitNoSignalEvent(ctx, contact, "tavily_error", {
        message: (err as Error).message,
      });
      return {
        costUsd: 0,
        outputRefs: {
          skipped: "tavily_error",
          contact_id: contact.id,
          error: (err as Error).message,
        },
        proposedActions: [],
        internalWrites: 0,
        rationale: `tavily search failed: ${(err as Error).message}`,
      };
    }

    if (results.length === 0) {
      await this.emitNoSignalEvent(ctx, contact, "no_results");
      return {
        costUsd: 0,
        outputRefs: { skipped: "no_results", contact_id: contact.id },
        proposedActions: [],
        internalWrites: 0,
        rationale: "tavily returned 0 results",
      };
    }

    const userMessage = buildUserMessage(contact, org, results, tavilyAnswer);
    const completion = await ctx.anthropic.complete({
      tenantId: TenantId(ctx.tenantId),
      idempotencyKey: `contact_enrichment:${ctx.agentRunId}`,
      messages: [{ role: "user", content: userMessage }],
      system: CONTACT_ENRICHMENT_SYSTEM_PROMPT,
      maxTokens: ANTHROPIC_MAX_TOKENS,
    });

    const responseText = extractText(completion);
    const extraction = parseExtraction(responseText);
    if (!extraction) {
      await this.emitNoSignalEvent(ctx, contact, "parse_error", {
        raw_response: responseText.slice(0, 500),
      });
      return {
        costUsd: 0,
        outputRefs: {
          skipped: "parse_error",
          contact_id: contact.id,
        },
        proposedActions: [],
        internalWrites: 0,
        rationale: "anthropic response not valid JSON",
      };
    }

    const applied = await this.applyToContact(ctx, contact, extraction);

    // Slice 1.5 — push the discovery back to procur when (a) the org
    // came from procur originally and (b) we have at least one
    // confidence-≥-0.6 field. Fail-soft: a failed share doesn't fail
    // the agent run; we just log + record on the event.
    const shared = await this.maybeShareToProcur(ctx, org, contact, extraction);

    await ctx.events.insertIfNotExists(ctx.tx, ctx.tenantId, {
      verb: "contact.enriched",
      subjectType: "contact",
      subjectId: contact.id,
      actorType: "agent",
      actorId: "contact_enrichment",
      occurredAt: new Date(),
      idempotencyKey: `contact_enrichment:${ctx.agentRunId}:enriched`,
      metadata: {
        contact_id: contact.id,
        org_id: org.id,
        outcome:
          applied.emailWritten ||
          applied.titleWritten ||
          applied.phoneWritten ||
          applied.primaryLanguageWritten
            ? "found"
            : "no_signal",
        extracted: {
          email: extraction.email,
          title: extraction.title,
          phone: extraction.phone,
          linkedin_url: extraction.linkedinUrl,
          primary_language: extraction.primaryLanguage,
        },
        applied,
        shared_to_procur: shared,
        rationale: extraction.rationale,
      },
    });

    return {
      costUsd: 0, // anthropic.complete() records cost to the ledger directly
      outputRefs: {
        contact_id: contact.id,
        org_id: org.id,
        applied,
        shared_to_procur: shared,
        extraction_rationale: extraction.rationale,
      },
      proposedActions: [],
      internalWrites:
        (applied.emailWritten ? 1 : 0) +
        (applied.titleWritten ? 1 : 0) +
        (applied.phoneWritten ? 1 : 0) +
        (applied.primaryLanguageWritten ? 1 : 0),
      rationale: applied.emailWritten
        ? `enriched: email found (confidence ${extraction.email?.confidence ?? 0})`
        : `no enrichment applied: ${extraction.rationale}`,
    };
  }

  private async maybeShareToProcur(
    ctx: AgentContext,
    org: Organization,
    contact: Contact,
    extraction: ExtractionResult,
  ): Promise<
    | { ok: true; status: string; contactId: string }
    | { ok: false; reason: string; message?: string }
  > {
    const procurSlug = (org.externalKeys as Record<string, string> | null)?.[
      "procur"
    ];
    if (!procurSlug) {
      return { ok: false, reason: "org_not_procur_sourced" };
    }
    if (!ctx.procur.isEnabled()) {
      return { ok: false, reason: "procur_disabled" };
    }
    const fields: ContactEnrichmentFields = {};
    if (
      extraction.email &&
      extraction.email.confidence >= MIN_CONFIDENCE_TO_SHARE
    ) {
      fields.email = extraction.email;
    }
    if (
      extraction.title &&
      extraction.title.confidence >= MIN_CONFIDENCE_TO_SHARE
    ) {
      fields.title = extraction.title;
    }
    if (
      extraction.phone &&
      extraction.phone.confidence >= MIN_CONFIDENCE_TO_SHARE
    ) {
      fields.phone = extraction.phone;
    }
    if (
      extraction.linkedinUrl &&
      extraction.linkedinUrl.confidence >= MIN_CONFIDENCE_TO_SHARE
    ) {
      fields.linkedinUrl = extraction.linkedinUrl;
    }
    if (Object.keys(fields).length === 0) {
      return { ok: false, reason: "no_high_confidence_fields" };
    }
    const result = await ctx.procur.shareContactEnrichment({
      entitySlug: procurSlug,
      name: contact.fullName,
      fields,
    });
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        ...(result.message ? { message: result.message } : {}),
      };
    }
    return {
      ok: true,
      status: result.data.status,
      contactId: result.data.contactId,
    };
  }

  private async emitNoSignalEvent(
    ctx: AgentContext,
    contact: Contact,
    outcome: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    await ctx.events.insertIfNotExists(ctx.tx, ctx.tenantId, {
      verb: "contact.enriched",
      subjectType: "contact",
      subjectId: contact.id,
      actorType: "agent",
      actorId: "contact_enrichment",
      occurredAt: new Date(),
      idempotencyKey: `contact_enrichment:${ctx.agentRunId}:no_signal`,
      metadata: {
        contact_id: contact.id,
        outcome,
        ...(extra ?? {}),
      },
    });
  }

  private async applyToContact(
    ctx: AgentContext,
    contact: Contact,
    extraction: ExtractionResult,
  ): Promise<{
    emailWritten: boolean;
    titleWritten: boolean;
    phoneWritten: boolean;
    primaryLanguageWritten: boolean;
  }> {
    const patch: {
      emails?: string[];
      phones?: string[];
      title?: string | null;
      primaryLanguage?: string | null;
    } = {};
    let emailWritten = false;
    let titleWritten = false;
    let phoneWritten = false;
    let primaryLanguageWritten = false;

    if (
      extraction.email &&
      extraction.email.confidence >= MIN_CONFIDENCE_TO_APPLY
    ) {
      patch.emails = [...(contact.emails ?? []), extraction.email.value];
      emailWritten = true;
    }
    if (
      extraction.phone &&
      extraction.phone.confidence >= MIN_CONFIDENCE_TO_APPLY
    ) {
      patch.phones = [...(contact.phones ?? []), extraction.phone.value];
      phoneWritten = true;
    }
    if (
      !contact.title &&
      extraction.title &&
      extraction.title.confidence >= MIN_CONFIDENCE_TO_APPLY
    ) {
      patch.title = extraction.title.value;
      titleWritten = true;
    }
    // Only fill primary_language when it's empty — operators may have
    // hand-corrected it in chat, and we don't want enrichment to
    // overwrite that on a re-run.
    if (
      !contact.primaryLanguage &&
      extraction.primaryLanguage &&
      extraction.primaryLanguage.confidence >= MIN_CONFIDENCE_TO_APPLY
    ) {
      patch.primaryLanguage = extraction.primaryLanguage.value;
      primaryLanguageWritten = true;
    }

    if (emailWritten || phoneWritten || titleWritten || primaryLanguageWritten) {
      await ctx.contacts.updatePatch(ctx.tx, contact.id, patch);
    }

    return { emailWritten, titleWritten, phoneWritten, primaryLanguageWritten };
  }
}

function buildSearchQuery(contact: Contact, org: Organization): string {
  // The doubled quotes around name + org name push Tavily towards
  // exact-phrase matches; "email contact" raises pages that publish
  // staff directories vs random press mentions.
  const name = `"${contact.fullName}"`;
  const orgName = `"${org.legalName}"`;
  return `${name} ${orgName} email contact`;
}

function buildUserMessage(
  contact: Contact,
  org: Organization,
  results: TavilySearchResult[],
  tavilyAnswer: string | null,
): string {
  const orgGeo = (org.geo as { country?: string } | null)?.country;
  const orgLine = `${org.legalName}${orgGeo ? ` (${orgGeo})` : ""}${org.domain ? ` — ${org.domain}` : ""}`;
  const lines: string[] = [
    `Person: ${contact.fullName}${contact.title ? ` (currently listed as ${contact.title})` : ""}`,
    `Organization: ${orgLine}`,
    "",
    "Search results:",
  ];
  if (tavilyAnswer) {
    lines.push(`Tavily summary: ${tavilyAnswer}`, "");
  }
  for (const [i, r] of results.entries()) {
    lines.push(
      `--- Result ${i + 1} ---`,
      `URL: ${r.url}`,
      `Title: ${r.title}`,
      `Excerpt: ${r.content.slice(0, 800)}`,
      "",
    );
  }
  lines.push(
    "Extract the contact info per the system prompt schema. JSON only, no other text.",
  );
  return lines.join("\n");
}

function extractText(message: { content: unknown }): string {
  const content = message.content;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      return block.text;
    }
  }
  return "";
}

function parseExtraction(raw: string): ExtractionResult | null {
  if (!raw) return null;
  // Models occasionally wrap JSON in code fences despite instructions.
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(raw);
  const candidate = fenceMatch?.[1] ?? raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  return {
    email: parseField(obj["email"]),
    title: parseField(obj["title"]),
    phone: parseField(obj["phone"]),
    linkedinUrl: parseField(obj["linkedinUrl"]),
    primaryLanguage: parseLanguageField(obj["primaryLanguage"]),
    rationale:
      typeof obj["rationale"] === "string" ? obj["rationale"] : "(no rationale)",
  };
}

function parseField(raw: unknown): ExtractedField | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const value = obj["value"];
  const confidence = obj["confidence"];
  const sourceUrl = obj["sourceUrl"];
  if (typeof value !== "string" || !value.trim()) return null;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  return {
    value: value.trim(),
    confidence,
    sourceUrl: typeof sourceUrl === "string" ? sourceUrl : null,
  };
}

/**
 * Same shape as parseField but normalizes the value to a 2-letter
 * lowercase ISO 639-1 code. Anything that isn't 2 ASCII letters
 * (`"english"`, `"zh-CN"`, `""`) is rejected so we don't write junk
 * into `contacts.primary_language`.
 */
function parseLanguageField(raw: unknown): ExtractedField | null {
  const field = parseField(raw);
  if (!field) return null;
  const code = field.value.toLowerCase();
  if (!/^[a-z]{2}$/.test(code)) return null;
  return { ...field, value: code };
}
