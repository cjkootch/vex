import { redirect } from "next/navigation";

/**
 * Root → `/app`. The real experience lives behind auth; the middleware
 * on `/app` will redirect unauthenticated visitors to `/login`.
 */
export default function Home(): never {
  redirect("/app");
}
