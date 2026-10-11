import { describe, test, expect } from 'bun:test';
import {
  calculateApr,
  calculateApy,
  apyToApr,
  calculateImpermanentLoss,
  calculateIlFromPriceChange,
  calculateWeightedImpermanentLoss,
  expectedIlPctForKind,
  calculateIlRiskScore,
  calculateRiskAdjustedReturn,
  computePoolYieldSummary,
} from '../src/services/calculators';

// ─── APR Calculator ───────────────────────────────────────────────────────────

describe('calculateApr', () => {
  test('basic annual rate from 30-day period', () => {
    // $100 fees on $10,000 liquidity over 30 days
    const apr = calculateApr({ feesEarned: 100, liquidityProvided: 10_000, periodDays: 30 });
    // (100/10000) * (365/30) * 100 = 12.17%
    expect(apr).toBeCloseTo(12.17, 1);
  });

  test('1 day period', () => {
    const apr = calculateApr({ feesEarned: 10, liquidityProvided: 10_000, periodDays: 1 });
    // (10/10000) * 365 * 100 = 36.5%
    expect(apr).toBeCloseTo(36.5, 1);
  });

  test('365 day period (full year)', () => {
    const apr = calculateApr({ feesEarned: 500, liquidityProvided: 10_000, periodDays: 365 });
    expect(apr).toBeCloseTo(5.0, 2);
  });

  test('returns 0 for zero liquidity', () => {
    expect(calculateApr({ feesEarned: 100, liquidityProvided: 0, periodDays: 30 })).toBe(0);
  });

  test('returns 0 for negative liquidity', () => {
    expect(calculateApr({ feesEarned: 100, liquidityProvided: -1000, periodDays: 30 })).toBe(0);
  });

  test('returns 0 for zero period', () => {
    expect(calculateApr({ feesEarned: 100, liquidityProvided: 10_000, periodDays: 0 })).toBe(0);
  });

  test('returns 0 for negative fees', () => {
    expect(calculateApr({ feesEarned: -50, liquidityProvided: 10_000, periodDays: 30 })).toBe(0);
  });

  test('handles very small fees', () => {
    const apr = calculateApr({ feesEarned: 0.001, liquidityProvided: 10_000, periodDays: 30 });
    expect(apr).toBeGreaterThan(0);
    expect(apr).toBeLessThan(0.01);
  });
});

// ─── APY Calculator ───────────────────────────────────────────────────────────

describe('calculateApy', () => {
  test('daily compounding at 10% APR', () => {
    const apy = calculateApy({ aprPercent: 10, compoundingFrequency: 365 });
    // (1 + 0.10/365)^365 - 1 ≈ 10.52%
    expect(apy).toBeCloseTo(10.52, 1);
  });

  test('monthly compounding at 12% APR', () => {
    const apy = calculateApy({ aprPercent: 12, compoundingFrequency: 12 });
    // (1 + 0.12/12)^12 - 1 ≈ 12.68%
    expect(apy).toBeCloseTo(12.68, 1);
  });

  test('annual compounding equals APR', () => {
    const apy = calculateApy({ aprPercent: 10, compoundingFrequency: 1 });
    expect(apy).toBeCloseTo(10.0, 2);
  });

  test('continuous-like compounding (high frequency)', () => {
    const apy = calculateApy({ aprPercent: 100, compoundingFrequency: 365 * 24 });
    // Should approach e^1 - 1 ≈ 171.83%
    expect(apy).toBeCloseTo(171.83, 0);
  });

  test('returns 0 for zero APR', () => {
    expect(calculateApy({ aprPercent: 0, compoundingFrequency: 365 })).toBe(0);
  });

  test('returns 0 for negative APR', () => {
    expect(calculateApy({ aprPercent: -5, compoundingFrequency: 365 })).toBe(0);
  });

  test('returns 0 for zero compounding frequency', () => {
    expect(calculateApy({ aprPercent: 10, compoundingFrequency: 0 })).toBe(0);
  });
});

describe('apyToApr', () => {
  test('round-trips correctly with daily compounding', () => {
    const apr = 10;
    const apy = calculateApy({ aprPercent: apr, compoundingFrequency: 365 });
    const backToApr = apyToApr(apy, 365);
    expect(backToApr).toBeCloseTo(apr, 4);
  });

  test('round-trips with monthly compounding', () => {
    const apr = 24;
    const apy = calculateApy({ aprPercent: apr, compoundingFrequency: 12 });
    const backToApr = apyToApr(apy, 12);
    expect(backToApr).toBeCloseTo(apr, 4);
  });

  test('returns 0 for non-positive APY', () => {
    expect(apyToApr(0, 365)).toBe(0);
    expect(apyToApr(-5, 365)).toBe(0);
  });
});

// ─── Impermanent Loss Calculator ──────────────────────────────────────────────

describe('calculateImpermanentLoss', () => {
  test('no price change = no IL', () => {
    const il = calculateImpermanentLoss({ priceRatioA: 1, priceRatioB: 1 });
    expect(il).toBe(0);
  });

  test('token A doubles, token B stable', () => {
    // r = 2/1 = 2, IL = 2*sqrt(2)/(1+2) - 1 ≈ -5.72%
    const il = calculateImpermanentLoss({ priceRatioA: 2, priceRatioB: 1 });
    expect(il).toBeCloseTo(-5.72, 1);
  });

  test('token A halves, token B stable', () => {
    // r = 0.5/1 = 0.5, IL = 2*sqrt(0.5)/(1+0.5) - 1 ≈ -5.72%
    const il = calculateImpermanentLoss({ priceRatioA: 0.5, priceRatioB: 1 });
    expect(il).toBeCloseTo(-5.72, 1);
  });

  test('symmetric: doubling and halving give same IL', () => {
    const il1 = calculateImpermanentLoss({ priceRatioA: 2, priceRatioB: 1 });
    const il2 = calculateImpermanentLoss({ priceRatioA: 0.5, priceRatioB: 1 });
    expect(il1).toBeCloseTo(il2, 4);
  });

  test('5x price increase', () => {
    // r = 5, IL = 2*sqrt(5)/(1+5) - 1 ≈ -25.46%
    const il = calculateImpermanentLoss({ priceRatioA: 5, priceRatioB: 1 });
    expect(il).toBeCloseTo(-25.46, 0);
  });

  test('both tokens move proportionally = no IL', () => {
    // Both double: r = 2/2 = 1
    const il = calculateImpermanentLoss({ priceRatioA: 2, priceRatioB: 2 });
    expect(il).toBe(0);
  });

  test('returns 0 for invalid inputs (zero ratio)', () => {
    expect(calculateImpermanentLoss({ priceRatioA: 0, priceRatioB: 1 })).toBe(0);
    expect(calculateImpermanentLoss({ priceRatioA: 1, priceRatioB: 0 })).toBe(0);
  });

  test('returns 0 for negative ratios', () => {
    expect(calculateImpermanentLoss({ priceRatioA: -1, priceRatioB: 1 })).toBe(0);
  });

  test('extreme price movement (100x)', () => {
    const il = calculateImpermanentLoss({ priceRatioA: 100, priceRatioB: 1 });
    // Should be significant but not exceed -100%
    expect(il).toBeLessThan(-50);
    expect(il).toBeGreaterThan(-100);
  });
});

describe('calculateIlFromPriceChange', () => {
  test('50% price increase', () => {
    const il = calculateIlFromPriceChange(50);
    // priceRatioA = 1.5, r = 1.5, IL = 2*sqrt(1.5)/(1+1.5) - 1 ≈ -2.02%
    expect(il).toBeCloseTo(-2.02, 1);
  });

  test('50% price decrease', () => {
    const il = calculateIlFromPriceChange(-50);
    // priceRatioA = 0.5, r = 0.5
    expect(il).toBeCloseTo(-5.72, 1);
  });

  test('100% price increase (doubling)', () => {
    const il = calculateIlFromPriceChange(100);
    expect(il).toBeCloseTo(-5.72, 1);
  });

  test('0% change = no IL', () => {
    expect(calculateIlFromPriceChange(0)).toBe(0);
  });

  test('returns 0 for -100% (price goes to zero)', () => {
    expect(calculateIlFromPriceChange(-100)).toBe(0);
  });
});

// ─── IL Risk Score ────────────────────────────────────────────────────────────

describe('calculateIlRiskScore', () => {
  test('low volatility, high correlation, stablecoin = low risk', () => {
    const score = calculateIlRiskScore({
      volatility: 0.01,
      correlation: 0.9,
      hasStablecoin: true,
    });
    expect(score).toBeLessThanOrEqual(15);
  });

  test('high volatility, low correlation, no stablecoin = high risk', () => {
    const score = calculateIlRiskScore({
      volatility: 0.1,
      correlation: -0.5,
      hasStablecoin: false,
    });
    expect(score).toBeGreaterThanOrEqual(50);
  });

  test('score is bounded 0-100', () => {
    const low = calculateIlRiskScore({ volatility: 0, correlation: 1, hasStablecoin: true });
    const high = calculateIlRiskScore({ volatility: 1, correlation: -1, hasStablecoin: false });
    expect(low).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(100);
  });

  test('stablecoin discount reduces risk', () => {
    const withStable = calculateIlRiskScore({
      volatility: 0.05,
      correlation: 0.5,
      hasStablecoin: true,
    });
    const withoutStable = calculateIlRiskScore({
      volatility: 0.05,
      correlation: 0.5,
      hasStablecoin: false,
    });
    expect(withStable).toBeLessThan(withoutStable);
  });
});

// ─── Risk-Adjusted Return ─────────────────────────────────────────────────────

describe('calculateRiskAdjustedReturn', () => {
  test('positive when APY exceeds risk-free rate + IL', () => {
    const result = calculateRiskAdjustedReturn({
      apyPercent: 20,
      ilPercent: -3,
      ilRiskScore: 30,
      volatility: 0.05,
    });
    // netReturn = 17, excess = 9, should be positive
    expect(result).toBeGreaterThan(0);
  });

  test('negative when APY below risk-free after IL', () => {
    const result = calculateRiskAdjustedReturn({
      apyPercent: 5,
      ilPercent: -10,
      ilRiskScore: 60,
      volatility: 0.08,
    });
    // netReturn = -5, excess = -13, should be negative
    expect(result).toBeLessThan(0);
  });

  test('higher volatility reduces risk-adjusted return', () => {
    const lowVol = calculateRiskAdjustedReturn({
      apyPercent: 15,
      ilPercent: -2,
      ilRiskScore: 30,
      volatility: 0.02,
    });
    const highVol = calculateRiskAdjustedReturn({
      apyPercent: 15,
      ilPercent: -2,
      ilRiskScore: 30,
      volatility: 0.1,
    });
    expect(lowVol).toBeGreaterThan(highVol);
  });

  test('custom risk-free rate', () => {
    const result = calculateRiskAdjustedReturn({
      apyPercent: 15,
      ilPercent: -2,
      ilRiskScore: 30,
      volatility: 0.05,
      riskFreeRate: 0,
    });
    // With 0 risk-free: excess = 13 vs default 5
    expect(result).toBeGreaterThan(0);
  });
});

// ─── Pool Yield Summary ──────────────────────────────────────────────────────

describe('computePoolYieldSummary', () => {
  test('computes complete summary', () => {
    const summary = computePoolYieldSummary({
      aprPercent: 15,
      compoundingFrequency: 365,
      priceChangeA: 50,
      priceChangeB: 0,
      volatility: 0.05,
      correlation: 0.5,
      hasStablecoin: false,
    });

    expect(summary.grossApy).toBeGreaterThan(15); // APY > APR due to compounding
    expect(summary.estimatedIl).toBeLessThan(0); // IL is always negative
    expect(summary.netApy).toBe(summary.grossApy + summary.estimatedIl);
    expect(summary.ilRiskScore).toBeGreaterThanOrEqual(0);
    expect(summary.ilRiskScore).toBeLessThanOrEqual(100);
    expect(['low', 'medium', 'high']).toContain(summary.riskTier);
  });

  test('stablecoin pair has low risk tier', () => {
    const summary = computePoolYieldSummary({
      aprPercent: 5,
      compoundingFrequency: 365,
      priceChangeA: 0,
      priceChangeB: 0,
      volatility: 0.01,
      correlation: 0.95,
      hasStablecoin: true,
    });

    expect(summary.riskTier).toBe('low');
    expect(summary.estimatedIl).toBe(0); // No price change = no IL
  });
});

// ─── MONETIZATION #4: blueprint-dispatched IL ────────────────────────────────

describe('calculateWeightedImpermanentLoss', () => {
  test('w = 0.5 reproduces the classic 50/50 curve', () => {
    for (const r of [0.5, 1.2, 2, 4]) {
      expect(
        calculateWeightedImpermanentLoss({ priceRatioA: r, priceRatioB: 1, weightA: 0.5 }),
      ).toBeCloseTo(calculateImpermanentLoss({ priceRatioA: r, priceRatioB: 1 }), 10);
    }
  });

  test('asymmetric pools bleed less: w=0.8 at r=2 ≈ −3.3% vs 50/50 −5.7%', () => {
    const heavy = calculateWeightedImpermanentLoss({ priceRatioA: 2, priceRatioB: 1, weightA: 0.8 });
    const even = calculateImpermanentLoss({ priceRatioA: 2, priceRatioB: 1 });
    expect(heavy).toBeCloseTo(-3.28, 1);
    expect(even).toBeCloseTo(-5.72, 1);
    expect(heavy).toBeGreaterThan(even);
  });

  test('no relative move or invalid weight → 0', () => {
    expect(calculateWeightedImpermanentLoss({ priceRatioA: 3, priceRatioB: 3, weightA: 0.7 })).toBe(0);
    expect(calculateWeightedImpermanentLoss({ priceRatioA: 2, priceRatioB: 1, weightA: 1 })).toBe(0);
    expect(calculateWeightedImpermanentLoss({ priceRatioA: 2, priceRatioB: 1, weightA: 0 })).toBe(0);
  });
});

describe('expectedIlPctForKind', () => {
  test('w=0.5 gives the −σ²/8 expansion; capped at −95', () => {
    expect(expectedIlPctForKind('ociswap_basic', 1).ilPct).toBeCloseTo(-12.5, 10);
    expect(expectedIlPctForKind('caviarnine_weighted', 4).ilPct).toBe(-95);
  });

  test('asymmetric weights shrink expected IL', () => {
    const even = expectedIlPctForKind('caviarnine_weighted', 1, 0.5).ilPct;
    const skewed = expectedIlPctForKind('caviarnine_weighted', 1, 0.8).ilPct;
    expect(skewed).toBeGreaterThan(even); // −8% vs −12.5%
    expect(skewed).toBeCloseTo(-8, 5);
  });

  test('DefiPlaza is flagged pending calibration; others are calibrated', () => {
    expect(expectedIlPctForKind('defiplaza_pair', 1).calibrated).toBe(false);
    expect(expectedIlPctForKind('ociswap_precision', 1).calibrated).toBe(true);
    expect(expectedIlPctForKind(undefined, 1).calibrated).toBe(true);
  });
});
