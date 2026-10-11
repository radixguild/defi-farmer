import { NextResponse } from "next/server";
import { isOriginAllowed, readBodyCapped, validateBackendUrl } from "@/lib/server/proxy-guard";

/**
 * Catch-all proxy for /api/* paths NOT served by a more specific route.
 *
 * Why this exists: the backend is loopback-bound (F4), so the browser cannot
 * reach it directly. This route forwards same-origin /api/* calls to
 * ${BACKEND_API_URL}/api/*, carrying the caller's own credential (the
 * `farmer_session` ROLA cookie) and nothing else. A more specific route file
 * would take precedence over this catch-all; there are none today.
 *
 * Hardening (2026-05-05 audit):
 * - BACKEND_API_URL validated once at module load — non-https in prod and
 *   RFC1918 / loopback / link-local hosts are rejected (SSRF defense).
 * - State-changing methods require Origin allowlist (CSRF defense — without
 *   this, evil.com can fire `fetch("/api/harvest", { method: "POST" })`
 *   against a logged-in dapp tab).
 * - fetch() uses redirect:"manual" so a malicious upstream 3xx Location
 *   cannot bounce credentials to a different origin (SSRF via redirect).
 *
 * This proxy does NOT attach the operator Bearer, deliberately (F10/F14/F17).
 * It used to add it to every state-changing request that passed the Origin
 * check, and to three operator GETs. But an Origin header is CSRF defense, not
 * authentication: `curl -H "Origin: https://<the-dapp>"` sets it freely, so any
 * unauthenticated caller on the internet could POST /api/agent/stop or
 * /api/rotation/:id/approve and have the proxy authorize it for them, and read
 * the full risk posture from /api/config. The 401s the backend returns are the
 * access-control decision — routing around them server-side defeated the tier
 * model the backend carefully implements.
 *
 * Callers now carry their own identity: the `farmer_session` ROLA cookie is
 * forwarded below, and the backend's operator tier accepts a session whose
 * account is in OPERATOR_ADDRESSES (server/src/config.ts). Anonymous callers
 * get the backend's 401, which is the correct answer. Machines that need the
 * Bearer talk to the API directly (it is loopback-bound; use an SSH tunnel).
 */

const BACKEND_VALIDATION = validateBackendUrl(
  process.env.BACKEND_API_URL ?? "http://localhost:3001",
);

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

// The browser's ROLA session cookie is the ONLY cookie forwarded upstream —
// everything else stays on the Next.js origin. This is the caller's identity
// for both the session tier and (via OPERATOR_ADDRESSES) the operator tier.
const SESSION_COOKIE_RE = /(?:^|;\s*)(farmer_session=[a-f0-9]{64})/;

async function forward(req: Request, ctx: RouteContext): Promise<Response> {
  if (!BACKEND_VALIDATION.ok) {
    console.error(`[api proxy] ${BACKEND_VALIDATION.error}`);
    return NextResponse.json({ error: "Server misconfigured" }, { status: 503 });
  }

  // CSRF: only same-origin or explicit allowlist may invoke state-changing
  // methods. GET/HEAD/OPTIONS are safe per HTTP spec (no side effects).
  if (STATE_CHANGING_METHODS.has(req.method) && !isOriginAllowed(req)) {
    return NextResponse.json(
      { error: "Cross-origin request not allowed" },
      { status: 403 },
    );
  }

  const { path } = await ctx.params;
  const backendBase = BACKEND_VALIDATION.url!.toString().replace(/\/$/, "");
  const upstream = `${backendBase}/api/${path
    .map(encodeURIComponent)
    .join("/")}${new URL(req.url).search}`;

  const headers: Record<string, string> = {};
  const ct = req.headers.get("content-type");
  if (ct) headers["Content-Type"] = ct;

  // Forward the ROLA session cookie (and nothing else) so session-tier
  // endpoints see the caller's identity.
  const cookieMatch = req.headers.get("cookie")?.match(SESSION_COOKIE_RE);
  if (cookieMatch) headers.Cookie = cookieMatch[1];

  // Preserve the client IP for backend rate limiting: Caddy sets
  // X-Forwarded-For; the backend honors it only when TRUST_PROXY=true.
  // Without this, every client shares the proxy's loopback bucket.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) headers["X-Forwarded-For"] = xff;

  let bodyText: string | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    // Bounded (DF-6): never buffer more than the backend would accept.
    const body = await readBodyCapped(req);
    if (!body.ok) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
    bodyText = body.text;
  }

  try {
    const res = await fetch(upstream, {
      method: req.method,
      headers,
      body: bodyText,
      redirect: "manual",
    });
    const text = await res.text();
    const responseHeaders: Record<string, string> = {};
    const upstreamCT = res.headers.get("content-type");
    if (upstreamCT) responseHeaders["Content-Type"] = upstreamCT;
    // Pass the session cookie back so /api/auth/verify + logout can set /
    // clear farmer_session in the browser.
    const setCookie = res.headers.get("set-cookie");
    if (setCookie && setCookie.startsWith("farmer_session=")) {
      responseHeaders["Set-Cookie"] = setCookie;
    }
    return new NextResponse(text, { status: res.status, headers: responseHeaders });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Backend unreachable";
    return NextResponse.json(
      { error: `Backend unreachable: ${message}` },
      { status: 502 },
    );
  }
}

export async function GET(req: Request, ctx: RouteContext): Promise<Response> {
  return forward(req, ctx);
}
export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  return forward(req, ctx);
}
export async function PUT(req: Request, ctx: RouteContext): Promise<Response> {
  return forward(req, ctx);
}
export async function DELETE(req: Request, ctx: RouteContext): Promise<Response> {
  return forward(req, ctx);
}
export async function PATCH(req: Request, ctx: RouteContext): Promise<Response> {
  return forward(req, ctx);
}
