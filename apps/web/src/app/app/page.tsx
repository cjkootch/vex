import { auth } from "@/auth";

/**
 * Authenticated landing page. Middleware redirects unauthenticated users
 * to /login before this renders.
 */
export default async function AppHome() {
  const session = await auth();
  return (
    <main style={{ padding: 32, fontFamily: "system-ui, sans-serif" }}>
      <h1>Vex</h1>
      {session?.user ? (
        <>
          <p>Signed in as {session.user.email}</p>
          <p>Tenant: {session.user.tenantId}</p>
          <p>Role: {session.user.role}</p>
        </>
      ) : (
        <p>Not signed in.</p>
      )}
    </main>
  );
}
