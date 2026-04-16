import { NextResponse } from "next/server";
import { auth } from "@/auth";

const PLAYWRIGHT = process.env["PLAYWRIGHT"] === "1";

/**
 * Protect everything under /app except /app/login. Public routes:
 *   - / (marketing)
 *   - /login
 *   - /api/health
 *   - /api/webhooks/*
 *   - /api/auth/* (NextAuth handlers)
 *   - everything when PLAYWRIGHT=1 — local-only escape hatch so e2e tests
 *     can drive the chat UI without an OAuth round-trip
 */
export default auth((req) => {
  const { pathname } = req.nextUrl;

  if (PLAYWRIGHT) return NextResponse.next();

  if (
    pathname === "/" ||
    pathname === "/login" ||
    pathname === "/app/login" ||
    pathname.startsWith("/api/health") ||
    pathname.startsWith("/api/webhooks") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/query") ||
    pathname.startsWith("/api/conversations")
  ) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/app") && !req.auth) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("from", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
});

/**
 * Skip Next internals and static assets — runs middleware on everything
 * else, including server actions.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico)).*)"],
};
