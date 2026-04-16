/**
 * Vex JWT claims. Both apps/web (which signs the token via NextAuth) and
 * apps/api (which verifies it) speak the same shape.
 */
export interface VexJwt {
  userId: string;
  tenantId: string;
  workspaceId: string;
  role: "owner" | "admin" | "member" | "viewer";
  email?: string;
  name?: string | null;
  iat?: number;
  exp?: number;
}

/**
 * Augment Fastify's Request type so controllers can read `req.user`. Nest
 * relies on `Reflect`-style property assignment by the guard.
 */
declare module "fastify" {
  interface FastifyRequest {
    user?: VexJwt;
  }
}
