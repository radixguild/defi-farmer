/// Every wallet login sees only the account it proved through ROLA.
///
/// Three callers, three answers:
///   - signed out (no cookie, no Bearer): 401 on every account-scoped read;
///   - a wallet session: its own account's rows and nothing else. That holds
///     for a wallet in OPERATOR_ADDRESSES too: the allowlist grants agent
///     control, not a view of other accounts;
///   - the Bearer (machines only; the Next proxy never attaches it): every row.
///
/// The positions-scoping basics live in positions.test.ts (D4). This file
/// covers the cross-account matrix: session A against B's rows, against the
/// owner-less account-wide rows, and the allowlisted wallet against both.

import { describe, test, expect, beforeEach, beforeAll, afterAll, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema, setTestDb } from '../src/db/schema';
import { startApi, resetRateLimits } from '../src/api';
import { createSession } from '../src/services/sessions';
import type { AgentLoop } from '../src/agent/loop';

const A = 'account_rdx1c9dka8al9kd0a93q8ag4mjs3fzassqef0lk6hg757tqfma5hu0n3gy';
const B = 'account_rdx12x4zdjmz0rrxg9v6l8yq2m8h0kqzc9wpmqqjx5nznpdw6yqvsxkm4t';
const OPERATOR_WALLET = process.env.OPERATOR_ADDRESSES!.split(',')[0].trim();
const BEARER = process.env.API_AUTH_TOKEN!;
const POOL = 'component_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky';
const XRD = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';
const HASH = 'txid_rdx1notarealhashbutvalidshape0aaaaaaaaaaaaaaaaaaaaaaaaaaa';

const TEST_PORT = 19879;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

function mockAgent(): AgentLoop {
  return {
    getState: () => ({ running: true, halted: false, lastScan: 0, errors: [], circuitBreaker: {}, pendingTx: 0 }),
    halt: () => {},
    start: () => {},
    isHalted: () => false,
  } as unknown as AgentLoop;
}

let testDb: Database;
let server: ReturnType<typeof startApi> | null = null;

/// Position ids by owner, so tests can aim at a specific account's row.
let ids: { a: number; b: number; agent: number; operator: number };
/// Rotation ids by owner.
let rot: { a: number; b: number; accountWide: number };

function seed(): void {
  const pos = testDb.prepare(
    `INSERT INTO positions (protocol, pool_address, token_a, deposited_amount, status, user_address)
     VALUES ('ociswap', ?, ?, ?, 'active', ?)`,
  );
  ids = {
    a: Number(pos.run(POOL, XRD, '100', A).lastInsertRowid),
    b: Number(pos.run(POOL, XRD, '200', B).lastInsertRowid),
    agent: Number(pos.run(POOL, XRD, '300', null).lastInsertRowid),
    operator: Number(pos.run(POOL, XRD, '400', OPERATOR_WALLET).lastInsertRowid),
  };
  const r = testDb.prepare(
    `INSERT INTO rotation_log (from_pool, to_pool, from_protocol, to_protocol, amount, reason, status, user_address)
     VALUES ('pool_x', 'pool_y', 'ociswap', 'caviarnine', ?, 'test', 'proposed', ?)`,
  );
  rot = {
    a: Number(r.run('10', A).lastInsertRowid),
    b: Number(r.run('20', B).lastInsertRowid),
    // What the agent's weekly review writes: sized from every account's
    // positions, stored with no owner.
    accountWide: Number(r.run('30', null).lastInsertRowid),
  };
}

function cookieFor(address: string): Record<string, string> {
  return { Cookie: `farmer_session=${createSession(address).token}` };
}
const bearer = { Authorization: `Bearer ${BEARER}` };

async function getJson<T>(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { headers });
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(() => {
  server = startApi(mockAgent(), TEST_PORT);
});
afterAll(() => {
  server?.stop?.(true);
  server = null;
  setTestDb(null);
  testDb?.close();
});
beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
  setTestDb(testDb);
  resetRateLimits();
  seed();
});

describe('signed out: no account data at all', () => {
  const ACCOUNT_SCOPED = [
    '/api/positions',
    '/api/positions/1',
    '/api/holdings',
    `/api/holdings?address=${A}`,
    '/api/holdings/claims',
    '/api/holdings/watched',
    '/api/rotation/pending',
    '/api/rotation/log',
    '/api/auth/me',
  ];

  test.each(ACCOUNT_SCOPED)('anonymous GET %s is 401', async (path) => {
    const res = await fetch(`${BASE}${path}`);
    expect(res.status).toBe(401);
  });

  test('a stale or forged cookie is the same as no cookie', async () => {
    const res = await fetch(`${BASE}/api/positions`, {
      headers: { Cookie: `farmer_session=${'0'.repeat(64)}` },
    });
    expect(res.status).toBe(401);
  });
});

describe('positions: session A never reads B, the agent, or the operator', () => {
  test('A sees exactly its own row', async () => {
    const { status, body } = await getJson<{ id: number; user_address: string }[]>('/api/positions', cookieFor(A));
    expect(status).toBe(200);
    expect(body.map((r) => r.id)).toEqual([ids.a]);
    expect(body.every((r) => r.user_address === A)).toBe(true);
  });

  test('B sees exactly its own row', async () => {
    const { body } = await getJson<{ id: number }[]>('/api/positions', cookieFor(B));
    expect(body.map((r) => r.id)).toEqual([ids.b]);
  });

  test('a session with no positions gets an empty list, never someone else’s', async () => {
    const stranger = 'account_rdx1cxaqwoxvxyvuqzvxw2z5c9dka8al9kd0a93q8ag4mjs3fzassqef0lk';
    const { status, body } = await getJson<unknown[]>('/api/positions', cookieFor(stranger));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  test('A cannot fetch B’s, the agent’s or the operator’s row by id', async () => {
    const cookie = cookieFor(A);
    for (const id of [ids.b, ids.agent, ids.operator]) {
      const res = await fetch(`${BASE}/api/positions/${id}`, { headers: cookie });
      expect(res.status).toBe(404);
    }
    expect((await fetch(`${BASE}/api/positions/${ids.a}`, { headers: cookie })).status).toBe(200);
  });

  test('an allowlisted operator wallet session sees only its own row', async () => {
    const { status, body } = await getJson<{ id: number }[]>('/api/positions', cookieFor(OPERATOR_WALLET));
    expect(status).toBe(200);
    expect(body.map((r) => r.id)).toEqual([ids.operator]);
    const other = await fetch(`${BASE}/api/positions/${ids.a}`, { headers: cookieFor(OPERATOR_WALLET) });
    expect(other.status).toBe(404);
  });

  test('a session cookie pins the request even alongside the Bearer', async () => {
    const { body } = await getJson<{ id: number }[]>('/api/positions', { ...bearer, ...cookieFor(A) });
    expect(body.map((r) => r.id)).toEqual([ids.a]);
  });

  test('the Bearer alone still sees every row', async () => {
    const { body } = await getJson<unknown[]>('/api/positions', bearer);
    expect(body).toHaveLength(4);
  });

  test('closing another account’s row is refused before any ledger lookup', async () => {
    for (const who of [A, OPERATOR_WALLET]) {
      const res = await fetch(`${BASE}/api/positions/${ids.b}/close`, {
        method: 'POST',
        headers: { ...cookieFor(who), 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent_hash: HASH }),
      });
      expect(res.status).toBe(403);
    }
  });
});

describe('rotation proposals: account-wide rows stay off wallet sessions', () => {
  for (const path of ['/api/rotation/pending', '/api/rotation/log']) {
    test(`${path}: A sees only rows that carry A`, async () => {
      const { status, body } = await getJson<{ id: number }[]>(path, cookieFor(A));
      expect(status).toBe(200);
      expect(body.map((r) => r.id)).toEqual([rot.a]);
    });

    test(`${path}: the allowlisted operator wallet sees none of A’s, B’s or the account-wide rows`, async () => {
      const { status, body } = await getJson<unknown[]>(path, cookieFor(OPERATOR_WALLET));
      expect(status).toBe(200);
      expect(body).toEqual([]);
    });

    test(`${path}: the Bearer sees every row`, async () => {
      const { body } = await getJson<unknown[]>(path, bearer);
      expect(body).toHaveLength(3);
    });
  }

  test('the allowlisted wallet cannot approve or reject a row that is not its own', async () => {
    for (const id of [rot.a, rot.accountWide]) {
      for (const verb of ['approve', 'reject']) {
        const res = await fetch(`${BASE}/api/rotation/${id}/${verb}`, {
          method: 'POST',
          headers: cookieFor(OPERATOR_WALLET),
        });
        expect(res.status).toBe(404);
      }
    }
    const untouched = testDb.prepare('SELECT DISTINCT status FROM rotation_log').all();
    expect(untouched).toEqual([{ status: 'proposed' }]);
  });

  test('the Bearer can still approve an account-wide row', async () => {
    const res = await fetch(`${BASE}/api/rotation/${rot.accountWide}/approve`, {
      method: 'POST',
      headers: bearer,
    });
    expect(res.status).toBe(200);
  });
});

describe('holdings and claims: the session account, or nothing', () => {
  // Capture what the server asks the Gateway for, and fail it fast (a 4xx is
  // never retried). The API then answers 502, but the captured requests show
  // which account the read was aimed at.
  const realFetch = globalThis.fetch;
  let gatewayBodies: string[] = [];

  beforeEach(() => {
    gatewayBodies = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(BASE)) return realFetch(input, init);
      gatewayBodies.push(typeof init?.body === 'string' ? init.body : '');
      return new Response('{"message":"stubbed"}', { status: 400 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  for (const [path, what] of [['/api/holdings', 'holdings'], ['/api/holdings/claims', 'claims']] as const) {
    test(`${path}: A cannot name B`, async () => {
      const res = await fetch(`${BASE}${path}?address=${B}`, { headers: cookieFor(A) });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain(what);
      expect(gatewayBodies).toEqual([]);
    });

    test(`${path}: the allowlisted operator wallet cannot name A`, async () => {
      const res = await fetch(`${BASE}${path}?address=${A}`, { headers: cookieFor(OPERATOR_WALLET) });
      expect(res.status).toBe(403);
      expect(gatewayBodies).toEqual([]);
    });

    test(`${path}: with no ?address=, A's read is aimed at A alone`, async () => {
      const res = await fetch(`${BASE}${path}`, { headers: cookieFor(A) });
      expect(res.status).toBe(502); // the stubbed Gateway refused
      expect(gatewayBodies.length).toBeGreaterThan(0);
      expect(gatewayBodies.some((b) => b.includes(A))).toBe(true);
      expect(gatewayBodies.some((b) => b.includes(B) || b.includes(OPERATOR_WALLET))).toBe(false);
    });

    test(`${path}: naming your own account is allowed`, async () => {
      const res = await fetch(`${BASE}${path}?address=${A}`, { headers: cookieFor(A) });
      expect(res.status).toBe(502);
      expect(gatewayBodies.some((b) => b.includes(A))).toBe(true);
    });

    test(`${path}: the Bearer may name any account`, async () => {
      const res = await fetch(`${BASE}${path}?address=${B}`, { headers: bearer });
      expect(res.status).toBe(502);
      expect(gatewayBodies.some((b) => b.includes(B))).toBe(true);
    });
  }

  test('the watch list is Bearer-only: the allowlisted wallet session is refused', async () => {
    const res = await fetch(`${BASE}/api/holdings/watched`, { headers: cookieFor(OPERATOR_WALLET) });
    expect(res.status).toBe(403);
    const ok = await fetch(`${BASE}/api/holdings/watched`, { headers: bearer });
    expect(ok.status).toBe(200);
  });
});
