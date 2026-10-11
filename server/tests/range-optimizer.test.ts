import { describe, test, expect } from 'bun:test';
import {
  concentratedValue,
  concentratedIl,
  concentrationFactor,
  probInRange,
  expectedTimeInRange,
  expectedConcentratedIl,
  expectedExitsPerYear,
  optimizeRange,
} from '../src/services/range-optimizer';
import { calculateImpermanentLoss } from '../src/services/calculators';

describe('concentratedValue / concentratedIl', () => {
  test('V(1) = 1 and IL(1) = 0 for any range', () => {
    for (const m of [1.1, 1.5, 3]) {
      expect(concentratedValue(1, 1 / m, m)).toBeCloseTo(1, 10);
      expect(concentratedIl(1, 1 / m, m)).toBeCloseTo(0, 10);
    }
  });

  test('boundary freeze: below-range value tracks p linearly, above-range is flat', () => {
    const rLo = 0.8;
    const rHi = 1.25;
    const vLo = concentratedValue(rLo, rLo, rHi);
    expect(concentratedValue(rLo / 2, rLo, rHi)).toBeCloseTo(vLo / 2, 10);
    const vHi = concentratedValue(rHi, rLo, rHi);
    expect(concentratedValue(rHi * 10, rLo, rHi)).toBeCloseTo(vHi, 10);
  });

  test('IL is ≤ 0 and worsens with a tighter range at the same price move', () => {
    const p = 1.2;
    const tight = concentratedIl(p, 1 / 1.1, 1.1);
    const wide = concentratedIl(p, 1 / 3, 3);
    const fullRange = calculateImpermanentLoss({ priceRatioA: p, priceRatioB: 1 }) / 100;
    expect(tight).toBeLessThan(wide);
    expect(wide).toBeLessThan(0);
    // a concentrated position amplifies IL vs the full-range curve
    expect(wide).toBeLessThanOrEqual(fullRange + 1e-9);
  });

  test('rejects ranges that do not straddle the entry price', () => {
    expect(() => concentratedValue(1, 1.1, 2)).toThrow();
    expect(() => concentratedValue(1, 0.5, 0.9)).toThrow();
  });
});

describe('concentrationFactor', () => {
  test('→1 for a near-full range, large for tight ranges, monotonic', () => {
    expect(concentrationFactor(1e-9, 1e9)).toBeCloseTo(1, 3);
    const tight = concentrationFactor(1 / 1.05, 1.05);
    const mid = concentrationFactor(1 / 1.5, 1.5);
    expect(tight).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(1);
    expect(tight).toBeGreaterThan(20); // ±5% range ≈ 41× capital efficiency
  });
});

describe('probInRange / expectedTimeInRange', () => {
  test('calm pair stays in range; violent pair leaves', () => {
    expect(probInRange(1 / 1.2, 1.2, 0.05, 30 / 365)).toBeGreaterThan(0.99);
    expect(probInRange(1 / 1.05, 1.05, 2.0, 30 / 365)).toBeLessThan(0.2);
  });

  test('expectedTimeInRange ∈ (0,1], wider range → more time in range', () => {
    const sigma = 0.8;
    const t = 30 / 365;
    const tight = expectedTimeInRange(1 / 1.05, 1.05, sigma, t);
    const wide = expectedTimeInRange(1 / 2, 2, sigma, t);
    expect(tight).toBeGreaterThan(0);
    expect(wide).toBeLessThanOrEqual(1);
    expect(wide).toBeGreaterThan(tight);
  });

  test('zero vol or zero horizon → always in range', () => {
    expect(probInRange(0.9, 1.1, 0, 1)).toBe(1);
    expect(expectedTimeInRange(0.9, 1.1, 0.5, 0)).toBe(1);
  });
});

describe('expectedConcentratedIl', () => {
  test('≈0 at negligible vol; more negative with tighter range and higher vol', () => {
    expect(expectedConcentratedIl(1 / 1.5, 1.5, 0.001, 30 / 365)).toBeCloseTo(0, 4);
    const t = 30 / 365;
    const calm = expectedConcentratedIl(1 / 1.5, 1.5, 0.3, t);
    const wild = expectedConcentratedIl(1 / 1.5, 1.5, 1.5, t);
    const wildTight = expectedConcentratedIl(1 / 1.1, 1.1, 1.5, t);
    expect(calm).toBeLessThan(0);
    expect(wild).toBeLessThan(calm);
    expect(wildTight).toBeLessThan(wild);
  });
});

describe('optimizeRange (acceptance: defensible width per vol)', () => {
  const baseFeeApr = 12;

  test('stable pair → tight range; volatile pair → wide range; monotonic in vol', () => {
    const stable = optimizeRange({ baseFeeApr, relAnnualVol: 0.05 });
    const mid = optimizeRange({ baseFeeApr, relAnnualVol: 0.6 });
    const wild = optimizeRange({ baseFeeApr, relAnnualVol: 1.5 });
    expect(stable.multiple).toBeLessThanOrEqual(mid.multiple);
    expect(mid.multiple).toBeLessThanOrEqual(wild.multiple);
    // stables concentrate hard — the tightest candidate wins
    expect(stable.multiple).toBe(1.05);
    expect(stable.timeInRange).toBeGreaterThan(0.9);
  });

  test('no fees to earn → the widest candidate (pure IL minimization)', () => {
    const r = optimizeRange({ baseFeeApr: 0, relAnnualVol: 0.8 });
    expect(r.multiple).toBe(4);
    expect(r.feeApr).toBe(0);
  });

  test('objective arithmetic is consistent and the winner beats other candidates', () => {
    const params = { baseFeeApr, relAnnualVol: 0.8, candidates: [1.1, 1.5, 2, 3] };
    const best = optimizeRange(params);
    expect(best.netApr).toBeCloseTo(best.feeApr + best.ilApr + best.rerangeApr, 1);
    for (const m of params.candidates) {
      const solo = optimizeRange({ ...params, candidates: [m] });
      expect(best.netApr).toBeGreaterThanOrEqual(solo.netApr);
    }
  });

  test('churn pricing: a volatile pair must not win with a hyper-tight range', () => {
    // σ=67% on ±5%: ~188 exits/yr — the fee×41 concentration mirage dies here
    expect(expectedExitsPerYear(1.05, 0.67)).toBeGreaterThan(100);
    expect(expectedExitsPerYear(1.5, 0.67)).toBeLessThan(3);
    expect(expectedExitsPerYear(1.05, 0)).toBe(0);
    expect(expectedExitsPerYear(1.01, 5)).toBe(365); // capped

    const r = optimizeRange({ baseFeeApr: 10, relAnnualVol: 0.67 });
    expect(r.multiple).toBeGreaterThan(1.05); // the 41×-concentration mirage loses
    expect(r.exitsPerYear).toBeLessThan(30); // ≲ 2 re-ranges/month is operable
  });

  test('rejects nonsense widths', () => {
    expect(() => optimizeRange({ baseFeeApr, relAnnualVol: 0.5, candidates: [0.9] })).toThrow();
  });
});
