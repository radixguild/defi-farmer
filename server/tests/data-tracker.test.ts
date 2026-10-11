import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setTestDb } from '../src/db/schema';
import {
  initTrackingTables,
  recordSnapshot,
  recordPoolSnapshots,
  recordDailyVolume,
  getPoolSnapshots,
  getLatestSnapshots,
  getTvlHistory,
  computeAndStoreYieldHistory,
  getLatestYield,
  getDailyVolumes,
  pruneOldData,
} from '../src/services/data-tracker';

let testDb: Database;

function setupDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // Need the base tables for getDb() compatibility
  db.exec(`
    CREATE TABLE IF NOT EXISTS pool_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_address TEXT NOT NULL,
      protocol TEXT NOT NULL,
      tvl TEXT NOT NULL,
      apy_bps INTEGER NOT NULL,
      scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pool_snap ON pool_snapshots(pool_address, scanned_at);

    CREATE TABLE IF NOT EXISTS pool_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_address TEXT NOT NULL,
      protocol TEXT NOT NULL,
      score REAL NOT NULL,
      apy_ma_7d REAL NOT NULL,
      tvl_variance REAL NOT NULL,
      classification TEXT NOT NULL,
      computed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

beforeEach(() => {
  testDb = setupDb();
  setTestDb(testDb);
  initTrackingTables();
});

afterAll(() => {
  setTestDb(null);
  testDb?.close();
});

const POOL_A = 'component_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky';

describe('initTrackingTables', () => {
  test('creates tables without error', () => {
    // If we get here, tables were created successfully
    const tables = testDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('pool_snapshots_v2');
    expect(names).toContain('pool_volume_daily');
    expect(names).toContain('yield_history');
  });

  test('safe to call multiple times', () => {
    initTrackingTables();
    initTrackingTables();
    // Should not throw
  });
});

describe('recordSnapshot', () => {
  test('inserts a snapshot', () => {
    recordSnapshot({
      poolAddress: POOL_A,
      protocol: 'ociswap',
      tvl: '1000000',
      apyBps: 1500,
      tokenAReserve: '500000',
      tokenBReserve: '200',
      feeRateBps: 30,
      volume24h: '50000',
      fees24h: '150',
    });

    const rows = testDb.prepare('SELECT * FROM pool_snapshots_v2').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].pool_address).toBe(POOL_A);
    expect(rows[0].tvl).toBe('1000000');
    expect(rows[0].apy_bps).toBe(1500);
    expect(rows[0].token_a_reserve).toBe('500000');
  });
});

describe('recordPoolSnapshots', () => {
  test('inserts from PoolInfo array', () => {
    recordPoolSnapshots([
      {
        address: POOL_A,
        name: 'XRD-xUSDC',
        tokenA: 'XRD',
        tokenB: 'xUSDC',
        tvl: '2000000',
        apy: 12.5,
        protocol: 'ociswap',
        audited: true,
        apySource: 'live',
      },
    ]);

    const rows = testDb.prepare('SELECT * FROM pool_snapshots_v2').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].apy_bps).toBe(1250);
  });
});

describe('getPoolSnapshots', () => {
  test('returns snapshots within time range', () => {
    // Insert a recent snapshot
    recordSnapshot({
      poolAddress: POOL_A,
      protocol: 'ociswap',
      tvl: '1000000',
      apyBps: 1500,
      tokenAReserve: '0',
      tokenBReserve: '0',
      feeRateBps: 0,
      volume24h: '0',
      fees24h: '0',
    });

    const snaps = getPoolSnapshots(POOL_A, 24);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].pool_address).toBe(POOL_A);
  });

  test('returns empty for unknown pool', () => {
    const snaps = getPoolSnapshots('component_rdx1unknown', 24);
    expect(snaps).toHaveLength(0);
  });
});

describe('getLatestSnapshots', () => {
  test('returns one row per pool', () => {
    // Insert two snapshots with different timestamps so MAX picks the latest
    testDb.exec(
      `INSERT INTO pool_snapshots_v2
       (pool_address, protocol, tvl, apy_bps, token_a_reserve, token_b_reserve, fee_rate_bps, volume_24h, fees_24h, snapshot_at)
       VALUES ('${POOL_A}', 'ociswap', '1000000', 1500, '0', '0', 0, '0', '0', datetime('now', '-1 hours'))`,
    );
    testDb.exec(
      `INSERT INTO pool_snapshots_v2
       (pool_address, protocol, tvl, apy_bps, token_a_reserve, token_b_reserve, fee_rate_bps, volume_24h, fees_24h, snapshot_at)
       VALUES ('${POOL_A}', 'ociswap', '1100000', 1600, '0', '0', 0, '0', '0', datetime('now'))`,
    );

    const latest = getLatestSnapshots();
    expect(latest).toHaveLength(1);
    expect(latest[0].tvl).toBe('1100000');
  });
});

describe('recordDailyVolume', () => {
  test('inserts new daily volume', () => {
    recordDailyVolume(POOL_A, 'ociswap', '50000', '150', 42);

    const rows = testDb.prepare('SELECT * FROM pool_volume_daily').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].volume_usd).toBe('50000');
    expect(rows[0].tx_count).toBe(42);
  });

  test('accumulates within same day', () => {
    recordDailyVolume(POOL_A, 'ociswap', '50000', '150', 42);
    recordDailyVolume(POOL_A, 'ociswap', '30000', '90', 20);

    const rows = testDb.prepare('SELECT * FROM pool_volume_daily').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].volume_usd)).toBeCloseTo(80000, 0);
    expect(rows[0].tx_count).toBe(62);
  });
});

describe('getDailyVolumes', () => {
  test('returns volumes in date order', () => {
    recordDailyVolume(POOL_A, 'ociswap', '50000', '150', 42);
    const vols = getDailyVolumes(POOL_A, 7);
    expect(vols).toHaveLength(1);
    expect(vols[0].volume_usd).toBe('50000');
  });
});

describe('computeAndStoreYieldHistory', () => {
  test('computes yield from snapshots', () => {
    // Insert some snapshots
    for (let i = 0; i < 5; i++) {
      testDb.exec(
        `INSERT INTO pool_snapshots_v2
         (pool_address, protocol, tvl, apy_bps, token_a_reserve, token_b_reserve, fee_rate_bps, volume_24h, fees_24h, snapshot_at)
         VALUES ('${POOL_A}', 'ociswap', '1000000', 1500, '0', '0', 0, '0', '0', datetime('now', '-${i} hours'))`,
      );
    }

    computeAndStoreYieldHistory(POOL_A, 'ociswap');

    const yields = getLatestYield(POOL_A);
    expect(yields['24h']).toBeDefined();
    expect(yields['24h'].apr).toBe(15); // 1500 bps = 15%
    expect(yields['24h'].apy).toBeGreaterThan(15); // APY > APR
  });
});

describe('getTvlHistory', () => {
  test('returns TVL timeline', () => {
    recordSnapshot({
      poolAddress: POOL_A,
      protocol: 'ociswap',
      tvl: '1000000',
      apyBps: 1500,
      tokenAReserve: '0',
      tokenBReserve: '0',
      feeRateBps: 0,
      volume24h: '0',
      fees24h: '0',
    });

    const history = getTvlHistory(POOL_A, 24);
    expect(history).toHaveLength(1);
    expect(history[0].tvl).toBe('1000000');
  });
});

describe('pruneOldData', () => {
  function countOf(table: string): number {
    return (testDb.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
  }

  function seedSnapshot(daysAgo: number): void {
    testDb.exec(
      `INSERT INTO pool_snapshots (pool_address, protocol, tvl, apy_bps, scanned_at)
       VALUES ('${POOL_A}', 'ociswap', '1000000', 1500, datetime('now', '-${daysAgo} days'))`,
    );
  }

  function seedScore(daysAgo: number): void {
    testDb.exec(
      `INSERT INTO pool_scores (pool_address, protocol, score, apy_ma_7d, tvl_variance, classification, computed_at)
       VALUES ('${POOL_A}', 'ociswap', 80, 15, 0.1, 'stable', datetime('now', '-${daysAgo} days'))`,
    );
  }

  test('prunes the two tables the agent actually writes every scan', () => {
    // The pre-2026-07-25 implementation only touched pool_snapshots_v2, which
    // the live DB had never created — so these two grew to 1.37M rows each.
    seedSnapshot(100);
    seedSnapshot(1);
    seedScore(100);
    seedScore(1);

    const removed = pruneOldData(30);

    expect(removed.snapshots).toBe(1);
    expect(removed.scores).toBe(1);
    expect(countOf('pool_snapshots')).toBe(1);
    expect(countOf('pool_scores')).toBe(1);
  });

  test('keeps everything inside the retention window', () => {
    seedSnapshot(29);
    seedScore(29);

    const removed = pruneOldData(30);

    expect(removed.snapshots).toBe(0);
    expect(removed.scores).toBe(0);
    expect(countOf('pool_snapshots')).toBe(1);
    expect(countOf('pool_scores')).toBe(1);
  });

  test('still prunes pool_snapshots_v2 where it exists', () => {
    testDb.exec(
      `INSERT INTO pool_snapshots_v2
       (pool_address, protocol, tvl, apy_bps, token_a_reserve, token_b_reserve, fee_rate_bps, volume_24h, fees_24h, snapshot_at)
       VALUES ('${POOL_A}', 'ociswap', '1000000', 1500, '0', '0', 0, '0', '0', datetime('now', '-100 days'))`,
    );
    recordSnapshot({
      poolAddress: POOL_A,
      protocol: 'ociswap',
      tvl: '1100000',
      apyBps: 1600,
      tokenAReserve: '0',
      tokenBReserve: '0',
      feeRateBps: 0,
      volume24h: '0',
      fees24h: '0',
    });

    expect(pruneOldData(90).snapshotsV2).toBe(1);
    expect(countOf('pool_snapshots_v2')).toBe(1);
  });

  test('skips tables that do not exist instead of throwing', () => {
    // The live DB has no pool_snapshots_v2; prune must not blow up the tick.
    testDb.exec('DROP TABLE pool_snapshots_v2');
    seedSnapshot(100);

    const removed = pruneOldData(30);

    expect(removed.snapshotsV2).toBe(0);
    expect(removed.snapshots).toBe(1);
  });

  function seedManyOld(rows: number): void {
    testDb.exec(
      `INSERT INTO pool_snapshots (pool_address, protocol, tvl, apy_bps, scanned_at)
       SELECT '${POOL_A}', 'ociswap', '1000000', 1500, datetime('now', '-100 days')
       FROM (WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows}) SELECT i FROM n)`,
    );
  }

  test('deletes a backlog larger than one batch', () => {
    // Guards the batching loop's termination across more than one batch.
    seedManyOld(20001);
    seedSnapshot(1);

    expect(pruneOldData(30).snapshots).toBe(20001);
    expect(countOf('pool_snapshots')).toBe(1);
  });

  test('caps work per sweep so a backlog cannot hang the tick', () => {
    // bun:sqlite is synchronous and this process serves the API too. Clearing
    // the live 1.5M-row backlog measured ~19s; a sweep must never block that
    // long, so it stops at the ceiling and resumes next sweep.
    seedManyOld(60001);
    seedSnapshot(1);

    const first = pruneOldData(30);
    expect(first.snapshots).toBe(50000);
    // `capped` is what tells the loop to resume next tick rather than next day
    // — without it a backlog takes ~28 days to drain, or never catches up.
    expect(first.capped).toBe(true);
    expect(countOf('pool_snapshots')).toBe(10002);

    // The remainder drains on the following sweep.
    const second = pruneOldData(30);
    expect(second.snapshots).toBe(10001);
    expect(second.capped).toBe(false);
    expect(countOf('pool_snapshots')).toBe(1);
  });

  test('refuses a retention window shorter than the longest reader', () => {
    // Destructive function: a negative window inverts the cutoff into the
    // future and would wipe the table.
    seedSnapshot(1);
    expect(() => pruneOldData(-5)).toThrow();
    expect(() => pruneOldData(0)).toThrow();
    expect(() => pruneOldData(7)).toThrow();
    expect(countOf('pool_snapshots')).toBe(1);
  });

  test('does not strand a row at rowid 0', () => {
    // COALESCE(MAX(rowid),0) used to conflate "no matches" with "the newest
    // match is rowid 0", leaving that row un-prunable forever.
    testDb.exec(
      `INSERT INTO pool_snapshots (id, pool_address, protocol, tvl, apy_bps, scanned_at)
       VALUES (0, '${POOL_A}', 'ociswap', '1', 1, datetime('now', '-100 days'))`,
    );
    expect(pruneOldData(30).snapshots).toBe(1);
    expect(countOf('pool_snapshots')).toBe(0);
  });

  test('leaves rows inside the window even when they sit below the boundary rowid', () => {
    // The boundary rowid is an optimisation, not the correctness predicate:
    // a recent row with a LOW rowid must survive.
    testDb.exec(
      `INSERT INTO pool_snapshots (pool_address, protocol, tvl, apy_bps, scanned_at)
       VALUES ('${POOL_A}', 'ociswap', '1', 1, datetime('now', '-1 days'))`,
    );
    seedSnapshot(100); // higher rowid, older timestamp -> raises the boundary

    expect(pruneOldData(30).snapshots).toBe(1);
    expect(countOf('pool_snapshots')).toBe(1);
  });

  test('is a no-op on empty tables', () => {
    const removed = pruneOldData(30);
    expect(removed.snapshots).toBe(0);
    expect(removed.scores).toBe(0);
  });
});
