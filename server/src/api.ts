/// HTTP API via Bun.serve() for dashboard visibility.
/// Reads DB and agent state. Rate limiter is in-memory (resets on restart).
/// No external router. Security: auth on POST, rate limiting, CORS, input validation.

import { timingSafeEqual } from 'crypto';
import { CONFIG, SNAPSHOT_PAGE } from './config.js';
import { getDb } from './db/schema.js';
import type { AgentLoop } from './agent/loop.js';
import { buildAndPreview, poolInfo, DexBuildError, type DexBuildRequest } from './services/dex/build-service.js';
import { resolvePool } from './services/dex/pool-resolver.js';
import { getPairRisk } from './services/price-feed.js';
import { isStablecoinPair } from './services/pair.js';
import { issueChallenge, verifyAndConsume, type SignedChallenge } from './services/rola.js';
import { recordDeposit, closePosition } from './services/position-recorder.js';
import { readHoldings, isAccountAddress } from './services/holdings.js';
import { readStakeClaims } from './services/dex/venue-exit.js';
import { getValidatorBoard } from './services/validator-board.js';
import { GatewayClient } from './services/gateway.js';
import {
  SESSION_COOKIE,
  createSession,
  deleteSession,
  getSession,
  type Session,
} from './services/sessions.js';

function json(
  data: unknown,
  status = 200,
  corsOrigin?: string,
  extraHeaders?: Record<string, string>,
): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
  if (corsOrigin) {
    headers['Access-Control-Allow-Origin'] = corsOrigin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
  }
  return new Response(JSON.stringify(data), { status, headers });
}

// --- Auth: three tiers (PHASE-3.1-DESIGN D3) ---
//
//   public   — market data, health, ROLA challenge/verify
//   session  — the signed-in wallet's own rows (farmer_session cookie);
//              the operator Bearer also satisfies this tier
//   operator — agent control + global views. Two credentials satisfy it:
//              the Bearer (machines: CLI, ops, SSH tunnel) or a ROLA session
//              whose account is in OPERATOR_ADDRESSES (humans in a browser).
//              The session route exists so the Next proxy never has to attach
//              the Bearer on behalf of an unauthenticated caller (F10/F14/F17).

function checkAuth(req: Request): Response | null {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return json({ error: 'Unauthorized: missing or invalid Bearer token' }, 401);
  }
  const token = authHeader.slice(7);
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(CONFIG.API_AUTH_TOKEN);
  if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
    return json({ error: 'Unauthorized: invalid token' }, 401);
  }
  return null;
}

type Tier = 'public' | 'session' | 'operator';

function getSessionToken(req: Request): string | null {
  const cookie = req.headers.get('cookie');
  if (!cookie) return null;
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]{64})`));
  return m ? m[1] : null;
}

function resolveSession(req: Request): Session | null {
  const token = getSessionToken(req);
  return token ? getSession(token) : null;
}

/// A signed-in wallet that the operator has explicitly allowlisted. Compared
/// against the ROLA-verified address, so it cannot be spoofed by a header.
function isOperatorSession(session: Session | null): boolean {
  if (!session) return false;
  return CONFIG.OPERATOR_ADDRESSES.includes(session.user_address);
}

/// null = allowed; Response = denial to return as-is.
function checkTier(tier: Tier, req: Request, session: Session | null): Response | null {
  if (tier === 'public') return null;
  const operatorOk = checkAuth(req) === null || isOperatorSession(session);
  if (tier === 'operator') {
    return operatorOk
      ? null
      : json({ error: 'Unauthorized: operator credentials required' }, 401);
  }
  // session tier
  if (session || operatorOk) return null;
  return json({ error: 'Authentication required: sign in with your Radix wallet' }, 401);
}

function sessionCookieHeader(token: string, maxAgeSeconds: number): string {
  const secure = CONFIG.SESSION_COOKIE_SECURE ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

/// The client IP for rate limiting, read from X-Forwarded-For.
///
/// Parsed from the RIGHT (REVIEW-2026-07-17 F12). Caddy's reverse_proxy
/// APPENDS the peer address to whatever X-Forwarded-For the client sent, and
/// the Next proxy forwards the header verbatim without adding a hop. So the
/// header arrives as `<anything the client made up>, <real IP as Caddy saw it>`
/// and only the LAST entry is trustworthy. Taking `[0]` — the leftmost — read
/// back the attacker-controlled value: `X-Forwarded-For: 1.2.3.4` minted a
/// fresh rate-limit bucket per request, which is the bypass F12 named.
/// Leftmost parsing is only correct for a proxy that OVERWRITES the header.
///
/// This assumes exactly ONE appending hop (Caddy). Putting a CDN in front adds
/// a hop and this must become "Nth from the right" — the count is load-bearing.
export function clientIpFromXff(req: Request, fallback: string): string {
  const parts = req.headers.get('x-forwarded-for')?.split(',') ?? [];
  // The attacker can prepend entries but can never append past Caddy's.
  const rightmost = parts[parts.length - 1]?.trim();
  return rightmost || fallback;
}

// --- Rate limiter ---

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

// Evict expired rate limit entries every 60 seconds to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now >= entry.resetAt) rateLimitMap.delete(key);
  }
}, 60_000);

/** Clear rate limit state (for testing) */
export function resetRateLimits(): void {
  rateLimitMap.clear();
}

function checkRateLimit(ip: string, method: string): Response | null {
  const limit = method === 'POST' ? CONFIG.RATE_LIMIT_POST_PER_MIN : CONFIG.RATE_LIMIT_GET_PER_MIN;
  const key = `${method}:${ip}`;
  const now = Date.now();

  let entry = rateLimitMap.get(key);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + 60_000 };
    rateLimitMap.set(key, entry);
  }

  entry.count++;
  if (entry.count > limit) {
    return json({ error: 'Too Many Requests' }, 429);
  }
  return null;
}

// --- CORS preflight ---

function handleCors(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': CONFIG.CORS_ORIGIN,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  return null;
}

// --- Route types ---

interface RouteContext {
  url: URL;
  agent: AgentLoop;
  corsOrigin: string;
  req: Request;
  session: Session | null;
}

type RouteHandler = (ctx: RouteContext, params: string[]) => Promise<Response> | Response;

/// The agent status any anonymous caller may see: liveness + counts, never the
/// raw error strings (DF-8). Shared by /api/status and /api/agent/status.
function publicAgentStatus(agent: AgentLoop) {
  const state = agent.getState();
  return {
    running: state.running,
    halted: state.halted,
    lastScan: state.lastScan,
    errorCount: state.errors.length,
    circuitBreaker: state.circuitBreaker,
    pendingTx: state.pendingTx,
  };
}

interface Route {
  method: string;
  pattern: string | RegExp;
  /** Defaults: GET → public, POST → operator (the pre-3.1 behavior). */
  tier?: Tier;
  handler: RouteHandler;
}

function matchRoute(route: Route, method: string, path: string): string[] | null {
  if (route.method !== method) return null;
  if (typeof route.pattern === 'string') {
    return path === route.pattern ? [] : null;
  }
  const m = path.match(route.pattern);
  return m ? m.slice(1) : null;
}

// --- Rotation approve/reject helper ---

function handleRotationStatusChange(
  id: number, newStatus: 'approved' | 'rejected', corsOrigin: string,
): Response {
  if (isNaN(id) || id <= 0) {
    return json({ error: 'Bad Request: rotation id must be a positive integer' }, 400, corsOrigin);
  }
  const db = getDb();
  const row = db.prepare('SELECT * FROM rotation_log WHERE id = ?').get(id) as
    | { status: string }
    | undefined;
  if (!row) return json({ error: 'Rotation not found' }, 404, corsOrigin);
  if (row.status !== 'proposed') {
    return json({ error: `Cannot ${newStatus === 'approved' ? 'approve' : 'reject'} rotation with status: ${row.status}` }, 400, corsOrigin);
  }
  db.prepare(
    'UPDATE rotation_log SET status = ? WHERE id = ?',
  ).run(newStatus, id);
  return json({ success: true, id, status: newStatus }, 200, corsOrigin);
}

// --- Route table ---

const routes: Route[] = [
  // --- ROLA auth (Phase 3.1) ---
  {
    method: 'GET', pattern: '/api/auth/challenge', tier: 'public',
    handler: ({ corsOrigin }) => json(issueChallenge(), 200, corsOrigin),
  },
  {
    method: 'POST', pattern: '/api/auth/verify', tier: 'public',
    handler: async ({ req, corsOrigin }) => {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'Bad Request: body must be valid JSON' }, 400, corsOrigin);
      }
      const signedChallenge = (body as { signedChallenge?: SignedChallenge } | null)?.signedChallenge;
      const result = await verifyAndConsume(signedChallenge as SignedChallenge);
      if (!result.ok) {
        return json({ error: `Authentication failed: ${result.error}` }, 401, corsOrigin);
      }
      const { token, maxAgeSeconds } = createSession(result.address);
      return json({ ok: true, address: result.address }, 200, corsOrigin, {
        'Set-Cookie': sessionCookieHeader(token, maxAgeSeconds),
      });
    },
  },
  {
    method: 'POST', pattern: '/api/auth/logout', tier: 'session',
    handler: ({ req, corsOrigin }) => {
      const token = getSessionToken(req);
      if (token) deleteSession(token);
      return json({ ok: true }, 200, corsOrigin, {
        'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      });
    },
  },
  {
    method: 'GET', pattern: '/api/auth/me', tier: 'session',
    handler: ({ session, corsOrigin }) =>
      json({ address: session?.user_address ?? null }, 200, corsOrigin),
  },

  // GET endpoints (public, no auth required)
  {
    method: 'GET', pattern: '/api/health',
    handler: ({ corsOrigin }) => json({ status: 'ok' }, 200, corsOrigin),
  },
  {
    // PUBLIC (DF-8): the reduced shape only. The raw errors[] carries internal
    // failure text (Gateway URLs/statuses, SQLite paths, upstream messages) —
    // the same recon class F17 moved /api/config off the public tier for. The
    // full state is the operator route /api/agent/state below.
    method: 'GET', pattern: '/api/status',
    handler: ({ agent, corsOrigin }) => json(publicAgentStatus(agent), 200, corsOrigin),
  },
  {
    method: 'GET', pattern: '/api/agent/status',
    handler: ({ agent, corsOrigin }) => json(publicAgentStatus(agent), 200, corsOrigin),
  },
  {
    // Operator tier: the full agent state, incl. errors[] and the
    // persist/prune timestamps (what public /api/status returned before DF-8).
    method: 'GET', pattern: '/api/agent/state', tier: 'operator',
    handler: ({ agent, corsOrigin }) => json(agent.getState(), 200, corsOrigin),
  },
  {
    // Session tier (D4): a signed-in wallet sees ONLY its rows; the operator
    // Bearer (no session cookie) sees everything, incl. the agent's own
    // NULL-owner rows — the pre-3.1 dashboard behavior.
    method: 'GET', pattern: '/api/positions', tier: 'session',
    handler: ({ corsOrigin, session }) => {
      const db = getDb();
      const select = `
        SELECT id, pool_address, protocol,
          pool_address AS pool_name,
          CAST(deposited_amount AS REAL) AS deposited_xrd,
          CAST(COALESCE(current_value, deposited_amount) AS REAL) AS current_value_xrd,
          CAST(COALESCE(apy_bps, 0) AS REAL) / 100.0 AS apy_7d_ma,
          status, deposited_at, receipt_resource, receipt_id, lp_amount, user_address
        FROM positions`;
      const rows = session
        ? db.prepare(`${select} WHERE user_address = ? ORDER BY deposited_at DESC`).all(session.user_address)
        : db.prepare(`${select} ORDER BY deposited_at DESC`).all();
      return json(rows, 200, corsOrigin);
    },
  },
  {
    method: 'POST', pattern: '/api/positions', tier: 'session',
    handler: async ({ req, corsOrigin, session }) => {
      // Recording binds the row to the session identity — the operator token
      // alone has no user to record for.
      if (!session) {
        return json({ error: 'A wallet session is required to record a position' }, 400, corsOrigin);
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'Bad Request: body must be valid JSON' }, 400, corsOrigin);
      }
      const b = (body ?? {}) as { intent_hash?: unknown; pool_address?: unknown };
      const gateway = new GatewayClient();
      const result = await recordDeposit(
        (h) => gateway.getCommittedTransaction(h),
        {
          intentHash: b.intent_hash,
          poolAddress: b.pool_address,
          userAddress: session.user_address,
        },
        (p) => resolvePool(gateway, p),
      );
      if (!result.ok) return json({ error: result.error }, result.status, corsOrigin);
      return json(
        { ok: true, created: result.created, position: result.position },
        result.created ? 201 : 200,
        corsOrigin,
      );
    },
  },
  {
    // Deposit-form driver: resolved pool identity + which inputs the form needs
    // + (concentrated, live-risk) the range optimizer's suggested width.
    // PUBLIC tier: read-only chain + price data.
    method: 'GET', pattern: '/api/dex/pool-info', tier: 'public',
    handler: async ({ url, corsOrigin }) => {
      const address = url.searchParams.get('address') ?? '';
      const db = getDb();
      const scored = db
        .prepare('SELECT apy_ma_7d FROM pool_scores WHERE pool_address = ? ORDER BY computed_at DESC LIMIT 1')
        .get(address) as { apy_ma_7d: number } | undefined;
      try {
        const info = await poolInfo(new GatewayClient(), address, {
          pairRisk: (x, y) => getPairRisk(x, y),
          baseFeeApr: scored?.apy_ma_7d ?? 0,
        });
        return json(info, 200, corsOrigin);
      } catch (err) {
        if (err instanceof DexBuildError) return json({ error: err.message }, 400, corsOrigin);
        console.error(`[api] dex/pool-info error: ${(err as Error).message}`);
        return json({ error: 'Failed to resolve pool (upstream)' }, 502, corsOrigin);
      }
    },
  },
  {
    // Non-custodial deposit/withdraw builder + Gateway preview (the sign-gate).
    // PUBLIC tier: read-only (no DB write, no signing, no custody) — money moves
    // only when the USER signs the returned manifest. resolves the pool's real
    // blueprint at runtime and dry-runs the manifest; returns { manifest, preview,
    // pool, range?, needsCoLiquidity? }. Bounded by the per-IP POST rate limit.
    method: 'POST', pattern: '/api/dex/build', tier: 'public',
    handler: async ({ req, corsOrigin }) => {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'Bad Request: body must be valid JSON' }, 400, corsOrigin);
      }
      if (!body || typeof body !== 'object') {
        return json({ error: 'Bad Request: body must be a JSON object' }, 400, corsOrigin);
      }
      try {
        const result = await buildAndPreview(new GatewayClient(), body as DexBuildRequest);
        return json(result, 200, corsOrigin);
      } catch (err) {
        if (err instanceof DexBuildError) return json({ error: err.message }, 400, corsOrigin);
        console.error(`[api] dex/build error: ${(err as Error).message}`);
        return json({ error: 'Failed to build manifest (upstream)' }, 502, corsOrigin);
      }
    },
  },
  {
    // Verified close — the exit half of D5. The caller claims only
    // (id, intent_hash); ownership and the withdraw itself are verified
    // against the Gateway's committed-details, fail-closed.
    method: 'POST', pattern: /^\/api\/positions\/(\d+)\/close$/, tier: 'session',
    handler: async ({ req, corsOrigin, session }, [id]) => {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'Bad Request: body must be valid JSON' }, 400, corsOrigin);
      }
      const b = (body ?? {}) as { intent_hash?: unknown };
      const gateway = new GatewayClient();
      const result = await closePosition((h) => gateway.getCommittedTransaction(h), {
        positionId: id,
        intentHash: b.intent_hash,
        userAddress: session?.user_address ?? null,
        // The Bearer (or an allowlisted operator wallet) may close any row;
        // verification still runs against the ROW's owner account.
        isOperator: checkAuth(req) === null || isOperatorSession(session),
      });
      if (!result.ok) return json({ error: result.error }, result.status, corsOrigin);
      return json({ ok: true, alreadyClosed: result.alreadyClosed, position: result.position }, 200, corsOrigin);
    },
  },
  {
    // What the ledger says the account holds, classified — the read that the
    // recorded-positions table cannot provide (it only knows deposits made
    // through this app). Session tier: your own account only; the operator
    // may pass ?address= for any account.
    method: 'GET', pattern: '/api/holdings', tier: 'session',
    handler: async ({ url, req, corsOrigin, session }) => {
      const operatorOk = checkAuth(req) === null || isOperatorSession(session);
      const requested = url.searchParams.get('address');
      let account: string | null = null;
      if (requested) {
        if (!isAccountAddress(requested)) {
          return json({ error: 'Invalid account address' }, 400, corsOrigin);
        }
        if (!operatorOk && requested !== session?.user_address) {
          return json({ error: 'Forbidden: you can only read your own holdings' }, 403, corsOrigin);
        }
        account = requested;
      } else {
        account = session?.user_address ?? null;
      }
      if (!account) {
        return json({ error: 'No account: sign in, or pass ?address= with operator credentials' }, 400, corsOrigin);
      }
      try {
        return json(await readHoldings(new GatewayClient(), account), 200, corsOrigin);
      } catch (err) {
        console.error(`[api] holdings error: ${(err as Error).message}`);
        return json({ error: 'Holdings read failed (upstream)' }, 502, corsOrigin);
      }
    },
  },
  {
    // Pending Stake Claim NFTs (the unbonding queue) for an account, with how
    // much each is worth and how long it has left. Without this the claim leg of
    // an unstake is unreachable: a Stake Claim is spent by local id, and nothing
    // else in the app can tell a user what theirs are. Same ownership rules as
    // /api/holdings — your own account, or any account with operator creds.
    // Read-only ledger data; builds and signs nothing.
    method: 'GET', pattern: '/api/holdings/claims', tier: 'session',
    handler: async ({ url, req, corsOrigin, session }) => {
      const operatorOk = checkAuth(req) === null || isOperatorSession(session);
      const requested = url.searchParams.get('address');
      let account: string | null = null;
      if (requested) {
        if (!isAccountAddress(requested)) {
          return json({ error: 'Invalid account address' }, 400, corsOrigin);
        }
        if (!operatorOk && requested !== session?.user_address) {
          return json({ error: 'Forbidden: you can only read your own claims' }, 403, corsOrigin);
        }
        account = requested;
      } else {
        account = session?.user_address ?? null;
      }
      if (!account) {
        return json({ error: 'No account: sign in, or pass ?address= with operator credentials' }, 400, corsOrigin);
      }
      try {
        const claims = await readStakeClaims(new GatewayClient(), account);
        return json({ account, claims }, 200, corsOrigin);
      } catch (err) {
        console.error(`[api] stake claims error: ${(err as Error).message}`);
        return json({ error: 'Stake claim read failed (upstream)' }, 502, corsOrigin);
      }
    },
  },
  {
    // The operator's watch list (accounts that never ROLA-sign in from a
    // browser, e.g. one whose key lives on a server). Config-driven, read-only.
    method: 'GET', pattern: '/api/holdings/watched', tier: 'operator',
    handler: async ({ corsOrigin }) => {
      const gateway = new GatewayClient();
      const results = await Promise.all(
        CONFIG.WATCH_ADDRESSES.map(async (account) => {
          try {
            return await readHoldings(gateway, account);
          } catch (err) {
            // Per-account fail-open: one unreachable account must not blank
            // the rest of the watch list — but it reports as an error row,
            // never as an empty portfolio.
            return { account, error: (err as Error).message };
          }
        }),
      );
      return json({ watched: results }, 200, corsOrigin);
    },
  },
  {
    method: 'GET', pattern: /^\/api\/positions\/(\d+)$/, tier: 'session',
    handler: ({ corsOrigin, session }, [id]) => {
      const db = getDb();
      const row = session
        ? db.prepare('SELECT * FROM positions WHERE id = ? AND user_address = ?')
            .get(parseInt(id, 10), session.user_address)
        : db.prepare('SELECT * FROM positions WHERE id = ?').get(parseInt(id, 10));
      if (!row) return json({ error: 'Position not found' }, 404, corsOrigin);
      return json(row, 200, corsOrigin);
    },
  },
  {
    // The validator board: every registered validator ranked by MEASURED
    // 30-day Δredemption (what it actually paid), with the effective fee
    // beside the lazily-applied one and the zero-payers named. Public:
    // public-ledger data, and the one read this ecosystem does not serve.
    // First hit after cache expiry pays ~32 Gateway calls (~10-20s); the
    // single-flight cache makes everyone else instant for 12h.
    method: 'GET', pattern: '/api/validators', tier: 'public',
    handler: async ({ corsOrigin }) => {
      try {
        return json(await getValidatorBoard(new GatewayClient()), 200, corsOrigin);
      } catch (err) {
        console.error(`[api] validators board error: ${(err as Error).message}`);
        return json({ error: 'Validator board unavailable (upstream)' }, 502, corsOrigin);
      }
    },
  },
  {
    method: 'GET', pattern: '/api/opportunities',
    handler: ({ url, corsOrigin }) => {
      const db = getDb();
      const n = parseInt(url.searchParams.get('n') ?? '50', 10);
      const latest = db
        .prepare('SELECT computed_at FROM pool_scores ORDER BY computed_at DESC LIMIT 1')
        .get() as { computed_at: string } | undefined;
      if (!latest) return json([], 200, corsOrigin);
      const rows = db
        .prepare(`
          SELECT ps.pool_address, ps.protocol,
            COALESCE(ps.pool_name, ps.pool_address) AS pool_name,
            ps.score,
            ps.apy_ma_7d AS apy_7d_ma,
            ps.net_apy_ma_7d, ps.estimated_il, ps.il_risk_score, ps.risk_adjusted_return,
            COALESCE(CAST((SELECT s.tvl FROM pool_snapshots s WHERE s.pool_address = ps.pool_address ORDER BY s.scanned_at DESC LIMIT 1) AS REAL), 0) AS tvl_usd,
            COALESCE(ps.yield_kind, 'amm-lp') AS yield_kind,
            ps.computed_at
          FROM pool_scores ps WHERE ps.computed_at = ?
          -- Rank on risk-adjusted return, not the composite score. Every pool
          -- is net-negative today, so the score's net-APY component clamps to 0
          -- for all of them and the ordering collapsed onto protocol diversity
          -- and a constant audit flag -- which floated a $0-TVL, 0%-yield pool
          -- to position #1.
          ORDER BY ps.risk_adjusted_return DESC LIMIT ?
        `)
        .all(latest.computed_at, n);
      return json(
        (rows as Array<{ pool_name: string }>).map((r) => ({
          ...r,
          is_stable: isStablecoinPair(r.pool_name) ? 1 : 0,
        })),
        200,
        corsOrigin,
      );
    },
  },
  {
    method: 'GET', pattern: /^\/api\/snapshots\/(.+)$/,
    handler: ({ corsOrigin }, [address]) => {
      const db = getDb();
      // Project the frontend PoolSnapshot contract (tvl_usd / apy_7d_ma), not
      // the raw column names (tvl / apy_bps) — the chart reads apy_7d_ma and a
      // raw row would leave it undefined (a .toFixed() crash on the detail page).
      // Most recent SNAPSHOT_PAGE rows, returned OLDEST-FIRST. Two contract
      // details the chart depends on:
      //   - chronological order — Recharts maps array index to x ascending, so
      //     returning newest-first plotted the series right-to-left. The mock
      //     (lib/mocks/snapshots.ts) has always been ascending; the live
      //     endpoint disagreed with it.
      //   - 720, not 168 — the page offers a 30d range (720 hourly points) and
      //     a 168-row cap made "30d" render the same 7 days as "7d".
      // Note the page's slice(-hoursToShow) was NOT dropping rows before this:
      // with <=168 returned it always took the whole array. It only starts
      // selecting a window now that the cap is 720.
      const rows = db
        .prepare(
          `SELECT * FROM (
             SELECT pool_address,
               CAST(tvl AS REAL) AS tvl_usd,
               CAST(COALESCE(apy_bps, 0) AS REAL) / 100.0 AS apy_7d_ma,
               scanned_at
             FROM pool_snapshots WHERE pool_address = ? ORDER BY scanned_at DESC LIMIT ${SNAPSHOT_PAGE}
           ) ORDER BY scanned_at ASC`,
        )
        .all(decodeURIComponent(address));
      return json(rows, 200, corsOrigin);
    },
  },
  {
    // Operator tier: rotation history is bot-portfolio telemetry (D3).
    method: 'GET', pattern: '/api/rotation/log', tier: 'operator',
    handler: ({ corsOrigin }) => {
      const db = getDb();
      const rows = db
        .prepare(`
          SELECT id, from_pool, to_pool, from_protocol, to_protocol,
            CAST(amount AS REAL) AS amount_xrd,
            reason, status, proposed_at
          FROM rotation_log ORDER BY proposed_at DESC LIMIT 100
        `)
        .all();
      return json(rows, 200, corsOrigin);
    },
  },
  {
    method: 'GET', pattern: '/api/rotation/pending', tier: 'operator',
    handler: ({ corsOrigin }) => {
      const db = getDb();
      const rows = db
        .prepare(`
          SELECT id, from_pool, to_pool, from_protocol, to_protocol,
            CAST(amount AS REAL) AS amount_xrd,
            reason, status, proposed_at
          FROM rotation_log WHERE status = 'proposed' ORDER BY proposed_at DESC
        `)
        .all();
      return json(rows, 200, corsOrigin);
    },
  },
  {
    // Operator tier (F17): thresholds/caps/gateway are a recon map once the
    // API is reachable beyond loopback. The dashboard proxy injects the
    // Bearer server-side.
    method: 'GET', pattern: '/api/config', tier: 'operator',
    handler: ({ corsOrigin }) => json({
      NETWORK_ID: CONFIG.NETWORK_ID,
      GATEWAY_URL: CONFIG.GATEWAY_URL,
      SCAN_INTERVAL_MS: CONFIG.SCAN_INTERVAL_MS,
      MIN_REBALANCE_DIFF_BPS: CONFIG.MIN_REBALANCE_DIFF_BPS,
      MAX_SLIPPAGE_BPS: CONFIG.MAX_SLIPPAGE_BPS,
      MAX_GAS_XRD: CONFIG.MAX_GAS_XRD,
      ROTATION_REVIEW_INTERVAL_MS: CONFIG.ROTATION_REVIEW_INTERVAL_MS,
      ROTATION_COOLDOWN_MS: CONFIG.ROTATION_COOLDOWN_MS,
      AUTO_EXECUTE_THRESHOLD_XRD: CONFIG.AUTO_EXECUTE_THRESHOLD_XRD,
      APY_DROP_EXIT_PCT: CONFIG.APY_DROP_EXIT_PCT,
      TVL_DROP_EXIT_PCT: CONFIG.TVL_DROP_EXIT_PCT,
      API_PORT: CONFIG.API_PORT,
      MIN_TVL_THRESHOLD: CONFIG.MIN_TVL_THRESHOLD,
    }, 200, corsOrigin),
  },

  // POST endpoints (auth required — checked in preamble)
  {
    method: 'POST', pattern: '/api/agent/stop',
    handler: ({ agent, corsOrigin }) => {
      agent.halt();
      return json({ success: true, message: 'Agent halted' }, 200, corsOrigin);
    },
  },
  {
    method: 'POST', pattern: '/api/agent/start',
    handler: ({ agent, corsOrigin }) => {
      agent.start();
      return json({ success: true, message: 'Agent started' }, 200, corsOrigin);
    },
  },
  {
    method: 'POST', pattern: /^\/api\/rotation\/(\d+)\/approve$/,
    handler: ({ corsOrigin }, [id]) =>
      handleRotationStatusChange(parseInt(id, 10), 'approved', corsOrigin),
  },
  {
    method: 'POST', pattern: /^\/api\/rotation\/(\d+)\/reject$/,
    handler: ({ corsOrigin }, [id]) =>
      handleRotationStatusChange(parseInt(id, 10), 'rejected', corsOrigin),
  },
];

export function startApi(agent: AgentLoop, port: number = CONFIG.API_PORT): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port,
    // Loopback by default — exposing the API is an explicit operator
    // decision via API_HOST (F4).
    hostname: CONFIG.API_HOST,
    idleTimeout: 30, // seconds — prevents Slowloris (C3)
    async fetch(req, srv) {
      const corsOrigin = CONFIG.CORS_ORIGIN;
      try {
        const url = new URL(req.url);
        const path = url.pathname;
        const method = req.method;

        // CORS preflight
        const corsResponse = handleCors(req);
        if (corsResponse) return corsResponse;

        // Rate limiting — keyed on the socket IP. X-Forwarded-For is only
        // consulted behind an explicit trusted proxy; otherwise a spoofed
        // header would mint unlimited fresh buckets (F12).
        const socketIp = srv.requestIP(req)?.address ?? 'unknown';
        const ip = CONFIG.TRUST_PROXY ? clientIpFromXff(req, socketIp) : socketIp;
        // Auth endpoints share the stricter POST bucket even on GET —
        // challenge issuance must not be floodable at 60/min.
        const rateLimitResponse = checkRateLimit(
          ip,
          path.startsWith('/api/auth/') ? 'POST' : method,
        );
        if (rateLimitResponse) return rateLimitResponse;

        if (method === 'POST') {
          // Payload size cap — reject bodies > 100KB (C3)
          const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
          if (contentLength > 102400) {
            return json({ error: 'Payload too large' }, 413, corsOrigin);
          }
        }

        // Match route, then enforce its tier (D3). POSTs default to the
        // operator tier — identical to the pre-3.1 blanket POST auth.
        const session = resolveSession(req);
        const ctx: RouteContext = { url, agent, corsOrigin, req, session };
        for (const route of routes) {
          const params = matchRoute(route, method, path);
          if (params !== null) {
            const tier = route.tier ?? (route.method === 'POST' ? 'operator' : 'public');
            const denied = checkTier(tier, req, session);
            if (denied) return denied;
            return await route.handler(ctx, params);
          }
        }

        return json({ error: 'Not found' }, 404, corsOrigin);
      } catch (err) {
        console.error(`[api] Unhandled error: ${(err as Error).message}`);
        return json({ error: 'Internal server error' }, 500, corsOrigin);
      }
    },
  });

  console.log(`[api] Listening on http://${CONFIG.API_HOST}:${port}`);
  return server;
}
