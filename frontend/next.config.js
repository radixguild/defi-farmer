/** @type {import('next').NextConfig} */
const nextConfig = {
  // /api/* is fully owned by Next.js route handlers under app/api/.
  // The catch-all at app/api/[...path]/route.ts proxies to ${BACKEND_API_URL},
  // forwarding only the caller's own `farmer_session` cookie. It does NOT
  // attach the operator Bearer (F10/F14/F17) — an Origin header is CSRF
  // defense, not authentication, so browser operators are identified by a
  // ROLA session listed in the backend's OPERATOR_ADDRESSES instead.
  //
  // Set BACKEND_API_URL=http://localhost:3001 (or the deployed backend URL)
  // in .env.local — server-side only, do NOT prefix with NEXT_PUBLIC_.
  async headers() {
    // CSP: lock script and connect targets so a hypothetical XSS can't (a)
    // load attacker scripts, or (b) call sendTransaction with an
    // attacker-controlled manifest by talking to a different origin.
    // connect-src lists exactly what the dApp Toolkit (2.3.0) fetches:
    //   - the dapp's own /api proxy ('self');
    //   - the Radix Gateway (transaction status polling);
    //   - the Radix Connect relay. On mobile the toolkit deep-links to the
    //     wallet app (`radixWallet://connect`, a top-level navigation that
    //     connect-src does not govern) and then POSTs to
    //     https://radix-connect-relay.radixdlt.com/api/v1 to collect the
    //     wallet's encrypted response. Without it the √ Connect button cannot
    //     complete on a phone. The desktop Connector extension talks to the
    //     page through window events and needs no entry here.
    //
    // Next.js App Router today requires 'unsafe-inline' on script for the
    // App Router runtime; nonce-based CSP is supported but fragile. We pick
    // the conservative-but-pragmatic option: 'self' + 'unsafe-inline' for
    // script (defense in depth alongside React auto-escaping + the
    // acknowledge-checkbox sign gate). We can move to nonce-based CSP later.
    const isProd = process.env.NODE_ENV === "production";
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'" + (isProd ? "" : " 'unsafe-eval'"),
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https://mainnet.radixdlt.com https://stokenet.radixdlt.com https://radix-connect-relay.radixdlt.com",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join("; ");
    const baseHeaders = [
      { key: "Content-Security-Policy", value: csp },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Permissions-Policy", value: "geolocation=(), microphone=(), camera=()" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
    ];
    if (isProd) {
      baseHeaders.push({
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains; preload",
      });
    }
    return [
      { source: "/:path*", headers: baseHeaders },
      // The Radix wallet fetches this cross-origin to verify the dApp's
      // two-way link (claimed_websites on-chain <-> this file on the origin).
      // It must be readable from any origin; everything else stays same-origin.
      {
        source: "/.well-known/radix.json",
        headers: [{ key: "Access-Control-Allow-Origin", value: "*" }],
      },
    ];
  },
};

module.exports = nextConfig;
