import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * This app ships zero Server Actions (the build's server-reference-manifest
 * is empty), but internet scanners probe with a `Next-Action: x` header to
 * fingerprint Next.js. Each probe makes the app-page runtime log a full
 * "Failed to find Server Action" stack trace (the only error class in the
 * server process log since May). No legitimate client sends this header here, so drop
 * the request before it reaches the runtime.
 */
export function middleware(request: NextRequest) {
  if (request.headers.has("next-action")) {
    return new NextResponse(null, { status: 404 });
  }
  return NextResponse.next();
}
