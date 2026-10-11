/// closePosition (the exit half of D5).
///
/// Until it existed, nothing wrote status='closed' — a verified deposit stayed
/// counted in the portfolio forever. These tests pin the fail-closed contract:
/// evidence of the position LEAVING the owner's account, from the Gateway's
/// committed-details, or no close.

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema, setTestDb } from '../src/db/schema';
import { closePosition } from '../src/services/position-recorder';
import type { CommittedTx } from '../src/services/gateway';

const USER = 'account_rdx1c9dka8al9kd0a93q8ag4mjs3fzassqef0lk6hg757tqfma5hu0n3gy';
const OTHER = 'account_rdx1cxaqwoxvxyvuqzvxw2z5c9dka8al9kd0a93q8ag4mjs3fzassqef0lk';
const POOL = 'component_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky';
const LP_RES = 'resource_rdx1t5poolunitbasicorweighted0aaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NFT_RES = 'resource_rdx1t45js47zxtqa5ycqhj95lax3fz9yg3h20rafy8fauxz6wd3cmpfhg8';
const OPEN_HASH = 'txid_rdx1openhashvalidshape0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CLOSE_HASH = 'txid_rdx1closehashvalidshape0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_HASH = 'txid_rdx1otherhashvalidshape0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

let testDb: Database;

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
  setTestDb(testDb);
});

afterAll(() => {
  setTestDb(null);
  testDb?.close();
});

function insertPosition(overrides: Record<string, unknown> = {}): number {
  const row = {
    protocol: 'ociswap',
    pool_address: POOL,
    receipt_id: null as string | null,
    receipt_resource: LP_RES,
    lp_amount: '12.5',
    token_a: 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd',
    deposited_amount: '500',
    status: 'active',
    user_address: USER,
    intent_hash: OPEN_HASH,
    ...overrides,
  };
  const res = testDb
    .prepare(
      `INSERT INTO positions (protocol, pool_address, receipt_id, receipt_resource, lp_amount,
         token_a, deposited_amount, status, user_address, intent_hash)
       VALUES ($protocol, $pool_address, $receipt_id, $receipt_resource, $lp_amount,
         $token_a, $deposited_amount, $status, $user_address, $intent_hash)`,
    )
    .run(
      Object.fromEntries(Object.entries(row).map(([k, v]) => [`$${k}`, v as never])) as never,
    );
  return Number(res.lastInsertRowid);
}

/// A withdraw that returns the LP from USER to the pool.
function withdrawTx(overrides: Partial<CommittedTx> = {}): CommittedTx {
  return {
    status: 'CommittedSuccess',
    affectedEntities: [USER, POOL],
    fungible: [
      { entity: USER, resource: LP_RES, change: '-12.5' },
      { entity: POOL, resource: LP_RES, change: '12.5' },
    ],
    nonFungible: [],
    ...overrides,
  };
}

const asUser = { userAddress: USER, isOperator: false };

describe('closePosition — verified exit', () => {
  test('happy path: LP outflow closes the row and stamps the close hash', async () => {
    const id = insertPosition();
    const r = await closePosition(async () => withdrawTx(), {
      positionId: id, intentHash: CLOSE_HASH, ...asUser,
    });
    expect(r).toMatchObject({ ok: true, alreadyClosed: false, position: { id, status: 'closed' } });
    const row = testDb.prepare('SELECT status, close_intent_hash, closed_at FROM positions WHERE id = ?').get(id) as {
      status: string; close_intent_hash: string; closed_at: string | null;
    };
    expect(row.status).toBe('closed');
    expect(row.close_intent_hash).toBe(CLOSE_HASH);
    expect(row.closed_at).toBeTruthy();
  });

  test('NFT position: closes on the receipt local id leaving the account', async () => {
    const id = insertPosition({ receipt_resource: NFT_RES, receipt_id: '42', lp_amount: null });
    const r = await closePosition(
      async () =>
        withdrawTx({
          fungible: [],
          nonFungible: [{ entity: USER, resource: NFT_RES, added: [], removed: ['#42#'] }],
        }),
      { positionId: id, intentHash: CLOSE_HASH, ...asUser },
    );
    expect(r.ok).toBe(true);
  });

  test('NFT position: a DIFFERENT local id leaving does not close it', async () => {
    const id = insertPosition({ receipt_resource: NFT_RES, receipt_id: '42', lp_amount: null });
    const r = await closePosition(
      async () =>
        withdrawTx({
          fungible: [],
          nonFungible: [{ entity: USER, resource: NFT_RES, added: [], removed: ['#43#'] }],
        }),
      { positionId: id, intentHash: CLOSE_HASH, ...asUser },
    );
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  test('a committed tx that touches the pool but returns nothing does NOT close', async () => {
    // e.g. a FRESH DEPOSIT batched with an unrelated transfer — LP flows IN.
    const id = insertPosition();
    const r = await closePosition(
      async () => withdrawTx({ fungible: [{ entity: USER, resource: LP_RES, change: '5.0' }] }),
      { positionId: id, intentHash: CLOSE_HASH, ...asUser },
    );
    expect(r).toMatchObject({ ok: false, status: 400 });
    const row = testDb.prepare('SELECT status FROM positions WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('active');
  });

  test('someone else cannot close your position', async () => {
    const id = insertPosition();
    const r = await closePosition(async () => withdrawTx(), {
      positionId: id, intentHash: CLOSE_HASH, userAddress: OTHER, isOperator: false,
    });
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  test('operator may close, but the evidence is still judged against the OWNER account', async () => {
    const id = insertPosition();
    // Withdraw evidence involves OTHER, not the row owner — operator or not, no close.
    const bad = await closePosition(
      async () =>
        withdrawTx({
          affectedEntities: [OTHER, POOL],
          fungible: [{ entity: OTHER, resource: LP_RES, change: '-12.5' }],
        }),
      { positionId: id, intentHash: CLOSE_HASH, userAddress: null, isOperator: true },
    );
    expect(bad.ok).toBe(false);
    const good = await closePosition(async () => withdrawTx(), {
      positionId: id, intentHash: CLOSE_HASH, userAddress: null, isOperator: true,
    });
    expect(good.ok).toBe(true);
  });

  test('uncommitted and failed transactions are refused', async () => {
    const id = insertPosition();
    for (const status of ['Pending', 'CommittedFailure', 'Unknown']) {
      const r = await closePosition(async () => withdrawTx({ status }), {
        positionId: id, intentHash: CLOSE_HASH, ...asUser,
      });
      expect(r).toMatchObject({ ok: false, status: 409 });
    }
  });

  test('tx must touch both the pool and the owner account', async () => {
    const id = insertPosition();
    const noPool = await closePosition(
      async () => withdrawTx({ affectedEntities: [USER] }),
      { positionId: id, intentHash: CLOSE_HASH, ...asUser },
    );
    expect(noPool).toMatchObject({ ok: false, status: 400 });
    const noUser = await closePosition(
      async () => withdrawTx({ affectedEntities: [POOL] }),
      { positionId: id, intentHash: CLOSE_HASH, ...asUser },
    );
    expect(noUser).toMatchObject({ ok: false, status: 403 });
  });

  test('re-close with the same hash is idempotent; a different hash is a 409', async () => {
    const id = insertPosition();
    await closePosition(async () => withdrawTx(), { positionId: id, intentHash: CLOSE_HASH, ...asUser });
    const again = await closePosition(async () => withdrawTx(), {
      positionId: id, intentHash: CLOSE_HASH, ...asUser,
    });
    expect(again).toMatchObject({ ok: true, alreadyClosed: true });
    const different = await closePosition(async () => withdrawTx(), {
      positionId: id, intentHash: OTHER_HASH, ...asUser,
    });
    expect(different).toMatchObject({ ok: false, status: 409 });
  });

  test('NULL-owner (agent-era) rows cannot be closed — no account to verify against', async () => {
    const id = insertPosition({ user_address: null, intent_hash: null });
    const r = await closePosition(async () => withdrawTx(), {
      positionId: id, intentHash: CLOSE_HASH, userAddress: null, isOperator: true,
    });
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  test('malformed inputs never reach the gateway', async () => {
    const id = insertPosition();
    let calls = 0;
    const spy = async () => ((calls++), withdrawTx());
    expect(await closePosition(spy, { positionId: 'x', intentHash: CLOSE_HASH, ...asUser }))
      .toMatchObject({ ok: false, status: 400 });
    expect(await closePosition(spy, { positionId: id, intentHash: 'DROP TABLE', ...asUser }))
      .toMatchObject({ ok: false, status: 400 });
    expect(calls).toBe(0);
  });

  test('unknown position id is a 404', async () => {
    const r = await closePosition(async () => withdrawTx(), {
      positionId: 9999, intentHash: CLOSE_HASH, ...asUser,
    });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
});
