import { describe, test, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema, setTestDb } from '../src/db/schema';
import { startApi, resetRateLimits } from '../src/api';
import { recordDeposit, type ResolveLp } from '../src/services/position-recorder';
import { createSession } from '../src/services/sessions';
import type { CommittedTx } from '../src/services/gateway';
import type { AgentLoop } from '../src/agent/loop';
import { DEFIPLAZA_ROUTER, type LpModel, type ResolvedPool } from '../src/services/dex/pool-resolver';
import { buildFungibleWithdraw, buildDefiplazaWithdraw, buildNftWithdraw } from '../src/services/dex/manifests';
import { assertNfLocalId } from '../src/services/dex/rtm';

const USER = 'account_rdx1c9dka8al9kd0a93q8ag4mjs3fzassqef0lk6hg757tqfma5hu0n3gy';
const OTHER = 'account_rdx1cxaqwoxvxyvuqzvxw2z5c9dka8al9kd0a93q8ag4mjs3fzassqef0lk';
const POOL = 'component_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky';
const XRD = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';
const RECEIPT_RES = 'resource_rdx1t45js47zxtqa5ycqhj95lax3fz9yg3h20rafy8fauxz6wd3cmpfhg8';
const LP_RES = 'resource_rdx1t5poolunitbasicorweighted0aaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE_LP = 'resource_rdx1t5plazabaselp0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const QUOTE_LP = 'resource_rdx1t5plazaquotelp0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH = 'txid_rdx1notarealhashbutvalidshape0aaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RUID = '{deadbeef01234567-89abcdef01234567-0123456789abcdef-fedcba9876543210}';

function committedTx(overrides: Partial<CommittedTx> = {}): CommittedTx {
  return {
    status: 'CommittedSuccess',
    affectedEntities: [USER, POOL, XRD],
    fungible: [
      { entity: USER, resource: XRD, change: '-500.25' },
      { entity: POOL, resource: XRD, change: '500.25' },
    ],
    nonFungible: [{ entity: USER, resource: RECEIPT_RES, added: ['#42#'], removed: [] }],
    ...overrides,
  };
}

const fetchOk = async () => committedTx();

// Canned LP resolvers (the recorder resolves ONLY on the fungible fallback).
const resolveNftLp: ResolveLp = async () => ({ lp: { kind: 'nft', resource: RECEIPT_RES }, protocol: 'caviarnine' });
const resolveFungibleLp: ResolveLp = async () => ({ lp: { kind: 'fungible', resource: LP_RES }, protocol: 'ociswap' });
const resolvePlazaLp: ResolveLp = async () => ({
  lp: { kind: 'defiplaza', baseLp: BASE_LP, quoteLp: QUOTE_LP }, protocol: 'defiplaza',
});
const neverResolve: ResolveLp = async () => {
  throw new Error('resolveLp must not be called on this path');
};

function cannedPool(kind: ResolvedPool['kind'], lp: LpModel, router?: string): ResolvedPool {
  return {
    address: POOL, protocol: 'ociswap', kind, blueprintName: 'x', packageAddress: 'x',
    concentrated: false, tokenX: XRD, tokenY: XRD, lp, router,
  };
}

let testDb: Database;

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
  setTestDb(testDb);
  resetRateLimits();
});

afterAll(() => {
  setTestDb(null);
  testDb?.close();
});

describe('recordDeposit (D5 verified recording)', () => {
  const input = { intentHash: HASH, poolAddress: POOL, userAddress: USER };

  test('rejects malformed intent hash and pool address without touching the gateway', async () => {
    let gatewayCalls = 0;
    const spy = async () => ((gatewayCalls++), committedTx());
    const bad1 = await recordDeposit(spy, { ...input, intentHash: 'DROP TABLE' }, neverResolve);
    const bad2 = await recordDeposit(spy, { ...input, poolAddress: 'not_a_pool' }, neverResolve);
    expect(bad1).toMatchObject({ ok: false, status: 400 });
    expect(bad2).toMatchObject({ ok: false, status: 400 });
    expect(gatewayCalls).toBe(0);
  });

  test('rejects uncommitted transactions', async () => {
    const result = await recordDeposit(async () => committedTx({ status: 'Pending' }), input, neverResolve);
    expect(result).toMatchObject({ ok: false, status: 409 });
  });

  test('rejects when the claimed pool is not touched', async () => {
    const result = await recordDeposit(
      async () => committedTx({ affectedEntities: [USER, XRD] }),
      input,
      neverResolve,
    );
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  test("rejects another account's transaction", async () => {
    const result = await recordDeposit(
      async () => committedTx({ affectedEntities: [OTHER, POOL] }),
      input,
      neverResolve,
    );
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  test('an NFT-receipt pool without a receipt mint is rejected', async () => {
    const result = await recordDeposit(async () => committedTx({ nonFungible: [] }), input, resolveNftLp);
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM positions').get()).toEqual({ n: 0 });
  });

  test('gateway failure is a 502, not a recorded position', async () => {
    const result = await recordDeposit(async () => {
      throw new Error('down');
    }, input, neverResolve);
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM positions').get()).toEqual({ n: 0 });
  });

  test('happy path records the verified position without resolving the pool', async () => {
    testDb
      .prepare("INSERT INTO pool_snapshots (pool_address, protocol, tvl, apy_bps) VALUES (?, 'ociswap', '1000000', 1200)")
      .run(POOL);

    const result = await recordDeposit(fetchOk, input, neverResolve);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.position).toMatchObject({
      pool_address: POOL,
      protocol: 'ociswap',
      receipt_resource: RECEIPT_RES,
      receipt_id: '42', // '#42#' → bare integer
      lp_amount: null,
      token_a: XRD,
      deposited_amount: '500.25',
      intent_hash: HASH,
    });

    const row = testDb.prepare('SELECT * FROM positions WHERE intent_hash = ?').get(HASH) as {
      user_address: string;
      status: string;
    };
    expect(row.user_address).toBe(USER);
    expect(row.status).toBe('active');
  });

  test('same hash again is idempotent; a different user gets 409', async () => {
    await recordDeposit(fetchOk, input, neverResolve);
    const again = await recordDeposit(fetchOk, input, neverResolve);
    expect(again).toMatchObject({ ok: true, created: false });

    const stolen = await recordDeposit(fetchOk, { ...input, userAddress: OTHER }, neverResolve);
    expect(stolen).toMatchObject({ ok: false, status: 409 });
    expect((testDb.prepare('SELECT COUNT(*) AS n FROM positions').get() as { n: number }).n).toBe(1);
  });

  // Concurrency: the pre-check SELECT and the INSERT straddle the fetchCommitted
  // await, so a second request for the same NEW hash can land the row mid-await.
  // The loser must return the idempotent result, not a 500 from the raw UNIQUE
  // violation. Simulate by inserting the conflicting row inside fetchCommitted.
  function insertConflict(user: string): void {
    testDb
      .prepare(
        `INSERT INTO positions
           (protocol, pool_address, receipt_id, receipt_resource, token_a,
            deposited_amount, status, user_address, intent_hash)
         VALUES ('ociswap', ?, '99', ?, ?, '500.25', 'active', ?, ?)`,
      )
      .run(POOL, RECEIPT_RES, XRD, user, HASH);
  }

  test('a concurrent insert of the same hash (same user) recovers created:false, not a 500', async () => {
    const fetchThenConflict = async () => (insertConflict(USER), committedTx());
    const result = await recordDeposit(fetchThenConflict, input, neverResolve);
    expect(result).toMatchObject({ ok: true, created: false });
    expect((testDb.prepare('SELECT COUNT(*) AS n FROM positions').get() as { n: number }).n).toBe(1);
  });

  test('a concurrent insert by a different user yields 409, not a 500', async () => {
    const fetchThenConflict = async () => (insertConflict(OTHER), committedTx());
    const result = await recordDeposit(fetchThenConflict, input, neverResolve);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((testDb.prepare('SELECT COUNT(*) AS n FROM positions').get() as { n: number }).n).toBe(1);
  });
});

// --- Phase 1: fungible-LP fallback (Basic/Weighted pool units, DefiPlaza LPs) ---

describe('recordDeposit fungible-LP fallback', () => {
  const input = { intentHash: HASH, poolAddress: POOL, userAddress: USER };

  /// Basic/Weighted deposit shape: no NFT mint; the account pays the deposit
  /// token and receives the pool unit (plus XRD fee dust).
  const fungibleTx = async () =>
    committedTx({
      fungible: [
        { entity: USER, resource: XRD, change: '-500.25' },
        { entity: USER, resource: LP_RES, change: '123.456789012345678' },
        { entity: POOL, resource: XRD, change: '500.25' },
      ],
      nonFungible: [],
    });

  test('records the pool-unit inflow when no NFT was minted (Basic/Weighted)', async () => {
    const result = await recordDeposit(fungibleTx, input, resolveFungibleLp);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.position).toMatchObject({
      pool_address: POOL,
      protocol: 'ociswap', // the resolver's protocol, no pool_snapshots row needed
      receipt_resource: LP_RES,
      receipt_id: null,
      lp_amount: '123.456789012345678', // raw Gateway string, not float-mangled
      token_a: XRD,
      deposited_amount: '500.25',
    });

    // The stored fields drive the withdraw builder directly.
    const pool = cannedPool('ociswap_basic', { kind: 'fungible', resource: LP_RES });
    const manifest = buildFungibleWithdraw(USER, pool, result.position.lp_amount as string);
    expect(manifest).toContain(LP_RES);
    expect(manifest).toContain('"remove_liquidity"');
  });

  test('records the largest LP side for a DefiPlaza co-liquidity add', async () => {
    const plazaTx = async () =>
      committedTx({
        fungible: [
          { entity: USER, resource: XRD, change: '-500.25' },
          { entity: USER, resource: BASE_LP, change: '10.5' },
          { entity: USER, resource: QUOTE_LP, change: '2.25' },
          { entity: POOL, resource: XRD, change: '500.25' },
        ],
        nonFungible: [],
      });
    const result = await recordDeposit(plazaTx, input, resolvePlazaLp);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.position).toMatchObject({
      protocol: 'defiplaza',
      receipt_resource: BASE_LP,
      receipt_id: null,
      lp_amount: '10.5',
    });

    const pool = cannedPool(
      'defiplaza_pair',
      { kind: 'defiplaza', baseLp: BASE_LP, quoteLp: QUOTE_LP },
      DEFIPLAZA_ROUTER,
    );
    const manifest = buildDefiplazaWithdraw(
      USER, pool, result.position.receipt_resource as string, result.position.lp_amount as string,
    );
    expect(manifest).toContain(BASE_LP);
    expect(manifest).toContain(DEFIPLAZA_ROUTER);
  });

  test('a QuantaSwap ruid receipt is stored in the form the withdraw builder accepts', async () => {
    const quantaTx = async () =>
      committedTx({ nonFungible: [{ entity: USER, resource: RECEIPT_RES, added: [RUID], removed: [] }] });
    const result = await recordDeposit(quantaTx, input, neverResolve);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.position.receipt_id).toBe(RUID); // braces intact
    expect(assertNfLocalId(result.position.receipt_id as string)).toBe(RUID);

    const pool = cannedPool('caviarnine_quantaswap', { kind: 'nft', resource: RECEIPT_RES });
    expect(buildNftWithdraw(USER, pool, result.position.receipt_id as string)).toContain(RUID);
  });

  test('a stored bare-integer receipt id still reaches buildNftWithdraw (Ociswap)', () => {
    // recorder stores '#42#' as '42'; assertNfLocalId normalizes back to '#42#'.
    const pool = cannedPool('ociswap_precision', { kind: 'nft', resource: RECEIPT_RES });
    expect(buildNftWithdraw(USER, pool, '42')).toContain('NonFungibleLocalId("#42#")');
  });

  test('rejects when neither an NFT nor the resolved LP was received', async () => {
    const noLpTx = async () => committedTx({ nonFungible: [] }); // outflow only
    const result = await recordDeposit(noLpTx, input, resolveFungibleLp);
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM positions').get()).toEqual({ n: 0 });
  });

  test('an unrelated inflow cannot pose as the LP', async () => {
    const decoyTx = async () =>
      committedTx({
        fungible: [
          { entity: USER, resource: XRD, change: '-500.25' },
          { entity: USER, resource: RECEIPT_RES, change: '999' }, // not the pool's LP
          { entity: POOL, resource: XRD, change: '500.25' },
        ],
        nonFungible: [],
      });
    const result = await recordDeposit(decoyTx, input, resolveFungibleLp);
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  test('pool resolution failure is a 502, not a recorded position', async () => {
    const result = await recordDeposit(fungibleTx, input, neverResolve);
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM positions').get()).toEqual({ n: 0 });
  });
});

// --- HTTP scoping ---

const TEST_PORT = 19878;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const OPERATOR = process.env.API_AUTH_TOKEN!;

function mockAgent(): AgentLoop {
  return {
    getState: () => ({ running: true, halted: false, lastScan: 0, errors: [], circuitBreaker: {}, pendingTx: 0 }),
    halt: () => {},
    start: () => {},
    isHalted: () => false,
  } as unknown as AgentLoop;
}

let server: ReturnType<typeof startApi> | null = null;

function seedPositions(): void {
  const insert = testDb.prepare(
    `INSERT INTO positions (protocol, pool_address, token_a, deposited_amount, status, user_address)
     VALUES ('ociswap', ?, ?, '100', 'active', ?)`,
  );
  insert.run(POOL, XRD, USER);
  insert.run(POOL, XRD, OTHER);
  insert.run(POOL, XRD, null); // the agent's own position
}

function sessionCookieFor(address: string): string {
  const { token } = createSession(address);
  return `farmer_session=${token}`;
}

describe('positions API scoping (D4)', () => {
  beforeAll(() => {
    server = startApi(mockAgent(), TEST_PORT);
  });
  afterAll(() => {
    server?.stop?.(true);
    server = null;
  });

  test('anonymous GET /api/positions is rejected', async () => {
    const res = await fetch(`${BASE}/api/positions`);
    expect(res.status).toBe(401);
  });

  test('a session sees only its own rows', async () => {
    seedPositions();
    const res = await fetch(`${BASE}/api/positions`, {
      headers: { Cookie: sessionCookieFor(USER) },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { user_address: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].user_address).toBe(USER);
  });

  test('the operator sees every row, including the agent’s own', async () => {
    seedPositions();
    const res = await fetch(`${BASE}/api/positions`, {
      headers: { Authorization: `Bearer ${OPERATOR}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toHaveLength(3);
  });

  test('GET /api/positions/:id enforces ownership for sessions', async () => {
    seedPositions();
    const cookie = sessionCookieFor(USER);
    const rows = testDb.prepare('SELECT id, user_address FROM positions').all() as {
      id: number;
      user_address: string | null;
    }[];
    const mine = rows.find((r) => r.user_address === USER)!;
    const theirs = rows.find((r) => r.user_address === OTHER)!;

    const okRes = await fetch(`${BASE}/api/positions/${mine.id}`, { headers: { Cookie: cookie } });
    expect(okRes.status).toBe(200);
    const denied = await fetch(`${BASE}/api/positions/${theirs.id}`, { headers: { Cookie: cookie } });
    expect(denied.status).toBe(404);
    const operator = await fetch(`${BASE}/api/positions/${theirs.id}`, {
      headers: { Authorization: `Bearer ${OPERATOR}` },
    });
    expect(operator.status).toBe(200);
  });

  test('POST /api/positions requires a wallet session (operator token alone is not an identity)', async () => {
    const res = await fetch(`${BASE}/api/positions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPERATOR}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent_hash: HASH, pool_address: POOL }),
    });
    expect(res.status).toBe(400);
  });

  test('POST /api/positions validates the intent hash before any gateway call', async () => {
    const res = await fetch(`${BASE}/api/positions`, {
      method: 'POST',
      headers: { Cookie: sessionCookieFor(USER), 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent_hash: 'garbage', pool_address: POOL }),
    });
    expect(res.status).toBe(400);
  });

  test('rotation proposals need an identity; the Bearer sees them (scoping: account-scope.test.ts)', async () => {
    const anon = await fetch(`${BASE}/api/rotation/pending`);
    expect(anon.status).toBe(401);
    const op = await fetch(`${BASE}/api/rotation/pending`, {
      headers: { Authorization: `Bearer ${OPERATOR}` },
    });
    expect(op.status).toBe(200);
  });
});
