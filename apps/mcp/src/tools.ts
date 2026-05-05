import { z } from "zod";
import type { VexClient } from "./vex-client.js";

/**
 * Tool definitions surfaced over MCP. Each `inputSchema` follows the
 * JSON Schema subset MCP clients use to render the tool. Keep these
 * tight — vague schemas lead to hallucinated args.
 */
export const TOOLS = [
  {
    name: "vex_search",
    description:
      "Unified search across organizations, contacts, and deals. Returns up to `limit` matches.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Free-text query." },
        limit: { type: "number", description: "Max results, default 8." },
      },
      required: ["query"],
    },
  },
  {
    name: "vex_get_contact",
    description: "Fetch a single contact with memberships and related deals.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Contact ULID." },
      },
      required: ["id"],
    },
  },
  {
    name: "vex_get_organization",
    description:
      "Fetch organization detail: contacts, deals, notes, procur metadata.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Organization ULID." },
      },
      required: ["id"],
    },
  },
  {
    name: "vex_get_deal",
    description: "Fetch deal detail: vessel, ports, scenarios, status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Deal ULID." },
      },
      required: ["id"],
    },
  },
  {
    name: "vex_create_contact",
    description:
      "Create a contact and attach it to one or more organizations. The first org is primary unless `isPrimary` is set explicitly.",
    inputSchema: {
      type: "object" as const,
      properties: {
        fullName: { type: "string" },
        title: { type: "string" },
        emails: { type: "array", items: { type: "string" } },
        phones: { type: "array", items: { type: "string" } },
        timezone: { type: "string" },
        orgs: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              orgId: { type: "string" },
              role: { type: "string" },
              isPrimary: { type: "boolean" },
            },
            required: ["orgId"],
          },
        },
      },
      required: ["fullName", "orgs"],
    },
  },
  {
    name: "vex_create_organization",
    description: "Create an organization by legal name.",
    inputSchema: {
      type: "object" as const,
      properties: {
        legalName: { type: "string" },
        domain: { type: "string" },
        industry: { type: "string" },
      },
      required: ["legalName"],
    },
  },
  {
    name: "vex_list_followups",
    description: "List open follow-ups (read-only).",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["open", "completed", "cancelled"],
          description: "Default 'open'.",
        },
      },
    },
  },
];

const SearchArgs = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
});

const IdArgs = z.object({ id: z.string().min(1) });

const CreateContactArgs = z.object({
  fullName: z.string().min(1),
  title: z.string().optional(),
  emails: z.array(z.string()).optional(),
  phones: z.array(z.string()).optional(),
  timezone: z.string().optional(),
  orgs: z
    .array(
      z.object({
        orgId: z.string().min(1),
        role: z.string().optional(),
        isPrimary: z.boolean().optional(),
      }),
    )
    .min(1),
});

const CreateOrganizationArgs = z.object({
  legalName: z.string().min(1),
  domain: z.string().optional(),
  industry: z.string().optional(),
});

const FollowUpsArgs = z.object({
  status: z.enum(["open", "completed", "cancelled"]).optional(),
});

export async function runTool(
  vex: VexClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "vex_search": {
      const parsed = SearchArgs.parse(args);
      return vex.get("/search", { q: parsed.query, limit: parsed.limit ?? 8 });
    }
    case "vex_get_contact":
      return vex.get(`/contacts/${IdArgs.parse(args).id}`);
    case "vex_get_organization":
      return vex.get(`/organizations/${IdArgs.parse(args).id}`);
    case "vex_get_deal":
      return vex.get(`/deals/${IdArgs.parse(args).id}`);
    case "vex_create_contact":
      return vex.post("/contacts", CreateContactArgs.parse(args));
    case "vex_create_organization":
      return vex.post("/organizations", CreateOrganizationArgs.parse(args));
    case "vex_list_followups": {
      const parsed = FollowUpsArgs.parse(args);
      return vex.get("/follow-ups", { status: parsed.status ?? "open" });
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
