import { describe, expect, it, vi } from "vitest";
import { ContactEnrichmentAgent } from "./contact-enrichment.js";
import type { AgentContext } from "./types.js";

const TENANT_ID = "01HSEEDWRK0000000000000001";
const CONTACT_ID = "contact_001";
const ORG_ID = "org_001";

interface CapturedWrites {
  patchCalls: Array<{ id: string; patch: Record<string, unknown> }>;
  events: Array<{ verb: string; metadata: Record<string, unknown> }>;
  procurShareCalls: Array<{
    entitySlug: string;
    name: string;
    fields: Record<string, unknown>;
  }>;
}

function makeContext(overrides: {
  contact?: {
    id: string;
    fullName: string;
    title: string | null;
    emails: string[];
    phones: string[];
    orgId: string | null;
    primaryLanguage?: string | null;
  } | null;
  org?: {
    id: string;
    legalName: string;
    domain: string | null;
    geo: unknown;
    externalKeys?: Record<string, string>;
  } | null;
  tavilyResult?:
    | {
        results: Array<{ title: string; url: string; content: string }>;
        answer: string | null;
      }
    | null
    | "throws";
  anthropicResponseText?: string;
  tavilyDisabled?: boolean;
  procurEnabled?: boolean;
  procurShareResult?:
    | { ok: true; data: { contactId: string; status: string } }
    | { ok: false; reason: string; message?: string };
}): { ctx: AgentContext; writes: CapturedWrites } {
  const writes: CapturedWrites = {
    patchCalls: [],
    events: [],
    procurShareCalls: [],
  };

  const contacts = {
    findById: vi.fn().mockResolvedValue(
      overrides.contact === undefined
        ? {
            id: CONTACT_ID,
            fullName: "M. Dupont",
            title: null,
            emails: [],
            phones: [],
            orgId: ORG_ID,
          }
        : overrides.contact,
    ),
    updatePatch: vi.fn().mockImplementation(async (_tx, id, patch) => {
      writes.patchCalls.push({ id, patch });
      return { id, ...patch };
    }),
  };

  const organizations = {
    findById: vi.fn().mockResolvedValue(
      overrides.org === undefined
        ? {
            id: ORG_ID,
            legalName: "Armasuisse",
            domain: "armasuisse.ch",
            geo: { country: "CH" },
            externalKeys: { procur: "armasuisse" },
          }
        : overrides.org,
    ),
  };

  const procur = {
    isEnabled: vi.fn().mockReturnValue(overrides.procurEnabled ?? true),
    shareContactEnrichment: vi.fn().mockImplementation(async (args) => {
      writes.procurShareCalls.push(args);
      return (
        overrides.procurShareResult ?? {
          ok: true,
          data: { contactId: "procur_contact_1", status: "created" },
        }
      );
    }),
  };

  const tavily = overrides.tavilyDisabled
    ? null
    : {
        search: vi.fn().mockImplementation(async () => {
          if (overrides.tavilyResult === "throws") {
            throw new Error("tavily 503");
          }
          return (
            overrides.tavilyResult ?? {
              query: "...",
              answer: "M. Dupont is the procurement officer at Armasuisse.",
              results: [
                {
                  title: "Armasuisse staff directory",
                  url: "https://armasuisse.ch/about",
                  content:
                    "Mathieu Dupont — Procurement Officer. Email: m.dupont@armasuisse.ch",
                },
              ],
            }
          );
        }),
      };

  const anthropic = {
    complete: vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text:
            overrides.anthropicResponseText ??
            JSON.stringify({
              email: {
                value: "m.dupont@armasuisse.ch",
                confidence: 0.9,
                sourceUrl: "https://armasuisse.ch/about",
              },
              title: {
                value: "Procurement Officer",
                confidence: 0.9,
                sourceUrl: "https://armasuisse.ch/about",
              },
              phone: null,
              linkedinUrl: null,
              rationale: "Found on official directory page.",
            }),
        },
      ],
    }),
  };

  const events = {
    insertIfNotExists: vi.fn().mockImplementation(async (_tx, _t, data) => {
      writes.events.push({ verb: data.verb, metadata: data.metadata ?? {} });
      return { event: { id: "evt_1", ...data }, isNew: true };
    }),
  };

  const ctx = {
    tenantId: TENANT_ID,
    workspaceId: TENANT_ID,
    agentRunId: "01HRUN_TEST",
    tx: { __fake: true } as never,
    anthropic: anthropic as never,
    contacts: contacts as never,
    organizations: organizations as never,
    events: events as never,
    tavily: tavily as never,
    procur: procur as never,
    procurCacheTtlDays: 7,
  } as unknown as AgentContext;

  return { ctx, writes };
}

describe("ContactEnrichmentAgent", () => {
  it("happy path: searches Tavily, parses Anthropic JSON, patches contact, emits event", async () => {
    const { ctx, writes } = makeContext({});
    const agent = new ContactEnrichmentAgent({ contactId: CONTACT_ID });

    const out = await agent.run(ctx);

    expect(writes.patchCalls).toHaveLength(1);
    expect(writes.patchCalls[0]?.patch).toMatchObject({
      emails: ["m.dupont@armasuisse.ch"],
      title: "Procurement Officer",
    });
    expect(writes.events).toHaveLength(1);
    expect(writes.events[0]?.verb).toBe("contact.enriched");
    expect(writes.events[0]?.metadata).toMatchObject({
      outcome: "found",
      applied: { emailWritten: true, titleWritten: true, phoneWritten: false },
    });
    expect(out.internalWrites).toBe(2);
    expect(out.outputRefs["contact_id"]).toBe(CONTACT_ID);
  });

  it("skips contact-not-found", async () => {
    const { ctx, writes } = makeContext({ contact: null });
    const agent = new ContactEnrichmentAgent({ contactId: CONTACT_ID });

    const out = await agent.run(ctx);
    expect(out.outputRefs["skipped"]).toBe("contact_not_found");
    expect(writes.patchCalls).toHaveLength(0);
    expect(writes.events).toHaveLength(0);
  });

  it("skips contact that's already fully enriched (email + primary language)", async () => {
    const { ctx, writes } = makeContext({
      contact: {
        id: CONTACT_ID,
        fullName: "M. Dupont",
        title: "Officer",
        emails: ["existing@armasuisse.ch"],
        phones: [],
        orgId: ORG_ID,
        primaryLanguage: "fr",
      },
    });
    const agent = new ContactEnrichmentAgent({ contactId: CONTACT_ID });

    const out = await agent.run(ctx);
    expect(out.outputRefs["skipped"]).toBe("already_enriched");
    expect(writes.patchCalls).toHaveLength(0);
    expect(writes.events).toHaveLength(0);
  });

  it("force=true bypasses the already-enriched guard and re-runs", async () => {
    const { ctx, writes } = makeContext({
      contact: {
        id: CONTACT_ID,
        fullName: "M. Dupont",
        title: "Officer",
        emails: ["existing@armasuisse.ch"],
        phones: [],
        orgId: ORG_ID,
        primaryLanguage: "fr",
      },
      anthropicResponseText: JSON.stringify({
        email: {
          value: "m.dupont@newrole.ch",
          confidence: 0.8,
          sourceUrl: "https://newrole.ch/team",
        },
        title: null,
        phone: null,
        linkedinUrl: null,
        primaryLanguage: null,
        rationale: "Found a current public listing under a new role.",
      }),
    });
    const agent = new ContactEnrichmentAgent({
      contactId: CONTACT_ID,
      force: true,
    });

    const out = await agent.run(ctx);
    // Did NOT short-circuit on "already_enriched" — actually ran.
    expect(out.outputRefs["skipped"]).toBeUndefined();
    // The fresh email was appended to the existing list (emails are
    // additive — the operator can prune later from the contact page).
    expect(writes.patchCalls).toHaveLength(1);
    expect(writes.patchCalls[0]?.patch).toEqual({
      emails: ["existing@armasuisse.ch", "m.dupont@newrole.ch"],
    });
    expect(writes.events[0]?.verb).toBe("contact.enriched");
  });

  it("re-enriches contact with email but no primary_language (one-shot backfill)", async () => {
    const { ctx, writes } = makeContext({
      contact: {
        id: CONTACT_ID,
        fullName: "M. Dupont",
        title: "Procurement Officer",
        emails: ["existing@armasuisse.ch"],
        phones: [],
        orgId: ORG_ID,
        primaryLanguage: null,
      },
      anthropicResponseText: JSON.stringify({
        email: null,
        title: null,
        phone: null,
        linkedinUrl: null,
        primaryLanguage: {
          value: "fr",
          confidence: 0.85,
          sourceUrl: "https://linkedin.com/in/mdupont",
        },
        rationale: "Profile reads in French; based in Switzerland.",
      }),
    });
    const agent = new ContactEnrichmentAgent({ contactId: CONTACT_ID });

    const out = await agent.run(ctx);
    expect(out.outputRefs["skipped"]).toBeUndefined();
    expect(writes.patchCalls).toHaveLength(1);
    expect(writes.patchCalls[0]?.patch).toEqual({ primaryLanguage: "fr" });
    expect(writes.events[0]?.metadata).toMatchObject({
      outcome: "found",
      applied: { primaryLanguageWritten: true },
    });
  });

  it("skips when Tavily is disabled (emits no_signal event)", async () => {
    const { ctx, writes } = makeContext({ tavilyDisabled: true });
    const agent = new ContactEnrichmentAgent({ contactId: CONTACT_ID });

    const out = await agent.run(ctx);
    expect(out.outputRefs["skipped"]).toBe("tavily_disabled");
    expect(writes.patchCalls).toHaveLength(0);
    expect(writes.events[0]?.metadata["outcome"]).toBe("tavily_disabled");
  });

  it("skips when org cannot be found", async () => {
    const { ctx, writes } = makeContext({ org: null });
    const agent = new ContactEnrichmentAgent({ contactId: CONTACT_ID });

    const out = await agent.run(ctx);
    expect(out.outputRefs["skipped"]).toBe("org_not_found");
    expect(writes.patchCalls).toHaveLength(0);
    expect(writes.events[0]?.metadata["outcome"]).toBe("org_not_found");
  });

  it("handles Tavily errors gracefully", async () => {
    const { ctx, writes } = makeContext({ tavilyResult: "throws" });
    const agent = new ContactEnrichmentAgent({ contactId: CONTACT_ID });

    const out = await agent.run(ctx);
    expect(out.outputRefs["skipped"]).toBe("tavily_error");
    expect(writes.patchCalls).toHaveLength(0);
    expect(writes.events[0]?.metadata["outcome"]).toBe("tavily_error");
  });

  it("emits no_signal event when Tavily returns 0 results", async () => {
    const { ctx, writes } = makeContext({
      tavilyResult: { results: [], answer: null },
    });
    const agent = new ContactEnrichmentAgent({ contactId: CONTACT_ID });

    const out = await agent.run(ctx);
    expect(out.outputRefs["skipped"]).toBe("no_results");
    expect(writes.patchCalls).toHaveLength(0);
    expect(writes.events[0]?.metadata["outcome"]).toBe("no_results");
  });

  it("does not write low-confidence extractions to the contact", async () => {
    const { ctx, writes } = makeContext({
      anthropicResponseText: JSON.stringify({
        email: {
          value: "m.dupont@armasuisse.ch",
          confidence: 0.25,
          sourceUrl: null,
        },
        title: null,
        phone: null,
        linkedinUrl: null,
        rationale: "Pattern guess only — no source confirmation.",
      }),
    });
    const agent = new ContactEnrichmentAgent({ contactId: CONTACT_ID });

    const out = await agent.run(ctx);
    expect(writes.patchCalls).toHaveLength(0);
    expect(writes.events[0]?.metadata).toMatchObject({
      outcome: "no_signal",
      applied: { emailWritten: false, titleWritten: false, phoneWritten: false },
    });
    expect(out.internalWrites).toBe(0);
  });

  it("ignores garbage Anthropic responses", async () => {
    const { ctx, writes } = makeContext({
      anthropicResponseText: "I cannot help with that.",
    });
    const agent = new ContactEnrichmentAgent({ contactId: CONTACT_ID });

    const out = await agent.run(ctx);
    expect(out.outputRefs["skipped"]).toBe("parse_error");
    expect(writes.patchCalls).toHaveLength(0);
  });

  it("strips ```json``` code-fence wrappers around the JSON", async () => {
    const { ctx, writes } = makeContext({
      anthropicResponseText:
        "```json\n" +
        JSON.stringify({
          email: {
            value: "m.dupont@armasuisse.ch",
            confidence: 0.9,
            sourceUrl: "https://armasuisse.ch/about",
          },
          title: null,
          phone: null,
          linkedinUrl: null,
          rationale: "Direct directory hit.",
        }) +
        "\n```",
    });
    const agent = new ContactEnrichmentAgent({ contactId: CONTACT_ID });

    const out = await agent.run(ctx);
    expect(writes.patchCalls).toHaveLength(1);
    expect(out.internalWrites).toBe(1);
  });

  it("does not overwrite an existing title", async () => {
    const { ctx, writes } = makeContext({
      contact: {
        id: CONTACT_ID,
        fullName: "M. Dupont",
        title: "Existing Title",
        emails: [],
        phones: [],
        orgId: ORG_ID,
      },
      anthropicResponseText: JSON.stringify({
        email: {
          value: "m.dupont@armasuisse.ch",
          confidence: 0.9,
          sourceUrl: "https://armasuisse.ch",
        },
        title: {
          value: "Different Title",
          confidence: 0.9,
          sourceUrl: "https://other.com",
        },
        phone: null,
        linkedinUrl: null,
        rationale: "Found",
      }),
    });
    const agent = new ContactEnrichmentAgent({ contactId: CONTACT_ID });

    await agent.run(ctx);
    const patch = writes.patchCalls[0]?.patch ?? {};
    expect(patch).toMatchObject({ emails: ["m.dupont@armasuisse.ch"] });
    expect(patch).not.toHaveProperty("title");
  });

  // -------------------------------------------------------------
  // Slice 1.5 — push back to procur
  // -------------------------------------------------------------

  it("shares high-confidence enrichment back to procur when org has external_keys.procur", async () => {
    const { ctx, writes } = makeContext({});
    const agent = new ContactEnrichmentAgent({ contactId: CONTACT_ID });

    const out = await agent.run(ctx);

    expect(writes.procurShareCalls).toHaveLength(1);
    expect(writes.procurShareCalls[0]).toMatchObject({
      entitySlug: "armasuisse",
      name: "M. Dupont",
      fields: expect.objectContaining({
        email: expect.objectContaining({
          value: "m.dupont@armasuisse.ch",
          confidence: 0.9,
        }),
        title: expect.objectContaining({ value: "Procurement Officer" }),
      }),
    });
    expect(out.outputRefs["shared_to_procur"]).toMatchObject({
      ok: true,
      status: "created",
      contactId: "procur_contact_1",
    });
    expect(writes.events[0]?.metadata["shared_to_procur"]).toMatchObject({
      ok: true,
    });
  });

  it("does not share when the org has no external_keys.procur", async () => {
    const { ctx, writes } = makeContext({
      org: {
        id: ORG_ID,
        legalName: "Some Org",
        domain: null,
        geo: null,
        externalKeys: {}, // no procur key
      },
    });
    const agent = new ContactEnrichmentAgent({ contactId: CONTACT_ID });

    const out = await agent.run(ctx);
    expect(writes.procurShareCalls).toHaveLength(0);
    expect(out.outputRefs["shared_to_procur"]).toMatchObject({
      ok: false,
      reason: "org_not_procur_sourced",
    });
  });

  it("does not share when procur is disabled", async () => {
    const { ctx, writes } = makeContext({ procurEnabled: false });
    const agent = new ContactEnrichmentAgent({ contactId: CONTACT_ID });

    const out = await agent.run(ctx);
    expect(writes.procurShareCalls).toHaveLength(0);
    expect(out.outputRefs["shared_to_procur"]).toMatchObject({
      ok: false,
      reason: "procur_disabled",
    });
  });

  it("does not share when no field clears the 0.6 share threshold", async () => {
    // Email applies (0.5 ≥ 0.4 apply threshold) but doesn't share (0.5 < 0.6 share threshold)
    const { ctx, writes } = makeContext({
      anthropicResponseText: JSON.stringify({
        email: {
          value: "m.dupont@armasuisse.ch",
          confidence: 0.5,
          sourceUrl: "https://news.example.com",
        },
        title: null,
        phone: null,
        linkedinUrl: null,
        rationale: "Mid-confidence guess.",
      }),
    });
    const agent = new ContactEnrichmentAgent({ contactId: CONTACT_ID });

    const out = await agent.run(ctx);
    expect(writes.patchCalls).toHaveLength(1); // applied locally
    expect(writes.procurShareCalls).toHaveLength(0); // but not shared
    expect(out.outputRefs["shared_to_procur"]).toMatchObject({
      ok: false,
      reason: "no_high_confidence_fields",
    });
  });

  it("survives a procur share failure (fail-soft)", async () => {
    const { ctx, writes } = makeContext({
      procurShareResult: { ok: false, reason: "exception", message: "fetch failed" },
    });
    const agent = new ContactEnrichmentAgent({ contactId: CONTACT_ID });

    const out = await agent.run(ctx);
    expect(writes.patchCalls).toHaveLength(1); // local enrichment still happened
    expect(out.outputRefs["shared_to_procur"]).toMatchObject({
      ok: false,
      reason: "exception",
      message: "fetch failed",
    });
    expect(out.internalWrites).toBe(2); // email + title written locally despite procur failure
  });

  it("only includes fields that clear the share threshold in the procur payload", async () => {
    // Email at 0.9 (shares), title at 0.5 (applies but doesn't share)
    const { ctx, writes } = makeContext({
      anthropicResponseText: JSON.stringify({
        email: {
          value: "m.dupont@armasuisse.ch",
          confidence: 0.9,
          sourceUrl: "https://armasuisse.ch",
        },
        title: {
          value: "Procurement Officer",
          confidence: 0.5,
          sourceUrl: null,
        },
        phone: null,
        linkedinUrl: null,
        rationale: "High-confidence email, low-confidence title.",
      }),
    });
    const agent = new ContactEnrichmentAgent({ contactId: CONTACT_ID });

    await agent.run(ctx);
    const shared = writes.procurShareCalls[0];
    expect(shared?.fields).toHaveProperty("email");
    expect(shared?.fields).not.toHaveProperty("title");
  });
});
