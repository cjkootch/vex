import "next-auth";
import "next-auth/jwt";

/**
 * Augmentations to NextAuth's `Session` and `JWT` so the rest of the app
 * sees the Vex-specific claims (tenant, workspace, role) directly.
 */
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      image?: string | null;
      tenantId: string;
      workspaceId: string;
      role: "owner" | "admin" | "member" | "viewer";
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId: string;
    tenantId: string;
    workspaceId: string;
    role: "owner" | "admin" | "member" | "viewer";
  }
}
