import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { RotationManager } from '../src/services/rotation';
import { OpportunityScorer } from '../src/services/scorer';
import type { Position } from '../src/db/schema';
import { setTestDb } from '../src/db/schema';

let testDb: Database;
const scorer = new OpportunityScorer();
let rotation: RotationManager;

function setupSchema(db: Database): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      intent_hash TEXT PRIMARY KEY,
      manifest_hash TEXT NOT NULL,
      operation TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      details TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_tx_manifest ON transactions(manifest_hash);

    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      protocol TEXT NOT NULL,
      pool_address TEXT NOT NULL,
      receipt_id TEXT,
      receipt_resource TEXT,
      token_a TEXT NOT NULL,
      token_b TEXT,
      deposited_amount TEXT NOT NULL,
      current_value TEXT,
      apy_bps INTEGER,
      risk_level TEXT DEFAULT 'unknown',
      deposited_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'active',
      classification TEXT DEFAULT 'rotational',
      entry_apy_bps INTEGER,
      cooldown_until TEXT,
      last_review_at TEXT
    );

    CREATE TABLE IF NOT EXISTS pool_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_address TEXT NOT NULL,
      protocol TEXT NOT NULL,
      tvl TEXT NOT NULL,
      apy_bps INTEGER NOT NULL,
      scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pool_snap ON pool_snapshots(pool_address, scanned_at);

    CREATE TABLE IF NOT EXISTS rotation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_pool TEXT NOT NULL,
      to_pool TEXT NOT NULL,
      from_protocol TEXT NOT NULL,
      to_protocol TEXT NOT NULL,
      amount TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed',
      proposed_at TEXT NOT NULL DEFAULT (datetime('now')),
      executed_at TEXT,
      intent_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rotation_log_status ON rotation_log(status, proposed_at);
  `);
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 1,
    protocol: 'ociswap',
    pool_address: 'component_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky',
    receipt_id: null,
    receipt_resource: null,
    token_a: 'XRD',
    token_b: 'TOKEN',
    deposited_amount: '1000',
    current_value: null,
    apy_bps: 1000,
    risk_level: 'unknown',
    deposited_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'active',
    classification: 'rotational',
    entry_apy_bps: 1500,
    cooldown_until: null,
    last_review_at: null,
    // NULL owner = a bot-owned row (Phase 3.1 D4), which is what the rotation
    // engine operates on. These two arrived with Phase 3.1 and the mock never
    // caught up — nothing typechecked tests/ until F2 was closed.
    user_address: null,
    intent_hash: null,
    closed_at: null,
    close_intent_hash: null,
    ...overrides,
  };
}

beforeEach(() => {
  testDb = new Database(':memory:');
  setupSchema(testDb);
  setTestDb(testDb);
  rotation = new RotationManager(scorer);
});

afterAll(() => {
  setTestDb(null);
  testDb?.close();
});

describe('checkExitGuards', () => {
  test('fires when APY drops >30% from entry', () => {
    // entry_apy_bps = 1500, current apy_bps = 1000 -> 33% drop
    const pos = makePosition({ entry_apy_bps: 1500, apy_bps: 1000 });
    const signals = rotation.checkExitGuards([pos]);
    expect(signals.length).toBe(1);
    expect(signals[0].urgency).toBe('emergency');
  });

  test('no exit signal when APY drop below threshold', () => {
    // entry_apy_bps = 1500, current apy_bps = 1200 -> 20% drop (below 30% threshold)
    const pos = makePosition({ entry_apy_bps: 1500, apy_bps: 1200 });
    const signals = rotation.checkExitGuards([pos]);
    expect(signals.length).toBe(0);
  });

  test('inactive positions ignored by exit guards', () => {
    const pos = makePosition({ status: 'closed', entry_apy_bps: 1500, apy_bps: 500 });
    const signals = rotation.checkExitGuards([pos]);
    expect(signals.length).toBe(0);
  });
});

describe('weeklyReview', () => {
  test('proposes rotation when better pool available and no cooldown', () => {
    // Need multiple positions so diversification filter (40% pool cap) doesn't block.
    // Sizes must clear the #5 net-benefit gate: the move's yield gain over 30d
    // has to out-earn gas + swap costs.
    const pos = makePosition({
      id: 1,
      apy_bps: 500,
      classification: 'rotational',
      deposited_amount: '30000',
    });
    const pos2 = makePosition({
      id: 2,
      pool_address: 'component_rdx1cpgmgrskahkxe4lnpp9s2f5ga0z8jkl7ne8gjmw3fc2224lxq505mr',
      apy_bps: 2000,
      classification: 'rotational',
      deposited_amount: '70000',
    });

    const scored = scorer.scoreAll(
      [
        {
          address: 'component_rdx1cqs338cyje65rk44zgmjvvy42qcszrhk9ewznedtkqd8l3crtgnmh5',
          name: 'XRD-BETTER',
          tokenA: 'XRD',
          tokenB: 'BETTER',
          tvl: '2000000',
          apy: 20,
          protocol: 'caviarnine',
          audited: true,
          apySource: 'live',
          // calm live risk: keep these fixtures' intent (apy drives behavior)
          risk: { volatility: 0.005, correlation: 0.9, relAnnualVol: 0.05, estimatedIlPct: -0.03, source: 'live' as const },
        },
      ],
      [],
    );

    const proposals = rotation.weeklyReview([pos, pos2], scored);
    // Allocator may generate multiple rotations to fill the target allocation
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals[0].toPool).toBe('component_rdx1cqs338cyje65rk44zgmjvvy42qcszrhk9ewznedtkqd8l3crtgnmh5');
  });

  test('the net-benefit gate refuses uneconomic dust rotations (#5)', () => {
    // Same APY edge as above, but 100× smaller: +1500bps on ~300 XRD earns a
    // few XRD per month — less than gas + swap costs. Nothing may be proposed.
    const pos = makePosition({
      id: 1,
      apy_bps: 500,
      classification: 'rotational',
      deposited_amount: '300',
    });
    const pos2 = makePosition({
      id: 2,
      pool_address: 'component_rdx1cpgmgrskahkxe4lnpp9s2f5ga0z8jkl7ne8gjmw3fc2224lxq505mr',
      apy_bps: 2000,
      classification: 'rotational',
      deposited_amount: '700',
    });
    const scored = scorer.scoreAll(
      [
        {
          address: 'component_rdx1cqs338cyje65rk44zgmjvvy42qcszrhk9ewznedtkqd8l3crtgnmh5',
          name: 'XRD-BETTER',
          tokenA: 'XRD',
          tokenB: 'BETTER',
          tvl: '2000000',
          apy: 20,
          protocol: 'caviarnine',
          audited: true,
          apySource: 'live',
          risk: { volatility: 0.005, correlation: 0.9, relAnnualVol: 0.05, estimatedIlPct: -0.03, source: 'live' as const },
        },
      ],
      [],
    );

    const proposals = rotation.weeklyReview([pos, pos2], scored);
    expect(proposals).toHaveLength(0);
    const logged = testDb.prepare('SELECT COUNT(*) AS n FROM rotation_log').get() as { n: number };
    expect(logged.n).toBe(0);
  });

  test('skips stable positions', () => {
    const pos = makePosition({ classification: 'stable', apy_bps: 500 });
    const scored = scorer.scoreAll(
      [
        {
          address: 'component_rdx1cqs338cyje65rk44zgmjvvy42qcszrhk9ewznedtkqd8l3crtgnmh5',
          name: 'XRD-BETTER',
          tokenA: 'XRD',
          tokenB: 'BETTER',
          tvl: '2000000',
          apy: 50,
          protocol: 'caviarnine',
          audited: true,
          apySource: 'live',
          // calm live risk: keep these fixtures' intent (apy drives behavior)
          risk: { volatility: 0.005, correlation: 0.9, relAnnualVol: 0.05, estimatedIlPct: -0.03, source: 'live' as const },
        },
      ],
      [],
    );
    const proposals = rotation.weeklyReview([pos], scored);
    expect(proposals.length).toBe(0);
  });

  test('skips positions in cooldown', () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const pos = makePosition({
      classification: 'rotational',
      apy_bps: 500,
      cooldown_until: future,
    });
    const scored = scorer.scoreAll(
      [
        {
          address: 'component_rdx1cqs338cyje65rk44zgmjvvy42qcszrhk9ewznedtkqd8l3crtgnmh5',
          name: 'XRD-BETTER',
          tokenA: 'XRD',
          tokenB: 'BETTER',
          tvl: '2000000',
          apy: 50,
          protocol: 'caviarnine',
          audited: true,
          apySource: 'live',
          // calm live risk: keep these fixtures' intent (apy drives behavior)
          risk: { volatility: 0.005, correlation: 0.9, relAnnualVol: 0.05, estimatedIlPct: -0.03, source: 'live' as const },
        },
      ],
      [],
    );
    const proposals = rotation.weeklyReview([pos], scored);
    expect(proposals.length).toBe(0);
  });

  test('proposals persisted to rotation_log table', () => {
    // Sizes clear the #5 net-benefit gate (see the gate test for the dust case).
    const pos = makePosition({
      id: 1,
      apy_bps: 500,
      classification: 'rotational',
      deposited_amount: '30000',
    });
    const pos2 = makePosition({
      id: 2,
      pool_address: 'component_rdx1cpgmgrskahkxe4lnpp9s2f5ga0z8jkl7ne8gjmw3fc2224lxq505mr',
      apy_bps: 2000,
      classification: 'rotational',
      deposited_amount: '70000',
    });
    const scored = scorer.scoreAll(
      [
        {
          address: 'component_rdx1cqs338cyje65rk44zgmjvvy42qcszrhk9ewznedtkqd8l3crtgnmh5',
          name: 'XRD-BETTER',
          tokenA: 'XRD',
          tokenB: 'BETTER',
          tvl: '2000000',
          apy: 50,
          protocol: 'caviarnine',
          audited: true,
          apySource: 'live',
          // calm live risk: keep these fixtures' intent (apy drives behavior)
          risk: { volatility: 0.005, correlation: 0.9, relAnnualVol: 0.05, estimatedIlPct: -0.03, source: 'live' as const },
        },
      ],
      [],
    );
    rotation.weeklyReview([pos, pos2], scored);
    const rows = testDb.prepare('SELECT * FROM rotation_log').all() as Array<{ status: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].status).toBe('proposed');
  });

  // Advisor idempotency: lastRotationReview is in-memory (0 on every boot), so
  // the review re-runs on each restart. A standing pending proposal must NOT be
  // duplicated in rotation_log (it already surfaces in the operator UI).
  test('a still-pending proposal is not re-inserted on a repeat review', () => {
    const pos = makePosition({ id: 1, apy_bps: 500, classification: 'rotational', deposited_amount: '30000' });
    const pos2 = makePosition({
      id: 2,
      pool_address: 'component_rdx1cpgmgrskahkxe4lnpp9s2f5ga0z8jkl7ne8gjmw3fc2224lxq505mr',
      apy_bps: 2000, classification: 'rotational', deposited_amount: '70000',
    });
    const scored = scorer.scoreAll(
      [
        {
          address: 'component_rdx1cqs338cyje65rk44zgmjvvy42qcszrhk9ewznedtkqd8l3crtgnmh5',
          name: 'XRD-BETTER', tokenA: 'XRD', tokenB: 'BETTER', tvl: '2000000',
          apy: 50, protocol: 'caviarnine', audited: true, apySource: 'live',
          risk: { volatility: 0.005, correlation: 0.9, relAnnualVol: 0.05, estimatedIlPct: -0.03, source: 'live' as const },
        },
      ],
      [],
    );
    const first = rotation.weeklyReview([pos, pos2], scored);
    expect(first.length).toBeGreaterThan(0);
    const afterFirst = (testDb.prepare('SELECT COUNT(*) AS n FROM rotation_log').get() as { n: number }).n;

    // Simulate a restart: same review runs again with the proposal still pending.
    const second = rotation.weeklyReview([pos, pos2], scored);
    const afterSecond = (testDb.prepare('SELECT COUNT(*) AS n FROM rotation_log').get() as { n: number }).n;
    expect(second).toHaveLength(0); // nothing NEW proposed
    expect(afterSecond).toBe(afterFirst); // no duplicate rows
  });
});
