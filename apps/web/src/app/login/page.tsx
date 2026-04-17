import { signIn } from "@/auth";
import { VexLogoDatamosh } from "@/components/brand/vex-logo-datamosh";

/**
 * Sign-in splash. The datamosh loop lives behind a darkened card so
 * the logo keeps centre stage; buttons follow the same accent-purple
 * affordance used across the app.
 */
export default function LoginPage() {
  async function loginGoogle(): Promise<void> {
    "use server";
    await signIn("google", { redirectTo: "/app" });
  }
  async function loginGithub(): Promise<void> {
    "use server";
    await signIn("github", { redirectTo: "/app" });
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-canvas text-white">
      {/* Datamosh hero — keeps running behind the card, low intensity
          so it feels alive without being loud. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-60"
      >
        <div className="w-[min(90vw,900px)]">
          <VexLogoDatamosh intensity={0.28} loopDurationMs={7000} />
        </div>
      </div>

      {/* Gradient vignette so the form card reads cleanly over the logo. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-canvas/40 via-canvas/10 to-canvas/90"
      />

      <div className="relative z-10 flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-sm rounded-lg border border-line bg-canvas/80 p-6 shadow-xl backdrop-blur-sm">
          <div className="mb-6 flex flex-col items-center gap-3 text-center">
            <h1 className="text-2xl font-semibold">Welcome to Vex</h1>
            <p className="text-sm text-white/60">
              Sign in to pick up where you left off.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <form action={loginGoogle}>
              <button
                type="submit"
                className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent/90"
              >
                Continue with Google
              </button>
            </form>
            <form action={loginGithub}>
              <button
                type="submit"
                className="w-full rounded-md border border-line bg-muted/40 px-3 py-2 text-sm font-medium text-white/90 hover:border-accent hover:text-white"
              >
                Continue with GitHub
              </button>
            </form>
          </div>

          <p className="mt-6 text-center text-xs text-white/40">
            An AI revenue-intelligence analyst.
          </p>
        </div>
      </div>
    </main>
  );
}
