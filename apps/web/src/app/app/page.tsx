import Link from "next/link";
import { auth } from "@/auth";

/**
 * Authenticated landing page. Shows who you're signed in as and links to
 * the two live surfaces (chat + approvals). Middleware redirects
 * unauthenticated users to /login before this renders.
 */
export default async function AppHome() {
  const session = await auth();
  const email = session?.user?.email ?? "unknown";
  const role = session?.user?.role ?? "member";

  return (
    <main className="min-h-screen bg-canvas text-white">
      <div className="mx-auto max-w-3xl px-8 py-16">
        <header className="mb-10 flex items-baseline justify-between">
          <h1 className="text-3xl font-semibold tracking-tight">Vex</h1>
          <span className="text-sm text-white/50">
            {email} · {role}
          </span>
        </header>

        <p className="mb-10 text-white/70">
          Welcome back. Pick a surface to jump into.
        </p>

        <nav className="grid gap-4 sm:grid-cols-2">
          <Link
            href="/app/chat"
            className="group rounded-lg border border-line bg-muted/40 p-6 transition hover:border-white/30 hover:bg-muted/60"
          >
            <h2 className="text-lg font-semibold">Chat</h2>
            <p className="mt-1 text-sm text-white/60">
              Ask Vex anything. Streams a manifest canvas with evidence.
            </p>
            <span className="mt-4 inline-block text-sm text-white/40 group-hover:text-white/70">
              Open chat →
            </span>
          </Link>

          <Link
            href="/app/voice"
            className="group rounded-lg border border-line bg-muted/40 p-6 transition hover:border-white/30 hover:bg-muted/60"
          >
            <h2 className="text-lg font-semibold">Voice</h2>
            <p className="mt-1 text-sm text-white/60">
              Talk to Vex live in the browser. Transcripts summarise and surface action items.
            </p>
            <span className="mt-4 inline-block text-sm text-white/40 group-hover:text-white/70">
              Start a call →
            </span>
          </Link>

          <Link
            href="/app/approvals"
            className="group rounded-lg border border-line bg-muted/40 p-6 transition hover:border-white/30 hover:bg-muted/60"
          >
            <h2 className="text-lg font-semibold">Approvals</h2>
            <p className="mt-1 text-sm text-white/60">
              Review and approve or reject outbound actions proposed by agents.
            </p>
            <span className="mt-4 inline-block text-sm text-white/40 group-hover:text-white/70">
              Open inbox →
            </span>
          </Link>
        </nav>
      </div>
    </main>
  );
}
