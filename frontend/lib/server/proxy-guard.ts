/**
 * Server-side guards for the /api/* proxy routes.
 *
 * Two attack classes these defend against. (Note: since F10/F14/F17 the proxy
 * no longer injects an operator Bearer — it forwards the caller's own
 * farmer_session cookie and request. Both guards remain necessary; the threat
 * is now "act as the logged-in user" rather than "borrow the operator token".)
 *
 * 1. CSRF — the proxy forwards the caller's farmer_session cookie server-side.
 *    A user who has the dapp loaded in another tab while visiting evil.com
 *    would see evil.com fire a cross-origin POST (`/api/harvest`, etc.); the
 *    Origin allowlist is the primary block (SameSite=Lax already withholds the
 *    cookie on cross-site subrequests — this is defense in depth on top). The
 *    Same-Origin Policy blocks evil.com from READING the response, but a
 *    state-changing side effect would already have executed. Mitigation:
 *    require the Origin header to be in an explicit allowlist OR be the same
 *    origin as the request URL.
 *
 * 2. SSRF — `BACKEND_API_URL` is read from env at startup. An operator
 *    misconfiguration to `http://169.254.169.254` (cloud metadata),
 *    `http://localhost:25` (SMTP), or any RFC1918 internal address would
 *    cause the proxy to forward requests (with the caller's cookie) to those
 *    services. Mitigation: validate the URL once at module load; reject
 *    non-https in production and any private/loopback ranges.
 */

const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local / cloud metadata
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
  /^::1$/,
  /^\[::1\]$/,
];

export interface BackendUrlValidation {
  ok: boolean;
  url?: URL;
  error?: string;
}

export function validateBackendUrl(raw: string | undefined): BackendUrlValidation {
  if (!raw) {
    return { ok: false, error: "BACKEND_API_URL is not set" };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: `BACKEND_API_URL is not a valid URL: ${raw}` };
  }
  const isProd = process.env.NODE_ENV === "production";
  const hostRaw = parsed.hostname;
  const isLoopbackHost =
    /^localhost$/i.test(hostRaw) || /^127\./.test(hostRaw) || hostRaw === "::1" || hostRaw === "[::1]";
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: `BACKEND_API_URL must be http(s), got ${parsed.protocol}` };
  }
  // https required in production — except plain-http loopback (opted in
  // below), which never leaves the box.
  if (isProd && parsed.protocol !== "https:" && !isLoopbackHost) {
    return { ok: false, error: "BACKEND_API_URL must be https in production" };
  }
  // Allow private hosts only in development — in production a private-range
  // backend would be an SSRF foothold... EXCEPT the standard single-box
  // deployment (Caddy → Next :3008 → backend 127.0.0.1:<port>), where
  // loopback IS the design (the backend binds loopback on purpose, F4).
  // That topology opts in explicitly with ALLOW_LOOPBACK_BACKEND=true;
  // non-loopback private ranges (RFC1918, link-local metadata) stay
  // rejected unconditionally.
  if (isProd) {
    const host = parsed.hostname;
    const isLoopback = isLoopbackHost;
    if (isLoopback) {
      if (process.env.ALLOW_LOOPBACK_BACKEND !== "true") {
        return {
          ok: false,
          error: `BACKEND_API_URL is loopback (${host}) — set ALLOW_LOOPBACK_BACKEND=true if the backend runs on this box`,
        };
      }
    } else {
      for (const pattern of PRIVATE_HOST_PATTERNS) {
        if (pattern.test(host)) {
          return { ok: false, error: `BACKEND_API_URL points to a private range: ${host}` };
        }
      }
    }
  }
  // http (non-https) loopback in prod is fine — it never leaves the box.
  return { ok: true, url: parsed };
}

/**
 * Returns true iff the request's Origin header is acceptable for a
 * state-changing call. Same-origin (request URL host matches Origin) is
 * always allowed; cross-origin must appear in `ALLOWED_ORIGINS` (comma-
 * separated env var). Browsers always send Origin on POST/PUT/DELETE
 * (and on cross-origin GETs from `fetch`).
 *
 * Returns true for missing-Origin same-host requests too, for tools like
 * curl during local dev — but ONLY when NODE_ENV !== "production".
 */
export function isOriginAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  const reqUrl = new URL(req.url);

  if (!origin) {
    // Browsers send Origin on cross-origin AND on same-origin POSTs (Chrome
    // 76+, Firefox 70+). Missing Origin is a bot/curl/server-side caller.
    // Accept in dev, reject in prod.
    return process.env.NODE_ENV !== "production";
  }

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }

  // Same-origin = same host AND port AND protocol.
  if (
    originUrl.host === reqUrl.host &&
    originUrl.protocol === reqUrl.protocol
  ) {
    return true;
  }

  // Cross-origin: must be in the explicit allowlist.
  const allowed = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

/**
 * Body cap for the proxy (DF-6). The backend refuses bodies over 100 KB, but
 * only AFTER this process has buffered the whole thing — so concurrent
 * multi-MB POSTs could exhaust the Next app's memory before any 413. Same cap
 * as the backend (server/src/api.ts), enforced here before and while reading.
 */
export const MAX_PROXY_BODY_BYTES = 102_400;

export type CappedBody = { ok: true; text: string } | { ok: false; reason: "too_large" };

/**
 * Read a request body, refusing — by name — once it exceeds `max` bytes. A
 * declared Content-Length over the cap is refused without reading; a body
 * without one (chunked) is streamed and the read is cancelled at the cap.
 */
export async function readBodyCapped(
  req: Request,
  max: number = MAX_PROXY_BODY_BYTES,
): Promise<CappedBody> {
  const declared = req.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= max)) {
    return { ok: false, reason: "too_large" };
  }
  if (!req.body) return { ok: true, text: "" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return { ok: false, reason: "too_large" };
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(buf) };
}
