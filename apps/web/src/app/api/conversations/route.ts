import { NextResponse } from "next/server";

/**
 * Sprint-5 stub. Conversations live in the client (local state) for the
 * MVP — Sprint 6 will wire them to a Postgres-backed table. This route
 * returns an empty list so the UI can hit `/api/conversations` without
 * a 404 during dev.
 */
export async function GET(): Promise<Response> {
  return NextResponse.json({ conversations: [] });
}
