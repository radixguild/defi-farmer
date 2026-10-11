/// Central config — all env vars validated on first access, fail closed.
/// Uses lazy initialization so test modules can load without env vars.

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

/// Rows /api/snapshots returns — the chart's widest range, 30 days of hourly
/// points. Lives here (not in api.ts) because retention is derived from it.
export const SNAPSHOT_PAGE = 720;

/// The longest snapshot lookback anywhere in the code, in days.
///
/// The time-predicated readers only go back 7 days (scorer.computeApyMa7d,
/// scorer.computeTvlVariance, caviarnine's APY estimate), but /api/snapshots
/// reads SNAPSHOT_PAGE ROWS, which at hourly cadence is a 30-day window — so
/// retention below 30 would silently shorten the dashboard's "30d" chart to
/// the retention length, re-creating the bug the 720-row cap just fixed.
export const MIN_RETENTION_DAYS = SNAPSHOT_PAGE / 24;

/// Refuse absurd retention: SQLite returns NULL from datetime('now', '-N days')
/// once N leaves the julian range, which makes every prune a silent no-op —
/// unbounded growth, no error, no log line.
export const MAX_RETENTION_DAYS = 3650;

/// Per-kind env vars that EXTEND the verified pool-package allowlist (DF-1).
/// The resolver only accepts a pool whose blueprint name AND package address
/// both match a pinned pair; the addresses recorded in docs/DEX-INTEGRATION.md
/// are the defaults (pool-resolver.ts VERIFIED_POOL_PACKAGES). A kind with no
/// recorded package and no env entry resolves every pool as 'unsupported'
/// (fail closed) — set its var to the package address(es) verified on mainnet,
/// comma-separated.
export const DEX_PACKAGE_ENV = {
  ociswap_basic: 'DEX_PACKAGES_OCISWAP_BASIC',
  ociswap_precision: 'DEX_PACKAGES_OCISWAP_PRECISION',
  caviarnine_weighted: 'DEX_PACKAGES_CAVIARNINE_WEIGHTED',
  caviarnine_quantaswap: 'DEX_PACKAGES_CAVIARNINE_QUANTASWAP',
  defiplaza_pair: 'DEX_PACKAGES_DEFIPLAZA_PAIR',
} as const;
export type PinnedPoolKind = keyof typeof DEX_PACKAGE_ENV;

const PACKAGE_RE = /^package_rdx1[a-z0-9]{6,120}$/;

/// Parse the DEX_PACKAGES_* vars. Unset/empty = no extra pins for that kind.
/// A malformed entry throws by name — a typo must not silently pin nothing
/// (or, worse, be read as "allow").
export function parseDexPackagePins(
  env: Record<string, string | undefined>,
): Record<PinnedPoolKind, string[]> {
  const out = {} as Record<PinnedPoolKind, string[]>;
  for (const [kind, key] of Object.entries(DEX_PACKAGE_ENV) as [PinnedPoolKind, string][]) {
    const list = (env[key] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const p of list) {
      if (!PACKAGE_RE.test(p)) {
        throw new Error(`Invalid ${key}: '${p}' is not a mainnet package_rdx1… address`);
      }
    }
    out[kind] = list;
  }
  return out;
}

function buildConfig() {
  const cfg = {
    // Network
    NETWORK_ID: parseInt(optionalEnv('RADIX_NETWORK_ID', '1'), 10), // 1 = mainnet, 2 = stokenet
    GATEWAY_URL: optionalEnv('GATEWAY_URL', 'https://mainnet.radixdlt.com'),

    // Non-custodial (2026-07-18): no signing key, no vault. The agent is an
    // advisor — it scans/scores and surfaces proposals; the USER signs every
    // manifest in their own wallet, so BOT_PRIVATE_KEY / BOT_ACCOUNT /
    // VAULT_COMPONENT / ADMIN_BADGE / POOL_COMPONENT no longer exist.

    // Gas shown to the user + used by the rebalance net-benefit gate.
    MAX_GAS_XRD: optionalEnv('MAX_GAS_XRD', '10'),

    // Agent settings
    SCAN_INTERVAL_MS: parseInt(optionalEnv('SCAN_INTERVAL_MS', '60000'), 10),
    // How often scan results are PERSISTED to pool_snapshots / pool_scores.
    // Scanning and scoring still run every SCAN_INTERVAL_MS — only the writes
    // are throttled. Every reader assumes hourly rows: the snapshots endpoint
    // pages by 168/720 (7d/30d of hours) and the 7d MA wants ~168 points, so
    // persisting per-minute grew both tables ~60x faster than anything read
    // them and made the charts render 168 MINUTES as "7 days".
    SNAPSHOT_INTERVAL_MS: parseInt(optionalEnv('SNAPSHOT_INTERVAL_MS', '3600000'), 10),
    // Rows older than this are pruned daily. MUST stay above the longest
    // lookback in the code (scorer + caviarnine both read 7 days).
    SNAPSHOT_RETENTION_DAYS: parseInt(optionalEnv('SNAPSHOT_RETENTION_DAYS', '30'), 10),
    MIN_REBALANCE_DIFF_BPS: parseInt(optionalEnv('MIN_REBALANCE_DIFF_BPS', '200'), 10), // 2%
    MAX_SLIPPAGE_BPS: parseInt(optionalEnv('MAX_SLIPPAGE_BPS', '50'), 10), // 0.5%

    // Rotation (proposals only — never auto-executed)
    ROTATION_REVIEW_INTERVAL_MS: parseInt(optionalEnv('ROTATION_REVIEW_INTERVAL_MS', '604800000'), 10), // 7 days
    ROTATION_COOLDOWN_MS: parseInt(optionalEnv('ROTATION_COOLDOWN_MS', '259200000'), 10), // 3 days
    // Above this XRD size a rotation proposal is flagged as needing explicit
    // approval in the UI (informational — nothing auto-signs).
    AUTO_EXECUTE_THRESHOLD_XRD: optionalEnv('AUTO_EXECUTE_THRESHOLD_XRD', '5000'),

    // Exit guards
    APY_DROP_EXIT_PCT: parseInt(optionalEnv('APY_DROP_EXIT_PCT', '30'), 10),
    TVL_DROP_EXIT_PCT: parseInt(optionalEnv('TVL_DROP_EXIT_PCT', '40'), 10),

    // API
    API_PORT: parseInt(optionalEnv('API_PORT', '3001'), 10),
    // Bun.serve binds 0.0.0.0 when no hostname is given — loopback must be
    // the default; exposing the API is an explicit operator decision (F4).
    API_HOST: optionalEnv('API_HOST', '127.0.0.1'),
    API_AUTH_TOKEN: requireEnv('API_AUTH_TOKEN'),
    // Operator identity for browser callers (F10/F14/F17). The Bearer stays a
    // machine credential (CLI/ops/tunnel); a ROLA-signed-in wallet whose
    // account is listed here ALSO satisfies the operator tier. That is what
    // lets the Next proxy stop handing the Bearer to unauthenticated callers:
    // before this existed, the proxy attached it to any state-changing request
    // with a plausible Origin header, so anyone on the internet could stop the
    // agent or approve a rotation. Empty = no session is ever an operator
    // (fail closed); set it on the VPS to use the dashboard's operator panels.
    OPERATOR_ADDRESSES: optionalEnv('OPERATOR_ADDRESSES', '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean),
    // Read-only watch list for GET /api/holdings/watched (operator tier).
    // Exists for accounts that never ROLA-sign in from a browser (for example
    // an account whose key lives on a server). Watching an address grants
    // nothing but visibility: holdings are a public-ledger read.
    WATCH_ADDRESSES: optionalEnv('WATCH_ADDRESSES', '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean),
    CORS_ORIGIN: optionalEnv('CORS_ORIGIN', 'http://localhost:5173'),
    // Only trust X-Forwarded-For when explicitly fronted by a proxy (Caddy).
    // Off = rate-limit on the socket IP; a spoofed header must not mint
    // fresh rate-limit buckets (F12).
    TRUST_PROXY: optionalEnv('TRUST_PROXY', 'false') === 'true',

    // ROLA auth (Phase 3.1). Defaults match the frontend's fallbacks; the
    // wallet-signed proof binds to (dApp definition, origin, network), so
    // these MUST equal what the connected frontend uses.
    // The "DeFi Farmer" dApp definition: a dedicated on-chain identity account
    // that holds no user funds. It must equal the copies in
    // frontend/public/.well-known/radix.json and frontend/lib/radix-provider.tsx;
    // frontend/tests/dapp-definition.test.ts fails CI if the three drift.
    DAPP_DEFINITION_ADDRESS: optionalEnv(
      'DAPP_DEFINITION_ADDRESS',
      'account_rdx12yp8wps97gzj9w6fq022xzdcw540qettg39neumev7mla6k9lggfna',
    ),
    ROLA_EXPECTED_ORIGIN: optionalEnv('ROLA_EXPECTED_ORIGIN', 'http://localhost:3000'),
    // Set true behind HTTPS (Caddy) — marks the session cookie Secure.
    SESSION_COOKIE_SECURE: optionalEnv('SESSION_COOKIE_SECURE', 'false') === 'true',

    // Rate limiting
    RATE_LIMIT_POST_PER_MIN: parseInt(optionalEnv('RATE_LIMIT_POST_PER_MIN', '10'), 10),
    RATE_LIMIT_GET_PER_MIN: parseInt(optionalEnv('RATE_LIMIT_GET_PER_MIN', '60'), 10),

    // Circuit breaker
    CIRCUIT_BREAKER_THRESHOLD: parseInt(optionalEnv('CIRCUIT_BREAKER_THRESHOLD', '5'), 10),
    CIRCUIT_BREAKER_WINDOW_MS: parseInt(optionalEnv('CIRCUIT_BREAKER_WINDOW_MS', '600000'), 10),

    // Database
    DB_PATH: optionalEnv('DB_PATH', './data/defi-farmer.db'),

    // Safety
    MIN_TVL_THRESHOLD: optionalEnv('MIN_TVL_THRESHOLD', '1000000'), // $1M

    /// Dust floor for the ranked opportunity index, in USD.
    ///
    /// Widening the Ociswap scan past page 1 surfaced pools holding $1–$110,
    /// whose reported APR is noise: one small swap against a $4 pool annualises
    /// to a huge number. Ranked by yield they went straight to the top of
    /// Discover — "+31.73%" on a $110 pool — which is exactly the kind of
    /// number this app must not put in front of a user. They are also not
    /// investable: a $100 deposit into a $110 pool is most of the pool.
    ///
    /// Applied only when TVL is KNOWN and positive. A pool reporting 0 has an
    /// unreadable balance (DefiPlaza pairs hold reserves in child pools), which
    /// is a different condition and is not treated as dust.
    MIN_POOL_TVL_USD: optionalEnv('MIN_POOL_TVL_USD', '1000'),

    // Platform fee (monetization Stream C). Phase 0 = OFF (both empty). When set,
    // the fee is spliced into the user-signed deposit manifest → the treasury
    // COMPONENT (try_deposit_or_abort) and shown transparently in the preview.
    // Server policy only — never caller-supplied. docs/MONETIZATION.md.
    PLATFORM_FEE_RATE: optionalEnv('PLATFORM_FEE_RATE', ''), // e.g. '0.0015' = 0.15%
    PLATFORM_FEE_COMPONENT: optionalEnv('PLATFORM_FEE_COMPONENT', ''),

    // Extra verified DEX pool packages per kind (DF-1) — see DEX_PACKAGE_ENV.
    DEX_PACKAGE_PINS: parseDexPackagePins(process.env),

  } as const;

  // Validate numeric configs at build time (C4, H1)
  if (isNaN(cfg.MAX_SLIPPAGE_BPS) || cfg.MAX_SLIPPAGE_BPS < 1) {
    throw new Error(
      `Invalid MAX_SLIPPAGE_BPS: must be a positive integer, got '${optionalEnv('MAX_SLIPPAGE_BPS', '50')}'`
    );
  }

  // Retention must outlive the longest read window or pruning silently
  // degrades what the app shows. Bounded on BOTH sides: too small starves the
  // scorer and shortens the 30d chart; too large overflows SQLite's julian
  // range so datetime('now', '-N days') returns NULL and prune quietly stops.
  if (
    isNaN(cfg.SNAPSHOT_RETENTION_DAYS) ||
    cfg.SNAPSHOT_RETENTION_DAYS < MIN_RETENTION_DAYS ||
    cfg.SNAPSHOT_RETENTION_DAYS > MAX_RETENTION_DAYS
  ) {
    throw new Error(
      `Invalid SNAPSHOT_RETENTION_DAYS: must be an integer in [${MIN_RETENTION_DAYS}, ${MAX_RETENTION_DAYS}], got '${optionalEnv('SNAPSHOT_RETENTION_DAYS', '30')}'`
    );
  }
  if (isNaN(cfg.SNAPSHOT_INTERVAL_MS) || cfg.SNAPSHOT_INTERVAL_MS < 0) {
    throw new Error(
      `Invalid SNAPSHOT_INTERVAL_MS: must be a non-negative integer, got '${optionalEnv('SNAPSHOT_INTERVAL_MS', '3600000')}'`
    );
  }

  // MAX_GAS_XRD is the gas figure shown to the user and fed to the rotation
  // net-benefit gate (api.ts, rotation.ts). It is NOT interpolated into the
  // built manifests, which carry no lock_fee at all: the wallet locks the
  // fee itself at signing (dex/rtm.ts optionalLockFee).
  // Still validated strictly — a 2026-04 post-mortem in a sibling project
  // (MAX_SLIPPAGE_BPS=0 silent failure) showed a garbage value here poisons
  // the gate's arithmetic. Same class of bug.
  const gasRaw = optionalEnv('MAX_GAS_XRD', '10');
  const gasNum = parseFloat(gasRaw);
  if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(gasRaw) || !isFinite(gasNum) || gasNum < 1) {
    throw new Error(
      `Invalid MAX_GAS_XRD: must be a positive decimal >= 1 (no scientific notation), got '${gasRaw}'`,
    );
  }

  return cfg;
}

type Config = ReturnType<typeof buildConfig>;
let _config: Config | null = null;

/** Lazy CONFIG — validated on first property access, not at import time. */
export const CONFIG: Config = new Proxy({} as Config, {
  get(_target, prop: string | symbol) {
    if (!_config) _config = buildConfig();
    return (_config as Record<string | symbol, unknown>)[prop];
  },
});
