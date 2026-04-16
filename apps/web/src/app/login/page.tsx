import { signIn } from "@/auth";

/**
 * Minimal login page. Server actions invoke `signIn` with the chosen
 * provider; NextAuth handles the OAuth round-trip.
 */
export default function LoginPage() {
  async function loginGoogle() {
    "use server";
    await signIn("google", { redirectTo: "/app" });
  }
  async function loginGithub() {
    "use server";
    await signIn("github", { redirectTo: "/app" });
  }

  return (
    <main style={{ padding: 32, fontFamily: "system-ui, sans-serif", maxWidth: 360 }}>
      <h1>Sign in to Vex</h1>
      <p>Use a provider to continue.</p>
      <form action={loginGoogle}>
        <button type="submit">Continue with Google</button>
      </form>
      <form action={loginGithub} style={{ marginTop: 12 }}>
        <button type="submit">Continue with GitHub</button>
      </form>
    </main>
  );
}
