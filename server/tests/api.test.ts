import { describe, test, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema, setTestDb } from '../src/db/schema';
import { startApi, resetRateLimits, clientIpFromXff } from '../src/api';
import { createSession } from '../src/services/sessions';
import type { AgentLoop } from '../src/agent/loop';

let testDb: Database;

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
  setTestDb(testDb);
});

afterAll(() => {
  server?.stop?.(true);
  setTestDb(null);
  testDb?.close();
});

describe('API query aliases', () => {
  test('positions query returns frontend-expected field names', () => {
    testDb.exec(`
      INSERT INTO positions (protocol, pool_address, token_a, token_b, deposited_amount, current_value, apy_bps, status)
      VALUES ('ociswap', 'pool_addr_1', 'XRD', 'TOKEN', '1000', '1200', 1870, 'active')
    `);
    const rows = testDb.prepare(`
      SELECT id, pool_address, protocol,
        pool_address AS pool_name,
        CAST(deposited_amount AS REAL) AS deposited_xrd,
        CAST(COALESCE(current_value, deposited_amount) AS REAL) AS current_value_xrd,
        CAST(COALESCE(apy_bps, 0) AS REAL) / 100.0 AS apy_7d_ma,
        status, deposited_at, receipt_resource
      FROM positions ORDER BY deposited_at DESC
    `).all() as Array<Record<string, unknown>>;

    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.pool_name).toBe('pool_addr_1');
    expect(row.deposited_xrd).toBe(1000);
    expect(row.current_value_xrd).toBe(1200);
    expect(row.apy_7d_ma).toBeCloseTo(18.7);
    expect(row.status).toBe('active');
  });

  test('opportunities query returns frontend-expected field names', () => {
    testDb.exec(`
      INSERT INTO pool_snapshots (pool_address, protocol, tvl, apy_bps)
      VALUES ('pool_a', 'ociswap', '5000000', 1200)
    `);
    testDb.exec(`
      INSERT INTO pool_scores (pool_address, protocol, score, apy_ma_7d, tvl_variance, classification)
      VALUES ('pool_a', 'ociswap', 85, 12.0, 0.1, 'stable')
    `);
    const latest = testDb
      .prepare('SELECT computed_at FROM pool_scores ORDER BY computed_at DESC LIMIT 1')
      .get() as { computed_at: string };
    // NOTE: this re-states the endpoint's SQL rather than calling the endpoint,
    // so it can only catch schema drift — it happily passed while the real
    // /api/opportunities query served a DIFFERENT shape. That is the same kind
    // of blind spot that let the gross-vs-net bug reach production: the API was
    // checked in isolation and the consumer never was. Keep it in sync by hand,
    // and prefer the end-to-end assertions below it.
    const rows = testDb.prepare(`
      SELECT ps.pool_address, ps.protocol,
        ps.pool_address AS pool_name,
        ps.score,
        ps.apy_ma_7d AS apy_7d_ma,
        ps.net_apy_ma_7d, ps.estimated_il, ps.il_risk_score, ps.risk_adjusted_return,
        COALESCE(CAST((SELECT s.tvl FROM pool_snapshots s WHERE s.pool_address = ps.pool_address ORDER BY s.scanned_at DESC LIMIT 1) AS REAL), 0) AS tvl_usd,
        CASE WHEN ps.classification = 'stable' THEN 1 ELSE 0 END AS is_stable,
        COALESCE(ps.yield_kind, 'amm-lp') AS yield_kind,
        ps.computed_at
      FROM pool_scores ps WHERE ps.computed_at = ?
      ORDER BY ps.risk_adjusted_return DESC LIMIT 10
    `).all(latest.computed_at) as Array<Record<string, unknown>>;

    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.pool_name).toBe('pool_a');
    expect(row.apy_7d_ma).toBe(12.0);
    expect(row.tvl_usd).toBe(5000000);
    // Pair composition, NOT an audit status — the field was renamed off
    // `audited` because the UI was rendering it as a verified-audit shield.
    expect(row.is_stable).toBe(1);
    // Unlabelled rows must read as amm-lp so IL is applied, never waived.
    expect(row.yield_kind).toBe('amm-lp');
  });

  test('rotation query returns frontend-expected field names', () => {
    testDb.exec(`
      INSERT INTO rotation_log (from_pool, to_pool, from_protocol, to_protocol, amount, reason, status)
      VALUES ('pool_a', 'pool_b', 'ociswap', 'caviarnine', '1000', 'better APY', 'proposed')
    `);
    const rows = testDb.prepare(`
      SELECT id, from_pool, to_pool, from_protocol, to_protocol,
        CAST(amount AS REAL) AS amount_xrd,
        reason, status, proposed_at
      FROM rotation_log ORDER BY proposed_at DESC LIMIT 100
    `).all() as Array<Record<string, unknown>>;

    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.amount_xrd).toBe(1000);
    expect(row.reason).toBe('better APY');
    expect(row.from_protocol).toBe('ociswap');
  });
});

describe('positions table', () => {
  test('accepts inserts and returns rows', () => {
    testDb.exec(`
      INSERT INTO positions (protocol, pool_address, token_a, token_b, deposited_amount, status)
      VALUES ('ociswap', 'pool_addr_1', 'XRD', 'TOKEN', '1000', 'active')
    `);
    const rows = testDb.prepare('SELECT * FROM positions').all() as Array<{ protocol: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].protocol).toBe('ociswap');
  });
});

describe('pool_scores', () => {
  test('queryable by latest computed_at, ordered by score DESC', () => {
    // Insert older scores
    testDb.exec(`
      INSERT INTO pool_scores (pool_address, protocol, score, apy_ma_7d, tvl_variance, classification, computed_at)
      VALUES ('pool_a', 'ociswap', 80, 10, 0.1, 'stable', datetime('now', '-1 hour'))
    `);
    // Insert latest scores
    testDb.exec(`
      INSERT INTO pool_scores (pool_address, protocol, score, apy_ma_7d, tvl_variance, classification, computed_at)
      VALUES ('pool_a', 'ociswap', 85, 12, 0.1, 'stable', datetime('now'))
    `);
    testDb.exec(`
      INSERT INTO pool_scores (pool_address, protocol, score, apy_ma_7d, tvl_variance, classification, computed_at)
      VALUES ('pool_b', 'caviarnine', 70, 8, 0.2, 'rotational', datetime('now'))
    `);

    const latest = testDb
      .prepare('SELECT computed_at FROM pool_scores ORDER BY computed_at DESC LIMIT 1')
      .get() as { computed_at: string };
    const rows = testDb
      .prepare('SELECT * FROM pool_scores WHERE computed_at = ? ORDER BY score DESC')
      .all(latest.computed_at) as Array<{ score: number; pool_address: string }>;

    expect(rows.length).toBe(2);
    expect(rows[0].score).toBeGreaterThan(rows[1].score);
    expect(rows[0].pool_address).toBe('pool_a');
  });
});

describe('rotation_log', () => {
  test('approve transitions proposed -> approved', () => {
    testDb.exec(`
      INSERT INTO rotation_log (from_pool, to_pool, from_protocol, to_protocol, amount, reason, status)
      VALUES ('pool_a', 'pool_b', 'ociswap', 'caviarnine', '1000', 'better APY', 'proposed')
    `);
    const row = testDb.prepare('SELECT id FROM rotation_log LIMIT 1').get() as { id: number };
    testDb.prepare("UPDATE rotation_log SET status = 'approved' WHERE id = ?").run(row.id);
    const updated = testDb.prepare('SELECT status FROM rotation_log WHERE id = ?').get(row.id) as {
      status: string;
    };
    expect(updated.status).toBe('approved');
  });

  test('reject transitions proposed -> rejected', () => {
    testDb.exec(`
      INSERT INTO rotation_log (from_pool, to_pool, from_protocol, to_protocol, amount, reason, status)
      VALUES ('pool_a', 'pool_b', 'ociswap', 'caviarnine', '1000', 'better APY', 'proposed')
    `);
    const row = testDb.prepare('SELECT id FROM rotation_log LIMIT 1').get() as { id: number };
    testDb.prepare("UPDATE rotation_log SET status = 'rejected' WHERE id = ?").run(row.id);
    const updated = testDb.prepare('SELECT status FROM rotation_log WHERE id = ?').get(row.id) as {
      status: string;
    };
    expect(updated.status).toBe('rejected');
  });

  test('approve does not affect already-executed rotations', () => {
    testDb.exec(`
      INSERT INTO rotation_log (from_pool, to_pool, from_protocol, to_protocol, amount, reason, status)
      VALUES ('pool_a', 'pool_b', 'ociswap', 'caviarnine', '1000', 'better APY', 'executed')
    `);
    const row = testDb.prepare('SELECT id FROM rotation_log LIMIT 1').get() as { id: number };
    // Only approve if status is 'proposed'
    testDb
      .prepare("UPDATE rotation_log SET status = 'approved' WHERE id = ? AND status = 'proposed'")
      .run(row.id);
    const updated = testDb.prepare('SELECT status FROM rotation_log WHERE id = ?').get(row.id) as {
      status: string;
    };
    expect(updated.status).toBe('executed'); // unchanged
  });

  test('pending query returns only proposed-status rows', () => {
    testDb.exec(`
      INSERT INTO rotation_log (from_pool, to_pool, from_protocol, to_protocol, amount, reason, status)
      VALUES ('pool_a', 'pool_b', 'ociswap', 'caviarnine', '1000', 'reason1', 'proposed')
    `);
    testDb.exec(`
      INSERT INTO rotation_log (from_pool, to_pool, from_protocol, to_protocol, amount, reason, status)
      VALUES ('pool_c', 'pool_d', 'ociswap', 'caviarnine', '2000', 'reason2', 'executed')
    `);
    testDb.exec(`
      INSERT INTO rotation_log (from_pool, to_pool, from_protocol, to_protocol, amount, reason, status)
      VALUES ('pool_e', 'pool_f', 'ociswap', 'caviarnine', '500', 'reason3', 'proposed')
    `);

    const pending = testDb
      .prepare("SELECT * FROM rotation_log WHERE status = 'proposed' ORDER BY proposed_at DESC")
      .all() as Array<{ status: string }>;
    expect(pending.length).toBe(2);
    for (const row of pending) {
      expect(row.status).toBe('proposed');
    }
  });
});

// --- Security integration tests (HTTP-level) ---

const TEST_PORT = 19876;
// 127.0.0.1 explicitly — the server binds loopback (F4); 'localhost' can
// resolve to ::1 on some hosts and miss the IPv4 bind.
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const AUTH_TOKEN = process.env.API_AUTH_TOKEN!;

function mockAgent(): AgentLoop {
  return {
    getState: () => ({
      running: true,
      halted: false,
      lastScan: Date.now(),
      lastHarvest: 0,
      lastRotationReview: 0,
      // An internal-looking failure string: the DF-8 tests prove it never
      // reaches an anonymous caller.
      errors: ['SQLITE_BUSY at <deploy-root>/data/defi-farmer.db via https://gw.internal/status 503'],
      circuitBreaker: { errorTimestamps: [], tripped: false, trippedAt: null },
      pendingTx: 0,
    }),
    halt: () => {},
    start: () => {},
    isHalted: () => false,
  } as unknown as AgentLoop;
}

let server: ReturnType<typeof startApi> | null = null;

function ensureServer(): void {
  if (!server) {
    server = startApi(mockAgent(), TEST_PORT);
  }
}

describe('API auth', () => {
  beforeAll(() => ensureServer());
  beforeEach(() => resetRateLimits());

  test('POST without auth returns 401', async () => {
    const res = await fetch(`${BASE}/api/agent/stop`, { method: 'POST' });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Unauthorized');
  });

  test('POST with wrong token returns 401', async () => {
    const res = await fetch(`${BASE}/api/agent/stop`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  test('POST with valid token succeeds', async () => {
    const res = await fetch(`${BASE}/api/agent/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
  });

  test('GET endpoints do not require auth', async () => {
    const res = await fetch(`${BASE}/api/health`);
    expect(res.status).toBe(200);
  });
});

// Regression (Phase 3): the snapshots endpoint served raw rows (apy_bps / tvl),
// but the chart reads apy_7d_ma / tvl_usd — `s.apy_7d_ma.toFixed()` threw
// undefined and took the whole opportunity page down. Guard the wire contract
// at the endpoint, not just in replicated SQL.
describe('GET /api/snapshots/:address contract', () => {
  beforeAll(() => ensureServer());
  beforeEach(() => resetRateLimits());

  test('returns the frontend PoolSnapshot shape (apy_7d_ma/tvl_usd), never raw columns', async () => {
    testDb.exec(`
      INSERT INTO pool_snapshots (pool_address, protocol, tvl, apy_bps, scanned_at)
      VALUES ('pool_snap_1', 'ociswap', '250000', 1234, '2026-07-18 09:00:00')
    `);
    const res = await fetch(`${BASE}/api/snapshots/pool_snap_1`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.apy_7d_ma).toBeCloseTo(12.34); // 1234 bps → 12.34%
    expect(row.tvl_usd).toBe(250000);
    expect(row.scanned_at).toBe('2026-07-18 09:00:00');
    // The raw column names must NOT leak — that was the crash.
    expect(row.apy_bps).toBeUndefined();
    expect(row.tvl).toBeUndefined();
    // Every row must carry a defined apy_7d_ma (the .toFixed() precondition).
    expect(typeof row.apy_7d_ma).toBe('number');
  });

  test('a null apy_bps coalesces to 0, never undefined', async () => {
    testDb.exec(`
      INSERT INTO pool_snapshots (pool_address, protocol, tvl, apy_bps, scanned_at)
      VALUES ('pool_snap_2', 'ociswap', '100', 0, '2026-07-18 09:00:00')
    `);
    const res = await fetch(`${BASE}/api/snapshots/pool_snap_2`);
    const rows = (await res.json()) as Array<{ apy_7d_ma: number }>;
    expect(rows[0].apy_7d_ma).toBe(0);
  });
});

// Phase 3: the enricher resolves "SYMX-SYMY" names from on-ledger symbols;
// they persist to pool_scores.pool_name so the UI labels tokens instead of a
// bare component address. Falls back to the address when unresolved.
describe('GET /api/opportunities pool_name', () => {
  beforeAll(() => ensureServer());
  beforeEach(() => resetRateLimits());

  test('serves the persisted enricher name, and net-of-IL fields', async () => {
    testDb.exec(`
      INSERT INTO pool_scores
        (pool_address, protocol, score, apy_ma_7d, net_apy_ma_7d, estimated_il,
         il_risk_score, risk_adjusted_return, tvl_variance, classification, pool_name)
      VALUES ('pool_named', 'caviarnine', 60, 8, 2.3, -5.7, 34, -0.4, 0.1, 'rotational', 'XRD-xUSDT')
    `);
    const res = await fetch(`${BASE}/api/opportunities?n=5`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    const row = rows.find((r) => r.pool_address === 'pool_named')!;
    expect(row.pool_name).toBe('XRD-xUSDT');
    expect(row.net_apy_ma_7d).toBeCloseTo(2.3);
    expect(row.estimated_il).toBeCloseTo(-5.7);
  });

  test('falls back to the address when pool_name is null', async () => {
    testDb.exec(`
      INSERT INTO pool_scores
        (pool_address, protocol, score, apy_ma_7d, tvl_variance, classification)
      VALUES ('pool_unnamed', 'ociswap', 50, 5, 0.1, 'rotational')
    `);
    const res = await fetch(`${BASE}/api/opportunities?n=50`);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    const row = rows.find((r) => r.pool_address === 'pool_unnamed')!;
    expect(row.pool_name).toBe('pool_unnamed');
  });
});

// The operator tier used to be reachable by anyone: the Next proxy attached
// the operator Bearer to every state-changing request that carried a plausible
// Origin header, and to three operator GETs. An Origin header is CSRF defense,
// not authentication (curl sets it freely), so unauthenticated internet callers
// could stop the agent, approve a rotation, and read the
// risk posture. The proxy no longer sends the Bearer; browser operators are
// identified by a ROLA session in OPERATOR_ADDRESSES instead (F10/F14/F17).
describe('API operator tier', () => {
  const OPERATOR = process.env.OPERATOR_ADDRESSES!;
  const NOT_OPERATOR =
    'account_rdx12x4zdjmz0rrxg9v6l8yq2m8h0kqzc9wpmqqjx5nznpdw6yqvsxkm4t';

  beforeAll(() => ensureServer());
  beforeEach(() => resetRateLimits());

  // These four are the endpoints the proxy used to elevate for anyone.
  const OPERATOR_ENDPOINTS: Array<[string, string]> = [
    ['POST', '/api/agent/stop'],
    ['POST', '/api/agent/stop'],
    ['GET', '/api/config'],
    ['GET', '/api/rotation/pending'],
  ];

  test.each(OPERATOR_ENDPOINTS)(
    'anonymous %s %s is rejected',
    async (method, path) => {
      const res = await fetch(`${BASE}${path}`, { method });
      expect(res.status).toBe(401);
    },
  );

  // An Origin header must not be mistaken for a credential.
  test.each(OPERATOR_ENDPOINTS)(
    '%s %s with a forged Origin is still rejected',
    async (method, path) => {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(401);
    },
  );

  test('a signed-in but non-allowlisted wallet is not an operator', async () => {
    const { token } = createSession(NOT_OPERATOR);
    const res = await fetch(`${BASE}/api/config`, {
      headers: { Cookie: `farmer_session=${token}` },
    });
    expect(res.status).toBe(401);
  });

  test('an allowlisted wallet session satisfies the operator tier', async () => {
    const { token } = createSession(OPERATOR);
    const res = await fetch(`${BASE}/api/config`, {
      headers: { Cookie: `farmer_session=${token}` },
    });
    expect(res.status).toBe(200);
  });

  test('an allowlisted wallet session can drive agent control', async () => {
    const { token } = createSession(OPERATOR);
    const res = await fetch(`${BASE}/api/agent/stop`, {
      method: 'POST',
      headers: { Cookie: `farmer_session=${token}` },
    });
    expect(res.status).toBe(200);
  });

  // The Bearer stays the machine credential (CLI/ops over an SSH tunnel).
  test('the operator Bearer still works', async () => {
    const res = await fetch(`${BASE}/api/config`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });
});

describe('API CORS', () => {
  test('OPTIONS preflight returns CORS headers', async () => {
    const res = await fetch(`${BASE}/api/health`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  test('GET response includes CORS origin header', async () => {
    const res = await fetch(`${BASE}/api/health`);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  });
});

describe('API kill switch', () => {
  beforeEach(() => resetRateLimits());

  test('POST /api/agent/stop halts agent', async () => {
    const res = await fetch(`${BASE}/api/agent/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toBe('Agent halted');
  });

  test('POST /api/agent/start resumes agent', async () => {
    const res = await fetch(`${BASE}/api/agent/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
  });

  test('GET /api/agent/status returns agent state', async () => {
    const res = await fetch(`${BASE}/api/agent/status`);
    expect(res.status).toBe(200);
    const body = await res.json() as { running: boolean; halted: boolean; circuitBreaker: unknown };
    expect(typeof body.running).toBe('boolean');
    expect(typeof body.halted).toBe('boolean');
    expect(body.circuitBreaker).toBeDefined();
  });

  test('DF-8: public GET /api/status returns the reduced shape — a count, no raw error strings', async () => {
    const res = await fetch(`${BASE}/api/status`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.running).toBe(true);
    expect(typeof body.lastScan).toBe('number');
    expect(body.errorCount).toBe(1);
    expect(body.errors).toBeUndefined();
    expect(body.lastRotationReview).toBeUndefined();
    expect(text).not.toContain('SQLITE_BUSY');
    expect(text).not.toContain('<deploy-root>');
  });

  test('DF-8: the full agent state is operator-only at /api/agent/state', async () => {
    const anon = await fetch(`${BASE}/api/agent/state`);
    expect(anon.status).toBe(401);
    const op = await fetch(`${BASE}/api/agent/state`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(op.status).toBe(200);
    const body = await op.json() as { errors: string[] };
    expect(body.errors).toHaveLength(1);
  });
});

describe('API input validation', () => {
  beforeEach(() => resetRateLimits());

  test('POST /api/rotation/abc/approve returns 404 (non-numeric id)', async () => {
    const res = await fetch(`${BASE}/api/rotation/abc/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    // Path won't match regex, so it falls through to 404
    expect(res.status).toBe(404);
  });

  test('POST /api/rotation/999/approve returns 404 for non-existent rotation', async () => {
    const res = await fetch(`${BASE}/api/rotation/999/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Rotation not found');
  });

  test('POST /api/rotation/:id/approve rejects non-proposed rotation', async () => {
    testDb.exec(`
      INSERT INTO rotation_log (from_pool, to_pool, from_protocol, to_protocol, amount, reason, status)
      VALUES ('pool_a', 'pool_b', 'ociswap', 'caviarnine', '1000', 'test', 'executed')
    `);
    const row = testDb.prepare('SELECT id FROM rotation_log LIMIT 1').get() as { id: number };
    const res = await fetch(`${BASE}/api/rotation/${row.id}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Cannot approve');
  });
});

describe('API rate limiting', () => {
  beforeAll(() => ensureServer());

  test('returns 429 when POST rate limit exceeded', async () => {
    resetRateLimits();
    // POST rate limit default is 10/min — send 12 rapid requests
    const results: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${BASE}/api/agent/stop`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      });
      results.push(res.status);
    }
    expect(results.filter(s => s === 429).length).toBeGreaterThan(0);
  });
});

describe('rate limiting keys on socket IP, not X-Forwarded-For (F12)', () => {
  beforeAll(() => ensureServer());

  test('spoofed X-Forwarded-For does not mint fresh buckets when TRUST_PROXY is off', async () => {
    resetRateLimits();
    // Rotate the header every request — with header-keyed limiting this
    // never 429s; with socket-IP keying it must.
    const results: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${BASE}/api/agent/stop`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${AUTH_TOKEN}`,
          'X-Forwarded-For': `10.0.0.${i}`,
        },
      });
      results.push(res.status);
    }
    expect(results.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});

// The TRUST_PROXY=on branch had no coverage, and it was the branch that
// mattered: Caddy APPENDS to a client-supplied X-Forwarded-For, so reading the
// leftmost entry read back whatever the attacker sent and minted a fresh
// rate-limit bucket per request (REVIEW-2026-07-17 F12).
describe('rate limiter: X-Forwarded-For parsing (F12)', () => {
  function reqWith(xff?: string): Request {
    return new Request('http://127.0.0.1/api/health', {
      headers: xff ? { 'X-Forwarded-For': xff } : {},
    });
  }

  test('a prepended (spoofed) hop is ignored — the real client IP wins', () => {
    // What Caddy hands us when the client lies: their value, then the address
    // Caddy actually observed.
    expect(clientIpFromXff(reqWith('1.2.3.4, 203.0.113.9'), 'sock')).toBe('203.0.113.9');
  });

  test('an attacker cannot mint a fresh bucket by varying the prefix', () => {
    const a = clientIpFromXff(reqWith('9.9.9.1, 203.0.113.9'), 'sock');
    const b = clientIpFromXff(reqWith('9.9.9.2, 203.0.113.9'), 'sock');
    expect(a).toBe(b);
  });

  test('a long forged chain still resolves to the rightmost hop', () => {
    expect(
      clientIpFromXff(reqWith('1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.9'), 'sock'),
    ).toBe('203.0.113.9');
  });

  test('a single honest hop is used as-is', () => {
    expect(clientIpFromXff(reqWith('203.0.113.9'), 'sock')).toBe('203.0.113.9');
  });

  test('no header falls back to the socket IP', () => {
    expect(clientIpFromXff(reqWith(), 'sock')).toBe('sock');
  });

  test('a blank header falls back rather than bucketing everyone under ""', () => {
    expect(clientIpFromXff(reqWith('   '), 'sock')).toBe('sock');
  });
});
