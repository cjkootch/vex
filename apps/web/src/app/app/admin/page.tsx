import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { AdminConsole } from "@/components/admin/admin-console";

/**
 * /app/admin — OWNER-only workspace settings, health, cost, evals,
 * rollouts. Server component: resolves the session, hands off to the
 * client console when role=owner, renders a denied state otherwise.
 */
export default async function AdminPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const role = session.user.role ?? "member";
  if (role !== "owner") return <DeniedState />;
  return <AdminConsole />;
}

function DeniedState() {
  return (
    <main className="mx-auto max-w-xl space-y-4 px-8 py-20 text-center text-white">
      <h1 className="text-xl font-semibold">Admin console</h1>
      <p className="text-sm text-white/60">
        This page is restricted to workspace owners. Ask an owner to grant
        you the <code className="font-mono text-white/80">owner</code> role
        if you need access.
      </p>
      <Link
        href="/app"
        className="inline-block rounded-md border border-line bg-muted/40 px-4 py-2 text-sm text-white/80 transition hover:border-white/30 hover:text-white"
      >
        Back to brief →
      </Link>
    </main>
  );
}
