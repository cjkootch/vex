import { NextResponse } from "next/server";
import { auth } from "@/auth";

/**
 * Protect everything under /app except /app/login. Public routes:
 *   - / (marketing)
 *   - /login
 *   - /api/health
 *   - /api/webhooks/*
 *   - /api/auth/* (NextAuth handlers)
 */
export default auth((req) => {
  const { pathname } = req.nextUrl;

  if (
    pathname === "/" ||
    pathname === "/login" ||
    pathname === "/app/login" ||
    pathname.startsWith("/api/health") ||
    pathname.startsWith("/api/webhooks") ||
    pathname.startsWith("/api/auth")
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
