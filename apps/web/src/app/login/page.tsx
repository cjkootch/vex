import { signIn } from "@/auth";
import { VexLogoDatamosh } from "@/components/brand/vex-logo-datamosh";

/**
 * Sign-in splash. A compact datamosh mark sits above the card so
 * the animation reads as a branded heading rather than fighting the
 * form for focus.
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
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-8 text-white">
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        <div className="w-40" aria-hidden>
          <VexLogoDatamosh intensity={0.32} loopDurationMs={7000} />
        </div>

        <div className="w-full rounded-lg border border-line bg-muted/30 p-6 shadow-lg">
          <div className="mb-6 flex flex-col items-center gap-2 text-center">
            <h1 className="text-xl font-semibold">Welcome to Vex</h1>
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
