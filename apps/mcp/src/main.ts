#!/usr/bin/env node
/**
 * Vex MCP Server.
 *
 * Lets Claude Desktop / ChatGPT desktop / Cursor talk to the Vex API
 * via Model Context Protocol over stdio. Wraps the existing HTTPS
 * surface — no new server-side endpoints — so the same JWT auth +
 * tenant scoping the web app uses applies here.
 *
 * Tools surfaced:
 *   - vex_search                 — unified search (orgs / contacts / deals)
 *   - vex_get_contact            — full contact + memberships + deals
 *   - vex_get_organization       — org detail + contacts + procur metadata
 *   - vex_get_deal               — deal detail
 *   - vex_create_contact         — create + attach to >=1 org
 *   - vex_create_organization    — create org by legal name
 *   - vex_list_followups         — open follow-ups (read-only)
 *
 * T2+ actions (calls / SMS / emails / approvals) are intentionally NOT
 * exposed — those run through the chat agent's approval surface so
 * the MCP can't bypass it.
 *
 * Config (env):
 *   VEX_API_URL    base URL e.g. https://api.vexhq.ai
 *   VEX_API_TOKEN  long-lived JWE bearer (mint via `pnpm mint-token`)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createVexClient } from "./vex-client.js";
import { TOOLS, runTool } from "./tools.js";

async function main(): Promise<void> {
  const apiUrl = process.env["VEX_API_URL"];
  const apiToken = process.env["VEX_API_TOKEN"];
  if (!apiUrl || !apiToken) {
    process.stderr.write(
      "vex-mcp: set VEX_API_URL and VEX_API_TOKEN before launching.\n",
    );
    process.exit(1);
  }

  const vex = createVexClient({ apiUrl, apiToken });
  const server = new Server(
    { name: "vex", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await runTool(vex, req.params.name, req.params.arguments ?? {});
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`vex-mcp fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
