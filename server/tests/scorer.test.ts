import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { OpportunityScorer } from '../src/services/scorer';
import type { PoolInfo } from '../src/services/gateway';
import { setTestDb } from '../src/db/schema';

let testDb: Database;
const scorer = new OpportunityScorer();

/// Benign pair risk (calm, correlated — negligible IL) so tests that vary a
/// single dimension aren't drowned by the skeptical unenriched-pool default.
const CALM_RISK: PoolInfo['risk'] = {
  volatility: 0.005,
  correlation: 0.9,
  relAnnualVol: 0.05,
  estimatedIlPct: -0.03,
  source: 'live',
};

function makePool(overrides: Partial<PoolInfo> = {}): PoolInfo {
  return {
    address: 'component_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky',
    name: 'XRD-TOKEN',
    tokenA: 'XRD',
    tokenB: 'TOKEN',
    tvl: '1000000',
    apy: 10,
    protocol: 'ociswap',
    audited: true,
    apySource: 'live',
    risk: CALM_RISK,
    ...overrides,
  };
}

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.exec('PRAGMA journal_mode = WAL');
  testDb.exec('PRAGMA foreign_keys = ON');
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS pool_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_address TEXT NOT NULL,
      protocol TEXT NOT NULL,
      tvl TEXT NOT NULL,
      apy_bps INTEGER NOT NULL,
      scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pool_snap ON pool_snapshots(pool_address, scanned_at);

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
  `);
  setTestDb(testDb);
});

afterAll(() => {
  setTestDb(null);
  testDb?.close();
});

describe('classifyPool', () => {
  test('XRD-xUSDC -> stable', () => {
    expect(scorer.classifyPool(makePool({ name: 'XRD-xUSDC' }))).toBe('stable');
  });

  test('XRD-xETH -> stable', () => {
    expect(scorer.classifyPool(makePool({ name: 'XRD-xETH' }))).toBe('stable');
  });

  test('XRD-MEME -> rotational', () => {
    expect(scorer.classifyPool(makePool({ name: 'XRD-MEME', tokenA: 'XRD', tokenB: 'MEME' }))).toBe('rotational');
  });
});

describe('scoreAll', () => {
  test('returns sorted list highest score first', () => {
    const pools = [
      makePool({ address: 'component_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky', apy: 5 }),
      makePool({ address: 'component_rdx1cqs338cyje65rk44zgmjvvy42qcszrhk9ewznedtkqd8l3crtgnmh5', apy: 20 }),
      makePool({ address: 'component_rdx1cpgmgrskahkxe4lnpp9s2f5ga0z8jkl7ne8gjmw3fc2224lxq505mr', apy: 10 }),
    ];
    const scored = scorer.scoreAll(pools, []);
    expect(scored[0].apy).toBe(20);
    expect(scored[scored.length - 1].apy).toBe(5);
    // Scores should be descending
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i - 1].score).toBeGreaterThanOrEqual(scored[i].score);
    }
  });

  // MONETIZATION #1 acceptance: gross yield cannot buy its way past IL.
  test('a 40%-gross pool bleeding IL ranks below a safe 15% pool', () => {
    const risky = makePool({
      address: 'component_rdx1cqs338cyje65rk44zgmjvvy42qcszrhk9ewznedtkqd8l3crtgnmh5',
      name: 'XRD-MEME',
      apy: 40,
      risk: {
        volatility: 0.074, // ~141% annualized per token
        correlation: 0,
        relAnnualVol: 1.41,
        estimatedIlPct: -24.9, // −(1.41²/8)·100
        source: 'live',
      },
    });
    const safe = makePool({
      address: 'component_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky',
      name: 'XRD-xUSDC',
      apy: 15,
      risk: CALM_RISK,
    });
    const scored = scorer.scoreAll([risky, safe], []);
    // nets are near-equal by construction (≈15 both) — the IL-risk component
    // must still put the safe pool first
    expect(scored[0].address).toBe(safe.address);
    // and the risky pool's net reflects the bleed, not the headline
    const riskyScored = scored.find((s) => s.address === risky.address)!;
    expect(riskyScored.estimatedIl).toBeCloseTo(-24.9, 1);
    expect(riskyScored.netApyMa7d).toBeCloseTo(15.1, 1);
    expect(riskyScored.ilRiskScore).toBeGreaterThan(scored[0].ilRiskScore);
  });

  test('unsupported-blueprint pools are excluded from ranking', () => {
    const supported = makePool({});
    const unsupported = makePool({
      address: 'component_rdx1cqs338cyje65rk44zgmjvvy42qcszrhk9ewznedtkqd8l3crtgnmh5',
      apy: 99,
      kind: 'unsupported',
    });
    const scored = scorer.scoreAll([supported, unsupported], []);
    expect(scored).toHaveLength(1);
    expect(scored[0].address).toBe(supported.address);
  });

  /// ── IL-free venues ──────────────────────────────────────────────────────
  /// These guard the fix for the bug that made this whole pass necessary: the
  /// index contained only volatile LP pairs, all net-negative, so the app had
  /// nothing profitable to show. Staking and lending are the positive-yield
  /// venues, and they only stay positive if the pair-IL model is not applied
  /// to them.

  test('staking is not charged impermanent loss', () => {
    const staking = makePool({
      address: 'native_xrd_staking',
      name: 'XRD staking',
      apy: 6.2,
      yieldKind: 'staking',
      // Deliberately hand it the skeptical -12.5%/yr prior. A single-asset
      // position must ignore it rather than net out to -6.3%.
      risk: {
        volatility: 1 / Math.sqrt(365),
        correlation: 0,
        relAnnualVol: 1,
        estimatedIlPct: -12.5,
        source: 'default',
      },
    });
    const [scored] = scorer.scoreAll([staking], []);
    expect(scored.estimatedIl).toBe(0);
    expect(scored.ilRiskScore).toBe(0);
    expect(scored.netApyMa7d).toBeCloseTo(6.2, 5);
    expect(scored.yieldKind).toBe('staking');
  });

  test('lending is not charged impermanent loss', () => {
    const lending = makePool({
      address: 'component_rdx1cqs338cyje65rk44zgmjvvy42qcszrhk9ewznedtkqd8l3crtgnmh5',
      name: 'XRD lending',
      apy: 4,
      yieldKind: 'lending',
      risk: {
        volatility: 1 / Math.sqrt(365),
        correlation: 0,
        relAnnualVol: 1,
        estimatedIlPct: -12.5,
        source: 'default',
      },
    });
    const [scored] = scorer.scoreAll([lending], []);
    expect(scored.estimatedIl).toBe(0);
    expect(scored.netApyMa7d).toBeCloseTo(4, 5);
  });

  test('an IL-free venue outranks a higher-gross LP pool that loses to IL', () => {
    // The exact shape seen live on 2026-07-25: LP pools posted higher gross
    // APY than staking yet every one was net-negative. Ranking on gross put
    // the worst net performer first; ranking on net must invert that.
    const staking = makePool({
      address: 'native_xrd_staking',
      name: 'XRD staking',
      apy: 6.2,
      yieldKind: 'staking',
    });
    const lpPool = makePool({
      address: 'component_rdx1cqs338cyje65rk44zgmjvvy42qcszrhk9ewznedtkqd8l3crtgnmh5',
      name: 'DCKS-XRD',
      apy: 6.7, // higher GROSS than staking
      risk: {
        volatility: 0.05,
        correlation: 0.1,
        relAnnualVol: 0.8,
        estimatedIlPct: -27.4,
        source: 'live',
      },
    });
    const scored = scorer.scoreAll([staking, lpPool], []);
    const s = scored.find((p) => p.address === staking.address)!;
    const lp = scored.find((p) => p.address === lpPool.address)!;

    expect(lp.apyMa7d).toBeGreaterThan(s.apyMa7d); // gross favours the LP pool
    expect(s.netApyMa7d).toBeGreaterThan(lp.netApyMa7d); // net does not
    expect(lp.netApyMa7d).toBeLessThan(0);
    expect(s.riskAdjustedReturn).toBeGreaterThan(lp.riskAdjustedReturn);
  });

  test('yieldKind defaults to amm-lp so IL is applied unless waived', () => {
    // Fail-safe direction: an unlabelled pool must be charged IL, never
    // silently treated as IL-free.
    const [scored] = scorer.scoreAll([makePool({})], []);
    expect(scored.yieldKind).toBe('amm-lp');
    expect(scored.estimatedIl).toBeLessThan(0);
  });

  /// Was: "unaudited pool scores lower than audited at same APY".
  /// The `audited` flag no longer moves the score, deliberately. Every scanner
  /// hardcodes `audited: true`, so the old 10% audit component handed an
  /// identical bonus to every pool while implying a verification nobody had
  /// done — and the frontend rendered that same unbacked claim as a green
  /// "Audited" shield. Scoring on it dressed up a constant as a safety signal.
  /// Restore a real differentiator here only when per-protocol audit data is
  /// verified rather than assumed.
  test('the audited flag does not affect score (it is not a verified signal)', () => {
    const audited = makePool({
      address: 'component_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky',
      apy: 10,
      audited: true,
    });
    const unaudited = makePool({
      address: 'component_rdx1cqs338cyje65rk44zgmjvvy42qcszrhk9ewznedtkqd8l3crtgnmh5',
      apy: 10,
      audited: false,
    });
    const scored = scorer.scoreAll([audited, unaudited], []);
    const auditedScore = scored.find((s) => s.address === audited.address)!;
    const unauditedScore = scored.find((s) => s.address === unaudited.address)!;
    expect(auditedScore.score).toBe(unauditedScore.score);
  });

  test('live apySource scores higher than unknown at same APY', () => {
    const live = makePool({
      address: 'component_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky',
      apy: 10,
      apySource: 'live',
    });
    const unknown = makePool({
      address: 'component_rdx1cqs338cyje65rk44zgmjvvy42qcszrhk9ewznedtkqd8l3crtgnmh5',
      apy: 10,
      apySource: 'unknown',
    });
    const scored = scorer.scoreAll([live, unknown], []);
    const liveScore = scored.find((s) => s.address === live.address)!;
    const unknownScore = scored.find((s) => s.address === unknown.address)!;
    expect(liveScore.score).toBeGreaterThan(unknownScore.score);
  });

  test('7d APY MA computed from pool_snapshots when available', () => {
    const pool = makePool({
      address: 'component_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky',
      apy: 5,
    });
    // Insert snapshots with 1000 bps = 10% APY
    for (let i = 0; i < 5; i++) {
      testDb.exec(
        `INSERT INTO pool_snapshots (pool_address, protocol, tvl, apy_bps, scanned_at)
         VALUES ('component_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky', 'ociswap', '1000000', 1000, datetime('now', '-${i} hours'))`,
      );
    }
    const scored = scorer.scoreAll([pool], []);
    // Should use 10% (from snapshots) not 5% (from pool.apy)
    expect(scored[0].apyMa7d).toBe(10);
  });

  test('a realized-window APY is NOT re-averaged across the 7d snapshots', () => {
    // Weft and LSULP already measure yield over a trailing 30 days. Averaging
    // that again against 7 days of snapshots published a number matching
    // neither the label nor the venue: rows literally named "(realized,
    // trailing 30d)" served a 7-day mean OF those readings. Live 2026-08-02 Weft
    // showed 4.40% against a true trailing-30d 3.89%.
    const pool = makePool({ apy: 3.89, apyWindowDays: 30, yieldKind: 'lending' });
    for (let i = 0; i < 5; i++) {
      testDb.exec(
        `INSERT INTO pool_snapshots (pool_address, protocol, tvl, apy_bps, scanned_at)
         VALUES ('${pool.address}', 'weft', '1000000', 440, datetime('now', '-${i} hours'))`,
      );
    }
    const scored = scorer.scoreAll([pool], []);
    // The scanner's own realized figure survives, not the 4.40% snapshot mean.
    expect(scored[0].apyMa7d).toBeCloseTo(3.89, 6);
  });

  test('a spot APY still gets the 7d moving average', () => {
    // The exemption above must be narrow — only scanners that declare a window
    // opt out. Everything else still wants smoothing.
    const pool = makePool({ apy: 5 });
    for (let i = 0; i < 5; i++) {
      testDb.exec(
        `INSERT INTO pool_snapshots (pool_address, protocol, tvl, apy_bps, scanned_at)
         VALUES ('${pool.address}', 'ociswap', '1000000', 1000, datetime('now', '-${i} hours'))`,
      );
    }
    expect(scorer.scoreAll([pool], [])[0].apyMa7d).toBe(10);
  });

  test('drops LP pools whose TVL is zero or unreadable', () => {
    // A 0 TVL used to be EXEMPT from the dust floor, on the theory that it meant
    // "unreadable reserves" rather than "empty". It cannot tell those apart and
    // defaulted to include, so xETH-XRD — a verifiably empty DefiPlaza pool —
    // shipped to Discover with a precise-looking "-21.67% net APY" derived
    // entirely from other venues' price feeds, beside a hardcoded "0.00% fees".
    const empty = makePool({
      address: 'component_rdx1cpmacy5gwzswse56jprvlfhrpnt3mplswupu7qtq8pdz2hywy5uaqd',
      name: 'xETH-XRD',
      tvl: '0',
    });
    const real = makePool({ name: 'XRD-TOKEN', tvl: '1000000' });
    const scored = scorer.scoreAll([empty, real], []);
    expect(scored.map((s) => s.name)).toEqual(['XRD-TOKEN']);
  });

  test('IL-free venues are exempt by KIND, not by carrying a TVL number', () => {
    // Staking and lending hold no pool reserves. They must not be swept up by
    // the zero-TVL rule when a USD price is unavailable — scanStaking
    // deliberately reports $0 rather than inventing one.
    const staking = makePool({
      address: 'native_xrd_staking',
      name: 'XRD staking',
      tvl: '0',
      yieldKind: 'staking',
    });
    const scored = scorer.scoreAll([staking], []);
    expect(scored.map((s) => s.name)).toEqual(['XRD staking']);
  });
});
