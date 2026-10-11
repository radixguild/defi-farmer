import { describe, test, expect, beforeEach } from 'bun:test';
import {
  dailyLogReturns,
  stdev,
  correlation,
  alignedReturns,
  annualizeVol,
  relativeAnnualVol,
  expectedAnnualIlPct,
  pairRiskFromSeries,
  fetchDailyCloses,
  _clearPriceCache,
  type DailySeries,
  type FetchLike,
} from '../src/services/price-feed';

const DAY = 86_400;

function series(closes: number[], t0 = 1_784_000_000): DailySeries {
  return { t: closes.map((_, i) => t0 + i * DAY), c: closes };
}

beforeEach(() => {
  _clearPriceCache();
});

describe('pure math', () => {
  test('dailyLogReturns: ln ratios, skipping non-positive closes', () => {
    const r = dailyLogReturns([100, 110, 0, 121]);
    // 0 breaks both adjacent pairs — only 100→110 remains
    expect(r).toHaveLength(1);
    expect(r[0]).toBeCloseTo(Math.log(1.1), 10);
  });

  test('stdev: 0 for flat/short, sample stdev otherwise', () => {
    expect(stdev([])).toBe(0);
    expect(stdev([5])).toBe(0);
    expect(stdev([1, 1, 1])).toBe(0);
    expect(stdev([0, 2])).toBeCloseTo(Math.SQRT2, 10);
  });

  test('correlation: +1 identical, −1 opposite, 0 degenerate', () => {
    const a = [0.01, -0.02, 0.03, -0.01];
    expect(correlation(a, a)).toBeCloseTo(1, 10);
    expect(correlation(a, a.map((x) => -x))).toBeCloseTo(-1, 10);
    expect(correlation(a, [0, 0, 0, 0])).toBe(0);
    expect(correlation([1], [1])).toBe(0);
  });

  test('alignedReturns joins on timestamps', () => {
    const sa = series([1, 2, 4, 8]); // t0..t3
    const sb: DailySeries = { t: [sa.t[0], sa.t[1], sa.t[3]], c: [10, 20, 80] }; // missing t2
    const { ra, rb } = alignedReturns(sa, sb);
    // intersection = t0,t1,t3 → closes a:[1,2,8] b:[10,20,80] → two returns each
    expect(ra).toHaveLength(2);
    expect(rb).toHaveLength(2);
    expect(ra[0]).toBeCloseTo(Math.log(2), 10);
    expect(rb[1]).toBeCloseTo(Math.log(4), 10);
  });

  // Regression: a non-positive/gap close in ONE series must not desync ra/rb.
  // (fetchDailyCloses turns an API-gap null into 0 via Number(null); differencing
  // each series independently would drop a different count per side, and
  // correlation()'s slice(-n) would then pair mismatched calendar days.)
  test('a one-sided zero close keeps ra/rb equal length and correctly paired', () => {
    // Identical, VARYING returns on surviving days; series A has one interior 0.
    const b = series([100, 110, 104, 120, 130, 118]);
    const a = series([100, 110, 0, 120, 130, 118]); // gap at index 2, same t
    const { ra, rb } = alignedReturns(a, b);
    // day-pairs touching the zero (1→2 and 2→3) drop from BOTH sides
    expect(ra.length).toBe(rb.length);
    expect(ra.length).toBe(3); // pairs 0→1, 3→4, 4→5
    // surviving returns are identical between the series → correlation is exactly 1;
    // independent differencing would misalign them and give < 1.
    expect(correlation(ra, rb)).toBeCloseTo(1, 10);
  });

  test('pairRiskFromSeries stays finite and sane through a one-sided gap', () => {
    const b: number[] = [100];
    for (let i = 0; i < 20; i++) b.push(b[b.length - 1] * (i % 3 === 0 ? 1.05 : 0.97));
    const a = [...b];
    a[7] = 0; // an interior API gap on token A only
    const risk = pairRiskFromSeries(series(a), series(b))!;
    expect(risk).not.toBeNull();
    expect(Number.isFinite(risk.correlation)).toBe(true);
    expect(risk.correlation).toBeGreaterThan(0.9); // same underlying series → high corr
    expect(Number.isFinite(risk.relAnnualVol)).toBe(true);
    expect(risk.estimatedIlPct).toBeLessThanOrEqual(0);
  });

  test('relativeAnnualVol: 0 for perfectly correlated equal vols; quadrature at corr 0', () => {
    expect(relativeAnnualVol(0.8, 0.8, 1)).toBeCloseTo(0, 10);
    expect(relativeAnnualVol(0.6, 0.8, 0)).toBeCloseTo(1.0, 10);
  });

  test('expectedAnnualIlPct: −σ²/8, capped at −95', () => {
    expect(expectedAnnualIlPct(1)).toBeCloseTo(-12.5, 10);
    expect(expectedAnnualIlPct(1.41)).toBeCloseTo(-24.85, 1);
    expect(expectedAnnualIlPct(4)).toBe(-95); // −200 uncapped
  });

  test('annualizeVol scales by √365', () => {
    expect(annualizeVol(0.05)).toBeCloseTo(0.05 * Math.sqrt(365), 10);
  });
});

describe('pairRiskFromSeries', () => {
  test('null when the aligned overlap is too short', () => {
    expect(pairRiskFromSeries(series([1, 2, 3]), series([1, 2, 3]))).toBeNull();
  });

  test('a volatile token vs a stable one produces the volatile relVol and negative IL', () => {
    // 15 days: token A alternates ±10% daily, token B pinned at 1
    const a: number[] = [100];
    for (let i = 0; i < 14; i++) a.push(a[a.length - 1] * (i % 2 === 0 ? 1.1 : 0.9));
    const risk = pairRiskFromSeries(series(a), series(Array(15).fill(1)))!;
    expect(risk).not.toBeNull();
    expect(risk.samples).toBe(14);
    expect(risk.dailyVolB).toBe(0);
    expect(risk.dailyVolA).toBeGreaterThan(0.09); // ~ln(1.1)≈0.095 daily swing
    expect(risk.relAnnualVol).toBeCloseTo(annualizeVol(risk.dailyVolA), 10);
    expect(risk.estimatedIlPct).toBeLessThan(-20); // big vol → big expected IL
    expect(risk.estimatedIlPct).toBeGreaterThanOrEqual(-95);
  });

  test('two tokens moving in lockstep have ~0 relative vol and ~0 IL', () => {
    const a: number[] = [100];
    for (let i = 0; i < 14; i++) a.push(a[a.length - 1] * (i % 2 === 0 ? 1.08 : 0.94));
    const b = a.map((x) => x * 3); // same returns, different level
    const risk = pairRiskFromSeries(series(a), series(b))!;
    expect(risk.correlation).toBeCloseTo(1, 5);
    expect(risk.relAnnualVol).toBeCloseTo(0, 5);
    expect(risk.estimatedIlPct).toBeCloseTo(0, 3);
  });
});

describe('fetchDailyCloses', () => {
  const okPayload = { s: 'ok', t: [1, 2, 3].map((i) => 1_784_000_000 + i * DAY), c: [1, 2, 3] };

  function fetchStub(payload: unknown, opts: { ok?: boolean } = {}): { fn: FetchLike; calls: () => number } {
    let n = 0;
    return {
      fn: async () => ((n++), { ok: opts.ok ?? true, json: async () => payload }),
      calls: () => n,
    };
  }

  test('parses a UDF ok payload', async () => {
    const stub = fetchStub(okPayload);
    const s = await fetchDailyCloses('resource_rdx1ta', 30, stub.fn);
    expect(s).toEqual({ t: okPayload.t, c: [1, 2, 3] });
  });

  test('caches per token (success AND failure)', async () => {
    const ok = fetchStub(okPayload);
    await fetchDailyCloses('resource_rdx1ta', 30, ok.fn);
    await fetchDailyCloses('resource_rdx1ta', 30, ok.fn);
    expect(ok.calls()).toBe(1);

    const bad = fetchStub({ s: 'error' });
    expect(await fetchDailyCloses('resource_rdx1tb', 30, bad.fn)).toBeNull();
    expect(await fetchDailyCloses('resource_rdx1tb', 30, bad.fn)).toBeNull();
    expect(bad.calls()).toBe(1); // negative result cached too — no hammering a down API
  });

  test('null on HTTP failure, mismatched arrays, or a throwing fetch', async () => {
    expect(await fetchDailyCloses('resource_rdx1tc', 30, fetchStub(okPayload, { ok: false }).fn)).toBeNull();
    expect(
      await fetchDailyCloses('resource_rdx1td', 30, fetchStub({ s: 'ok', t: [1, 2], c: [1] }).fn),
    ).toBeNull();
    expect(
      await fetchDailyCloses('resource_rdx1te', 30, (async () => {
        throw new Error('down');
      }) as unknown as FetchLike),
    ).toBeNull();
  });
});
