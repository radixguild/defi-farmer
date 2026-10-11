/// Allocator tests — Kelly criterion, allocation engine, rotation generator, portfolio summary.
/// Pure functions, no DB or network dependencies.

import { describe, test, expect } from 'bun:test';
import {
  kellyFraction,
  rarToConfidence,
  computeAllocation,
  generateRotations,
  rebalanceNetBenefit,
  summarizePortfolio,
} from '../src/services/allocator.js';
import type { ScoredPool } from '../src/services/scorer.js';
import type { Position } from '../src/db/schema.js';

// ─── Kelly Criterion ─────────────────────────────────────────────────────────

describe('kellyFraction', () => {
  test('returns 0 for negative edge (expectedApy <= riskFree)', () => {
    expect(kellyFraction(0.8, 5, 8)).toBe(0);
    expect(kellyFraction(0.8, 8, 8)).toBe(0);
  });

  test('returns 0 for zero confidence', () => {
    expect(kellyFraction(0, 20, 8)).toBe(0);
  });

  test('returns positive fraction for positive edge', () => {
    // b = (20 - 8) / 8 = 1.5, f = (0.8 * 1.5 - 0.2) / 1.5 = (1.2 - 0.2) / 1.5 = 0.667
    const f = kellyFraction(0.8, 20, 8);
    expect(f).toBeGreaterThan(0.5);
    expect(f).toBeLessThan(0.8);
  });

  test('clamps to [0, 1]', () => {
    // Extreme edge: b huge, confidence 0.99
    const fHigh = kellyFraction(0.99, 200, 1);
    expect(fHigh).toBeLessThanOrEqual(1);

    const fLow = kellyFraction(-0.1, 20, 8);
    expect(fLow).toBe(0);
  });

  test('higher confidence = higher fraction (same APY)', () => {
    const low = kellyFraction(0.5, 20, 8);
    const high = kellyFraction(0.9, 20, 8);
    expect(high).toBeGreaterThan(low);
  });

  test('higher APY = higher fraction (same confidence)', () => {
    const low = kellyFraction(0.8, 12, 8);
    const high = kellyFraction(0.8, 30, 8);
    expect(high).toBeGreaterThan(low);
  });
});

// ─── Helpers for allocator tests ─────────────────────────────────────────────

function makeScoredPool(overrides: Partial<ScoredPool> = {}): ScoredPool {
  return {
    address: 'component_rdx1test',
    name: 'Test Pool',
    tokenA: 'XRD',
    tokenB: 'USDC',
    tvl: '1000000',
    apy: 15,
    protocol: 'ociswap',
    audited: true,
    apySource: 'live',
    yieldKind: 'amm-lp',
    score: 85,
    apyMa7d: 15,
    netApyMa7d: 15,
    estimatedIl: 0,
    ilRiskScore: 10,
    riskAdjustedReturn: 2,
    tvlVariance: 0.1,
    classification: 'stable',
    ...overrides,
  };
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 1,
    protocol: 'ociswap',
    pool_address: 'component_rdx1existing',
    receipt_id: 'receipt_1',
    token_a: 'XRD',
    token_b: 'USDC',
    deposited_amount: '1000',
    current_value: '1100',
    apy_bps: 1200,
    risk_level: 'low',
    deposited_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    status: 'active',
    classification: 'rotational',
    entry_apy_bps: 1500,
    cooldown_until: null,
    last_review_at: null,
    receipt_resource: 'resource_rdx1test',
    // NULL owner = a bot-owned row (Phase 3.1 D4). Added when tests/ came
    // under the typechecker (F2) and this mock was found stale.
    user_address: null,
    intent_hash: null,
    closed_at: null,
    close_intent_hash: null,
    ...overrides,
  };
}

// ─── computeAllocation ───────────────────────────────────────────────────────

describe('computeAllocation', () => {
  test('returns empty array for no positions', () => {
    const scored = [makeScoredPool({ apyMa7d: 20, score: 90 })];
    const result = computeAllocation(scored, []);
    expect(result).toEqual([]);
  });

  test('returns empty array for no scored pools', () => {
    const positions = [makePosition()];
    const result = computeAllocation([], positions);
    expect(result).toEqual([]);
  });

  test('allocates on NET APY with positive Kelly edge', () => {
    const scored = [
      makeScoredPool({ address: 'pool_a', apyMa7d: 25, netApyMa7d: 25, riskAdjustedReturn: 3, score: 90, protocol: 'ociswap' }),
      makeScoredPool({ address: 'pool_b', apyMa7d: 12, netApyMa7d: 12, riskAdjustedReturn: 1, score: 50, protocol: 'caviarnine' }),
      makeScoredPool({ address: 'pool_c', apyMa7d: 7, netApyMa7d: 7, riskAdjustedReturn: 0.5, score: 30, protocol: 'defiplaza' }),
    ];
    const positions = [makePosition({ current_value: '10000' })];
    const result = computeAllocation(scored, positions);

    expect(result.length).toBeGreaterThan(0);
    // Best pool should be first
    expect(result[0].poolAddress).toBe('pool_a');
    // Pool with NET APY < risk-free (8%) should get zero
    const poolC = result.find(r => r.poolAddress === 'pool_c');
    expect(poolC).toBeUndefined();
  });

  test('a gross-rich pool bleeding IL below risk-free gets no allocation', () => {
    // 40% gross, −35% IL → net 5% < risk-free 8%: the old gross ranker funded this
    const scored = [
      makeScoredPool({ address: 'trap', apyMa7d: 40, netApyMa7d: 5, estimatedIl: -35, riskAdjustedReturn: -0.5 }),
    ];
    const result = computeAllocation(scored, [makePosition({ current_value: '10000' })]);
    expect(result).toEqual([]);
  });

  test('respects maxPoolFraction cap', () => {
    // Single pool with great NET APY — should be capped at 40%
    const scored = [makeScoredPool({ address: 'pool_a', apyMa7d: 30, netApyMa7d: 30, riskAdjustedReturn: 3, score: 95 })];
    const positions = [makePosition({ current_value: '10000' })];
    const result = computeAllocation(scored, positions);

    expect(result.length).toBe(1);
    expect(result[0].allocationXrd).toBeLessThanOrEqual(4000); // 40% of 10000
  });

  test('respects maxProtocolFraction cap', () => {
    // Two pools on same protocol — combined should be capped at 60%
    const scored = [
      makeScoredPool({ address: 'pool_a', apyMa7d: 25, netApyMa7d: 25, riskAdjustedReturn: 3, score: 90, protocol: 'ociswap' }),
      makeScoredPool({ address: 'pool_b', apyMa7d: 24, netApyMa7d: 24, riskAdjustedReturn: 2.8, score: 88, protocol: 'ociswap' }),
    ];
    const positions = [makePosition({ current_value: '10000' })];
    const result = computeAllocation(scored, positions);

    const totalOciswap = result
      .filter(r => r.protocol === 'ociswap')
      .reduce((sum, r) => sum + r.allocationXrd, 0);
    expect(totalOciswap).toBeLessThanOrEqual(6000); // 60% of 10000
  });

  test('sorts by confidence × expectedApy', () => {
    const scored = [
      makeScoredPool({ address: 'low', apyMa7d: 14, netApyMa7d: 14, riskAdjustedReturn: 0.8, score: 60, protocol: 'defiplaza' }),
      makeScoredPool({ address: 'high', apyMa7d: 30, netApyMa7d: 30, riskAdjustedReturn: 3, score: 95, protocol: 'ociswap' }),
      makeScoredPool({ address: 'mid', apyMa7d: 20, netApyMa7d: 20, riskAdjustedReturn: 1.5, score: 70, protocol: 'caviarnine' }),
    ];
    const positions = [makePosition({ current_value: '10000' })];
    const result = computeAllocation(scored, positions);

    expect(result[0].poolAddress).toBe('high');
    expect(result[1].poolAddress).toBe('mid');
    expect(result[2].poolAddress).toBe('low');
  });
});

// ─── rarToConfidence ─────────────────────────────────────────────────────────

describe('rarToConfidence', () => {
  test('RAR 0 (net return = risk-free) is a coin flip', () => {
    expect(rarToConfidence(0)).toBeCloseTo(0.5, 5);
  });

  test('monotonic and bounded to (0, 1)', () => {
    expect(rarToConfidence(-4)).toBeLessThan(rarToConfidence(0));
    expect(rarToConfidence(0)).toBeLessThan(rarToConfidence(4));
    expect(rarToConfidence(-100)).toBeGreaterThan(0);
    expect(rarToConfidence(100)).toBeLessThanOrEqual(1);
  });
});

// ─── generateRotations ───────────────────────────────────────────────────────

describe('generateRotations', () => {
  test('returns empty when no positions', () => {
    const targets = [{ poolAddress: 'pool_a', protocol: 'ociswap', expectedApy: 20, confidence: 0.8, kellyFraction: 0.4, allocationXrd: 4000 }];
    const instructions = generateRotations([], targets);
    expect(instructions).toEqual([]);
  });

  test('returns empty when no targets', () => {
    const positions = [makePosition()];
    const instructions = generateRotations(positions, []);
    expect(instructions).toEqual([]);
  });

  test('generates rotation from worst pool to best target', () => {
    const positions = [
      makePosition({ pool_address: 'pool_low', apy_bps: 800, current_value: '5000' }),
    ];
    const targets = [
      { poolAddress: 'pool_high', protocol: 'ociswap', expectedApy: 20, confidence: 0.9, kellyFraction: 0.5, allocationXrd: 5000 },
    ];
    const instructions = generateRotations(positions, targets, { minRotationGainBps: 200 });

    expect(instructions.length).toBe(1);
    expect(instructions[0].fromPool).toBe('pool_low');
    expect(instructions[0].toPool).toBe('pool_high');
    expect(instructions[0].expectedGainBps).toBe(1200); // 2000 - 800
  });

  test('skips rotations below minRotationGainBps', () => {
    const positions = [
      makePosition({ pool_address: 'pool_ok', apy_bps: 1800, current_value: '5000' }),
    ];
    const targets = [
      { poolAddress: 'pool_better', protocol: 'ociswap', expectedApy: 19, confidence: 0.9, kellyFraction: 0.5, allocationXrd: 5000 },
    ];
    // Gain is 100 bps (1900 - 1800), below default 200 bps threshold
    const instructions = generateRotations(positions, targets, { minRotationGainBps: 200 });
    expect(instructions).toEqual([]);
  });

  test('skips rotations below minRotationAmount', () => {
    const positions = [
      makePosition({ pool_address: 'pool_low', apy_bps: 500, current_value: '5' }),
    ];
    const targets = [
      { poolAddress: 'pool_high', protocol: 'ociswap', expectedApy: 30, confidence: 0.9, kellyFraction: 0.5, allocationXrd: 5000 },
    ];
    const instructions = generateRotations(positions, targets, { minRotationAmount: 10 });
    expect(instructions).toEqual([]);
  });

  test('prioritizes high priority rotations first', () => {
    const positions = [
      makePosition({ pool_address: 'pool_a', apy_bps: 500, current_value: '3000', protocol: 'ociswap' }),
      makePosition({ pool_address: 'pool_b', apy_bps: 1000, current_value: '3000', protocol: 'caviarnine' }),
    ];
    const targets = [
      { poolAddress: 'pool_great', protocol: 'defiplaza', expectedApy: 35, confidence: 0.9, kellyFraction: 0.5, allocationXrd: 6000 },
    ];
    const instructions = generateRotations(positions, targets, { minRotationGainBps: 100 });

    // pool_a (500 bps → 3500 = gain 3000 bps = high priority) vs pool_b (1000 → 3500 = gain 2500 bps = high priority)
    // Both should be high priority due to large gains
    expect(instructions.length).toBe(2);
    expect(instructions[0].priority).toBe('high');
    expect(instructions[1].priority).toBe('high');
    // Highest gain first
    expect(instructions[0].expectedGainBps).toBeGreaterThanOrEqual(instructions[1].expectedGainBps);
  });
});

// ─── summarizePortfolio ──────────────────────────────────────────────────────

describe('summarizePortfolio', () => {
  test('returns empty portfolio for no active positions', () => {
    const summary = summarizePortfolio([]);
    expect(summary.totalValueXrd).toBe(0);
    expect(summary.poolCount).toBe(0);
    expect(summary.diversificationScore).toBe(100);
  });

  test('diversified across three equal positions', () => {
    // 33% each = under the 40% pool cap
    const positions = [
      makePosition({ pool_address: 'pool_a', protocol: 'ociswap', current_value: '3333' }),
      makePosition({ pool_address: 'pool_b', protocol: 'caviarnine', current_value: '3333' }),
      makePosition({ pool_address: 'pool_c', protocol: 'defiplaza', current_value: '3334' }),
    ];
    const summary = summarizePortfolio(positions);
    expect(summary.poolCount).toBe(3);
    expect(summary.protocolCount).toBe(3);
    expect(summary.totalValueXrd).toBe(10000);
    expect(summary.overConcentratedPools).toBe(0);
    expect(summary.overConcentratedProtocols).toBe(0);
    // HHI = 3 × (0.333²) × 10000 ≈ 3333, diversification ≈ 67
    expect(summary.diversificationScore).toBeGreaterThan(60);
  });

  test('concentrated portfolio: single pool', () => {
    const positions = [
      makePosition({ pool_address: 'pool_a', current_value: '10000' }),
    ];
    const summary = summarizePortfolio(positions);
    expect(summary.diversificationScore).toBe(0);
    // 100% in one pool exceeds 40% cap
    expect(summary.overConcentratedPools).toBe(1);
  });

  test('detects over-concentrated protocols', () => {
    const positions = [
      makePosition({ pool_address: 'pool_a', protocol: 'ociswap', current_value: '4000' }),
      makePosition({ pool_address: 'pool_b', protocol: 'ociswap', current_value: '4000' }),
      makePosition({ pool_address: 'pool_c', protocol: 'caviarnine', current_value: '2000' }),
    ];
    const summary = summarizePortfolio(positions);
    // ociswap has 8000/10000 = 80% > 60% cap
    expect(summary.overConcentratedProtocols).toBe(1);
    expect(summary.maxProtocolConcentration.protocol).toBe('ociswap');
  });

  test('computes average APY correctly', () => {
    const positions = [
      makePosition({ pool_address: 'pool_a', apy_bps: 1500 }),
      makePosition({ pool_address: 'pool_b', apy_bps: 500 }),
    ];
    const summary = summarizePortfolio(positions);
    expect(summary.avgApy).toBe(10); // (1500 + 500) / 2 / 100 = 10%
  });

  test('ignores inactive positions', () => {
    const positions = [
      makePosition({ status: 'active', current_value: '10000' }),
      makePosition({ status: 'closed', current_value: '50000' }), // should be ignored
    ];
    const summary = summarizePortfolio(positions);
    expect(summary.totalValueXrd).toBe(10000);
    expect(summary.poolCount).toBe(1);
  });
});

// ─── rebalanceNetBenefit (MONETIZATION #5) ───────────────────────────────────

describe('rebalanceNetBenefit', () => {
  test('refuses a dust rotation whose gain cannot cover gas', () => {
    // +200bps on 300 XRD over 30d ≈ 0.49 XRD gain vs 20 XRD gas + 1.5 fees
    const d = rebalanceNetBenefit({ gainBps: 200, amountXrd: 300 });
    expect(d.act).toBe(false);
    expect(d.gain).toBeCloseTo(0.49, 1);
    expect(d.cost).toBeGreaterThan(20);
  });

  test('acts when the move out-earns its costs', () => {
    // +1500bps on 30k XRD over 30d ≈ 370 XRD vs ~170 XRD costs
    const d = rebalanceNetBenefit({ gainBps: 1500, amountXrd: 30000 });
    expect(d.act).toBe(true);
    expect(d.benefit).toBeCloseTo(d.gain - d.cost, 6);
  });

  test('longer horizon amortizes fixed costs', () => {
    const short = rebalanceNetBenefit({ gainBps: 400, amountXrd: 5000, horizonDays: 15 });
    const long = rebalanceNetBenefit({ gainBps: 400, amountXrd: 5000, horizonDays: 180 });
    expect(short.act).toBe(false);
    expect(long.act).toBe(true);
  });

  test('realized IL is a cost: exiting a bleeding position must clear it too', () => {
    const clean = rebalanceNetBenefit({ gainBps: 1500, amountXrd: 30000 });
    const bleeding = rebalanceNetBenefit({
      gainBps: 1500,
      amountXrd: 30000,
      costs: { realizedIlPct: -2 },
    });
    expect(bleeding.cost).toBeCloseTo(clean.cost + 600, 0); // 2% of 30k
    expect(bleeding.act).toBe(false);
  });

  test('negative gain never acts', () => {
    expect(rebalanceNetBenefit({ gainBps: -500, amountXrd: 100000 }).act).toBe(false);
  });
});
