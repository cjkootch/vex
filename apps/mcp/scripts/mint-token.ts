/**
 * Mint a long-lived NextAuth JWE bearer token the MCP server can use
 * to call the Vex API. Reuses the existing JwtAuthGuard path — no new
 * auth surface, no new endpoint.
 *
 * Usage:
 *   AUTH_SECRET=... pnpm --filter @vex/mcp mint-token
 *
 * Optional flags:
 *   --user-id <ulid>       default: SEED user
 *   --tenant-id <ulid>     default: SEED workspace
 *   --workspace-id <ulid>  default: same as tenant-id
 *   --role <owner|admin|member|viewer>   default: owner
 *   --max-age-days <n>     default: 365
 *   --salt <salt>          default: __Secure-authjs.session-token (https/prod)
 *
 * Output is a single line — the bearer token. Pipe to `pbcopy` /
 * `wl-copy` or set directly as VEX_API_TOKEN in your MCP config.
 */
import { encode } from "@auth/core/jwt";

const SEED_WORKSPACE_ID = "01HSEEDWRK0000000000000001";
const SEED_USER_ID = "01HSEEDPRS0000000000000001";

interface Args {
  userId: string;
  tenantId: string;
  workspaceId: string;
  role: "owner" | "admin" | "member" | "viewer";
  maxAgeDays: number;
  salt: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    userId: SEED_USER_ID,
    tenantId: SEED_WORKSPACE_ID,
    workspaceId: SEED_WORKSPACE_ID,
    role: "owner",
    maxAgeDays: 365,
    salt: "__Secure-authjs.session-token",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (!next) continue;
    if (flag === "--user-id") out.userId = next;
    else if (flag === "--tenant-id") {
      out.tenantId = next;
      out.workspaceId = next;
    } else if (flag === "--workspace-id") out.workspaceId = next;
    else if (flag === "--role" && isRole(next)) out.role = next;
    else if (flag === "--max-age-days") out.maxAgeDays = Number(next);
    else if (flag === "--salt") out.salt = next;
  }
  return out;
}

function isRole(s: string): s is Args["role"] {
  return s === "owner" || s === "admin" || s === "member" || s === "viewer";
}

async function main(): Promise<void> {
  const secret = process.env["AUTH_SECRET"] ?? process.env["NEXTAUTH_SECRET"];
  if (!secret) {
    process.stderr.write(
      "mint-token: AUTH_SECRET (or NEXTAUTH_SECRET) is required.\n",
    );
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  const token = await encode({
    token: {
      userId: args.userId,
      tenantId: args.tenantId,
      workspaceId: args.workspaceId,
      role: args.role,
    },
    secret,
    salt: args.salt,
    maxAge: args.maxAgeDays * 24 * 60 * 60,
  });
  process.stdout.write(`${token}\n`);
}

main().catch((err) => {
  process.stderr.write(`mint-token: ${(err as Error).message}\n`);
  process.exit(1);
});
