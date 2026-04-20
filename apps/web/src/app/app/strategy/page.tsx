import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { StrategyConsole } from "@/components/strategy/strategy-console";

/**
 * /app/strategy — OWNER-only workspace strategy. The saved strategy is
 * injected into every chat system prompt so Vex's answers, drafts, and
 * proposed actions are conditioned on the tenant's company context.
 */
export default async function StrategyPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const role = session.user.role ?? "member";
  if (role !== "owner") return <DeniedState />;
  return <StrategyConsole />;
}

function DeniedState() {
  return (
    <main className="mx-auto max-w-xl space-y-4 px-8 py-20 text-center text-white">
      <h1 className="text-xl font-semibold">Strategy</h1>
      <p className="text-sm text-white/60">
        Strategy authoring is restricted to workspace owners because
        edits reshape every chat response and every proposed action
        for the whole workspace. Ask an owner to grant you the{" "}
        <code className="font-mono text-white/80">owner</code> role if
        you need to edit.
      </p>
      <Link
        href="/app"
        className="inline-block rounded-md border border-line bg-muted/40 px-4 py-2 text-sm text-white/80 transition hover:border-white/30 hover:text-white"
      >
        Back to Brief
      </Link>
    </main>
  );
}
