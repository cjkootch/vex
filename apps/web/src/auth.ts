import NextAuth, { type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";

/**
 * NextAuth.js v5 (Auth.js) — JWT session strategy. The token is the only
 * identity surface the API trusts, so the `jwt` callback is where we
 * stamp the Vex-specific claims (`tenantId`, `workspaceId`, `role`).
 *
 * Production note: the demo `signIn` / `jwt` callbacks below derive the
 * Vex tenant from a hard-coded mapping for the seed workspace. Sprint 4
 * will wire the per-user lookup to the real `users` table via
 * `withTenant` + `UserRepository`.
 */
const SEED_WORKSPACE_ID = "01HSEEDWRK0000000000000001";
const SEED_USER_ID = "01HSEEDPRS0000000000000001";

export const authConfig = {
  trustHost: true,
  session: { strategy: "jwt" },
  providers: [
    Google({
      clientId: process.env["GOOGLE_CLIENT_ID"] ?? "",
      clientSecret: process.env["GOOGLE_CLIENT_SECRET"] ?? "",
    }),
    GitHub({
      clientId: process.env["GITHUB_CLIENT_ID"] ?? "",
      clientSecret: process.env["GITHUB_CLIENT_SECRET"] ?? "",
    }),
  ],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async signIn() {
      // Sprint 3 admits the seed user only. Sprint 4 will look up or create
      // the user in the database (see UserRepository).
      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        token.userId = SEED_USER_ID;
        token.tenantId = SEED_WORKSPACE_ID;
        token.workspaceId = SEED_WORKSPACE_ID;
        token.role = "owner";
      }
      return token;
    },
    async session({ session, token }) {
      session.user = {
        ...session.user,
        id: token.userId,
        tenantId: token.tenantId,
        workspaceId: token.workspaceId,
        role: token.role,
      };
      return session;
    },
  },
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
