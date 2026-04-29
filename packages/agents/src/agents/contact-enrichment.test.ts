import { describe, expect, it, vi } from "vitest";
import { ContactEnrichmentAgent } from "./contact-enrichment.js";
import type { AgentContext } from "./types.js";

const TENANT_ID = "01HSEEDWRK0000000000000001";
const CONTACT_ID = "contact_001";
const ORG_ID = "org_001";

interface CapturedWrites {
  patchCalls: Array<{ id: string; patch: Record<string, unknown> }>;
  events: Array<{ verb: string; metadata: Record<string, unknown> }>;
}

function makeContext(overrides: {
  contact?: {
    id: string;
    fullName: string;
    title: string | null;
    emails: string[];
    phones: string[];
    orgId: string | null;
  } | null;
  org?: { id: string; legalName: string; domain: string | null; geo: unknown } | null;
  tavilyResult?:
    | {
        results: Array<{ title: string; url: string; content: string }>;
        answer: string | null;
      }
    | null
    | "throws";
  anthropicResponseText?: string;
  tavilyDisabled?: boolean;
}): { ctx: AgentContext; writes: CapturedWrites } {
  const writes: CapturedWrites = { patchCalls: [], events: [] };

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
          }
        : overrides.org,
    ),
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

  it("skips contact that already has emails (idempotent)", async () => {
    const { ctx, writes } = makeContext({
      contact: {
        id: CONTACT_ID,
        fullName: "M. Dupont",
        title: "Officer",
        emails: ["existing@armasuisse.ch"],
        phones: [],
        orgId: ORG_ID,
      },
    });
    const agent = new ContactEnrichmentAgent({ contactId: CONTACT_ID });

    const out = await agent.run(ctx);
    expect(out.outputRefs["skipped"]).toBe("already_has_email");
    expect(writes.patchCalls).toHaveLength(0);
    expect(writes.events).toHaveLength(0);
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
});
